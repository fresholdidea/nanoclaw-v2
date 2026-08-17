/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { migrateLegacyTaskSeries } from './modules/scheduling/migrate-legacy.js';
import { startHostModules, stopHostModules } from './host-lifecycle.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { readEnvFile } from './env.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';

// Response registry lives in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler at top level — which
// would hit a TDZ error if the array lived here.
import { getResponseHandlers, type ResponsePayload } from './response-registry.js';

const hostAbortController = new AbortController();

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 2b. Move legacy task series (living in chat/system sessions, where
  // group-scoped `ncl tasks` can't see them) into per-series task sessions.
  // Idempotent. Ordering is load-bearing: after cleanupOrphans (no leftover
  // container can fire a due row mid-move) and before adapters, delivery
  // polls, and the sweep (nothing else touches session DBs during the move).
  await migrateLegacyTaskSeries();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          // The one host-side stamping seam: adapters stay instance-blind,
          // the host stamps the receiving instance on every inbound event.
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. See
  // createChannelDeliveryAdapter in channels/channel-registry.ts.
  setDeliveryAdapter(createChannelDeliveryAdapter());

  // 5. Start registered host modules. Imports only registered callbacks; the
  // actual work begins here, after DB + delivery are ready and before polls.
  await startHostModules({ db, signal: hostAbortController.signal });

  // 6. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 7. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7a. Dashboard (optional)
  const dashboardEnv = readEnvFile(['DASHBOARD_SECRET', 'DASHBOARD_PORT']);
  const dashboardSecret = process.env.DASHBOARD_SECRET || dashboardEnv.DASHBOARD_SECRET;
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || dashboardEnv.DASHBOARD_PORT || '3100', 10);
  if (dashboardSecret) {
    try {
      const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
      const { startDashboardPusher } = await import('./dashboard-pusher.js');
      startDashboard({ port: dashboardPort, secret: dashboardSecret });
      startDashboardPusher({ port: dashboardPort, secret: dashboardSecret, intervalMs: 60000 });
    } catch (err) {
      log.error('Failed to start dashboard', { err });
    }
  } else {
    log.info('Dashboard disabled (no DASHBOARD_SECRET)');
  }

  // 7b. mnemon sync — snapshot refresh + container write-queue replay.
  // No-ops (with a log line) when no ~/.mnemon store exists.
  try {
    const { startMnemonSync } = await import('./mnemon-sync.js');
    startMnemonSync();
  } catch (err) {
    log.error('Failed to start mnemon sync', { err });
  }

  // 8. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  // Dashboard and mnemon sync start after startHostModules(), so they stop
  // first — same LIFO rule stopHostModules() applies to its own registrants.
  try {
    const { stopDashboardPusher } = await import('./dashboard-pusher.js');
    stopDashboardPusher();
  } catch {
    /* ignore if not started or not installed */
  }
  try {
    const { stopMnemonSync } = await import('./mnemon-sync.js');
    stopMnemonSync();
  } catch {
    /* ignore if not started */
  }
  hostAbortController.abort();
  await stopHostModules();
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
