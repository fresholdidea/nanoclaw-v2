/**
 * Agent-to-agent guard adapter — the module's catalog entries, composed at
 * the module edge (imported by ./index.ts).
 *
 * agents.create — the cli_scope branch moved verbatim out of
 * create-agent.ts: `global` scope creates directly (create_agent is the
 * intended primitive for trusted owner agent groups); anything else — the
 * default `group` scope, and unknown/missing config, fail-closed — holds for
 * the requesting group's admin chain.
 *
 * a2a.send — a self-route (source group == target group) denies first; then a
 * missing destination row denies; a missing target group denies; an
 * agent_message_policies row for the (from, to) pair holds for the row's
 * named approver. The ghost-policy edge (policy row with no destination row)
 * denies — the destination check precedes the policy check. Policy rows can
 * only tighten (hold), never allow: absence of a row falls through to the
 * structural checks.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import { hasDestination } from './db/agent-destinations.js';
import { getMessagePolicy } from './db/agent-message-policies.js';

/**
 * pending_approvals action string for held a2a messages. Lives here (not in
 * agent-route.ts) so agent-route can import this adapter — loading the
 * consult site guarantees its catalog entry is registered — without a cycle.
 */
export const A2A_MESSAGE_GATE_ACTION = 'a2a_message_gate';

export const agentsCreate = defineGuardedAction({
  action: 'agents.create',
  grantActionName: 'create_agent',
  // Bind a create_agent grant to the name that was approved.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { name?: string }).name === input.payload.name;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('create_agent is a container-originated action.');
    const cliScope = getContainerConfig(input.actor.agentGroupId)?.cli_scope ?? 'group';
    if (cliScope === 'global') {
      // Trusted owner agent group — an approval tap on every sub-agent spawn
      // would be needless friction.
      return ALLOW('trusted global-scope agent group');
    }
    // The realistic prompt-injection victim (default `group` scope) — and any
    // unknown config value, fail-closed — requires an admin before any
    // central-DB write.
    return HOLD('agent-initiated create_agent requires admin approval');
  },
});

export const a2aSend = defineGuardedAction({
  action: 'a2a.send',
  grantActionName: A2A_MESSAGE_GATE_ACTION,
  // Bind an a2a grant to the exact held message target.
  grantCoversRequest: (grant, input) => {
    try {
      return (JSON.parse(grant.payload) as { platform_id?: string }).platform_id === input.resource?.to;
    } catch {
      return false;
    }
  },
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('agent-to-agent send requires an agent actor');
    const from = input.actor.agentGroupId;
    const to = input.resource?.to ?? '';
    // Self-route deny — the loop breaker. Checked first so no later branch
    // (destination ACL, policy hold) can reach a self-addressed message.
    //
    // A self-route has no legitimate producer: every host-side "note to self"
    // (approval follow-ups in approvals/finalize.ts + primitive.ts, restart
    // notes in container-restart.ts, self-mod apply notes) is written straight
    // into the group's own inbound.db via writeSessionMessage and never
    // travels through delivery. What does reach here is the container echoing
    // an inbound's routing back onto an outbound row: `platform_id` means the
    // *source* group on an inbound a2a row but the *target* group on an
    // outbound one, so reflecting a self-addressed system note's routing
    // produces a message addressed to the emitting group. Routing it writes it
    // into the same session and wakes the container, which reproduces it —
    // self-feeding forever (observed: reviewer-1 on provider=codex, 401 on
    // every turn, 108 messages in 4 minutes).
    //
    // An earlier fix (63746df) allowed self-sends to stop those system notes
    // being dropped — but they never passed through this code path, so the
    // allowance only ever admitted the loop.
    if (to === from) {
      return DENY(`self-route refused: ${from} cannot route an agent message to itself`);
    }
    if (!hasDestination(from, 'agent', to)) {
      return DENY(`unauthorized agent-to-agent: ${from} has no destination for ${to}`);
    }
    if (!getAgentGroup(to)) {
      return DENY(`target agent group ${to} not found for message ${String(input.payload.id)}`);
    }
    const policy = getMessagePolicy(from, to);
    if (policy) {
      return HOLD(`a2a message policy ${from}→${to} holds for ${policy.approver}`, policy.approver);
    }
    return ALLOW('destination grant exists');
  },
});
