/**
 * The dashboard serves every group's sessions, messages and the host log, so
 * its server (the @nanoco/nanoclaw-dashboard package, hardened by
 * patches/@nanoco__nanoclaw-dashboard@0.3.0.patch) must give nothing to a
 * caller that has not shown DASHBOARD_SECRET: as a Bearer token (the pusher,
 * API clients) or once at the login form, for a session cookie (the browser).
 * No response may carry the secret.
 *
 * Binding loopback does not stop agents on its own: Docker Desktop forwards
 * host.docker.internal to the host's 127.0.0.1, and the server sees 127.0.0.1
 * as the peer, so an agent container looks like a local browser.
 *
 * Runs against the installed package, so it also fails if the patch stops
 * applying (for example after a version bump).
 */
import http from 'http';
import net from 'net';
import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDashboard, stopDashboard } from '@nanoco/nanoclaw-dashboard';

import { allocateFreePort } from './test-utils/free-port.js';

const SECRET = 'nc-0123456789abcdef0123456789abcdef';
const BEARER = { authorization: `Bearer ${SECRET}` };
/** Appears only inside the pushed snapshot: seeing it means data was served. */
const MARKER = 'dashboard-test-marker-message';

const SNAPSHOT = {
  timestamp: '2026-09-30T12:00:00.000Z',
  assistant_name: 'TestBot',
  uptime: 60,
  agent_groups: [
    {
      id: 'ag-1',
      name: 'Ads',
      folder: 'ads',
      agent_provider: 'claude',
      container_config: { mcpServers: { linkedin: { command: 'node' } }, packages: { apt: [], npm: [] } },
      sessionCount: 1,
      runningSessions: 0,
      wirings: [
        {
          channel_type: 'telegram',
          platform_id: 'telegram:-100',
          mg_name: 'Ads room',
          is_group: 1,
          unknown_sender_policy: 'strict',
          priority: 0,
        },
      ],
      destinations: [{ local_name: 'ads', target_type: 'channel', target_id: 'mg-1' }],
      members: [],
      admins: [
        {
          user_id: 'telegram:1',
          display_name: 'Owner',
          role: 'owner',
          agent_group_id: null,
          granted_at: '2026-09-01T00:00:00.000Z',
        },
      ],
      created_at: '2026-09-01T00:00:00.000Z',
    },
  ],
  sessions: [
    {
      id: 'sess-1',
      agent_group_id: 'ag-1',
      agent_group_name: 'Ads',
      status: 'active',
      container_status: 'stopped',
      created_at: '2026-09-01T00:00:00.000Z',
    },
  ],
  channels: [{ channelType: 'telegram', isLive: true, isRegistered: true, groups: [] }],
  users: [
    {
      id: 'telegram:1',
      kind: 'telegram',
      display_name: 'Owner',
      privilege: 'owner',
      roles: [],
      memberships: [],
      dmChannels: [],
      created_at: '2026-09-01T00:00:00.000Z',
    },
  ],
  tokens: {
    totals: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    byModel: {},
    byGroup: {},
  },
  context_windows: [],
  activity: [{ hour: '2026-09-30T11', inbound: 1, outbound: 0 }],
  messages: [
    {
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      inbound: [
        { seq: 2, kind: 'chat', timestamp: '2026-09-30T11:59:00.000Z', content: JSON.stringify({ text: MARKER }) },
      ],
      outbound: [],
    },
  ],
};

const PAGES = [
  '/dashboard',
  '/dashboard/agent-groups?id=ag-1',
  '/dashboard/sessions',
  '/dashboard/channels',
  '/dashboard/messages?agentGroupId=ag-1&sessionId=sess-1',
  '/dashboard/users',
  '/dashboard/logs',
];

const API_READS = [
  '/api/status',
  '/api/overview',
  '/api/activity',
  '/api/agent-groups',
  '/api/agent-groups/ag-1',
  '/api/sessions',
  '/api/channels',
  '/api/messages?agentGroupId=ag-1&sessionId=sess-1',
  '/api/users',
  '/api/tokens/summary',
  '/api/context',
  '/api/logs',
];

let port: number;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Req {
  method?: string;
  path: string;
  headers?: http.OutgoingHttpHeaders;
  body?: string;
}

/**
 * One request on a fresh connection, so a restarted server never meets a
 * pooled socket. A request the server never answers fails instead of hanging.
 */
function send({ method = 'GET', path, headers = {}, body }: Req): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.setTimeout(2000, () => req.destroy(new Error(`no reply to ${method} ${path}`)));
    req.on('error', reject);
    req.end(body);
  });
}

function sendJson(path: string, headers: http.OutgoingHttpHeaders, payload: unknown): Promise<Reply> {
  return send({
    method: 'POST',
    path,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function login(secret = SECRET): Promise<Reply> {
  const body = new URLSearchParams({ secret }).toString();
  return send({
    method: 'POST',
    path: '/dashboard/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

/** The `name=value` pair a successful login set, as a browser would send it back. */
function sessionCookie(reply: Reply): string {
  const set = reply.headers['set-cookie'] ?? [];
  expect(set, 'login sets exactly one cookie').toHaveLength(1);
  return set[0].split(';')[0];
}

function isRedirectToLogin(reply: Reply): boolean {
  return reply.status >= 300 && reply.status < 400 && reply.headers.location === '/dashboard/login';
}

/** Open the log stream and resolve with what arrived once `expected` shows up. */
function readStream(headers: http.OutgoingHttpHeaders, expected: string): Promise<{ reply: Reply }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/logs', headers, agent: false }, (res) => {
      let data = '';
      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`stream never carried ${expected}; got: ${data}`));
      }, 2000);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.includes(expected)) {
          clearTimeout(timer);
          req.destroy();
          resolve({ reply: { status: res.statusCode ?? 0, headers: res.headers, body: data } });
        }
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ reply: { status: res.statusCode ?? 0, headers: res.headers, body: data } });
      });
    });
    // Destroying the request after the match settles the promise first; a late error is moot.
    req.on('error', reject);
    req.end();
  });
}

async function waitForListener(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const up = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (up) return;
    if (attempt >= 40) throw new Error(`dashboard never listened on ${port}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A non-loopback IPv4 address of this machine (a LAN device would connect to it), if any. */
function networkAddress(): string | undefined {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (name.startsWith('utun')) continue;
    const found = addrs?.find((a) => a.family === 'IPv4' && !a.internal);
    if (found) return found.address;
  }
  return undefined;
}

beforeEach(async () => {
  port = await allocateFreePort();
  startDashboard({ port, secret: SECRET });
  await waitForListener();
  const seeded = await sendJson('/api/ingest', BEARER, SNAPSHOT);
  expect(seeded.status).toBe(200);
});

afterEach(async () => {
  vi.useRealTimers();
  await stopDashboard();
});

describe('a caller without the secret', () => {
  it('is sent from every page to the login form, and never sees the secret', async () => {
    for (const path of ['/', ...PAGES]) {
      const reply = await send({ path });
      expect({ path, redirected: isRedirectToLogin(reply) }).toEqual({ path, redirected: true });
      expect(reply.body).not.toContain(SECRET);
    }
  });

  it('gets no data from any API route, with no token or a wrong one', async () => {
    const wrong = [
      {},
      { authorization: 'Bearer nc-not-the-secret' },
      { authorization: `Bearer ${SECRET.slice(0, -1)}` },
    ];
    for (const path of API_READS) {
      for (const headers of wrong) {
        const reply = await send({ path, headers });
        expect({ path, status: reply.status }).toEqual({ path, status: 401 });
        expect(reply.body).not.toContain(MARKER);
        expect(reply.body).not.toContain(SECRET);
      }
    }
  });

  it('gets a login form that does not carry the secret', async () => {
    const reply = await send({ path: '/dashboard/login' });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^text\/html/);
    expect(reply.body).toMatch(/<form[^>]*method="post"/i);
    expect(reply.body).toMatch(/type="password"/);
    expect(reply.body).not.toContain(SECRET);
  });

  it('gets no session for a wrong secret', async () => {
    for (const guess of ['nc-not-the-secret', '', SECRET.slice(0, -1), `${SECRET}x`]) {
      const reply = await login(guess);
      expect({ guess, status: reply.status }).toEqual({ guess, status: 401 });
      expect(reply.headers['set-cookie']).toBeUndefined();
      expect(reply.body).not.toContain(SECRET);
    }
  });

  it('cannot make the server keep an oversized login body', async () => {
    const reply = await login(SECRET + 'x'.repeat(64 * 1024));
    expect(reply.status).toBe(413);
    expect(reply.headers['set-cookie']).toBeUndefined();
  });
});

describe('a browser that logged in', () => {
  it('holds an HttpOnly, SameSite=Strict, persistent session cookie that is not the secret', async () => {
    const reply = await login();
    expect(reply.status).toBeGreaterThanOrEqual(300);
    expect(reply.status).toBeLessThan(400);
    expect(reply.headers.location).toBe('/dashboard');
    const [cookie] = reply.headers['set-cookie'] ?? [''];
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Strict/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).toMatch(/;\s*Max-Age=[1-9]\d*/i);
    expect(cookie.split(';')[0]).not.toContain(SECRET);
  });

  it('opens every page, and no page carries the secret', async () => {
    const cookie = sessionCookie(await login());
    for (const path of PAGES) {
      const reply = await send({ path, headers: { cookie } });
      expect({ path, status: reply.status }).toEqual({ path, status: 200 });
      expect(reply.body).not.toContain(SECRET);
    }
  });

  it('reads the snapshot through the API', async () => {
    const cookie = sessionCookie(await login());
    const reply = await send({ path: '/api/messages?agentGroupId=ag-1&sessionId=sess-1', headers: { cookie } });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain(MARKER);
  });

  it('streams the host log', async () => {
    const cookie = sessionCookie(await login());
    const pushed = await sendJson('/api/logs/push', BEARER, { lines: ['log line for the stream test'] });
    expect(pushed.status).toBe(200);
    const { reply } = await readStream({ cookie }, 'log line for the stream test');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/^text\/event-stream/);
  });

  it('cannot replace the snapshot or push log lines with the cookie alone', async () => {
    const cookie = sessionCookie(await login());
    expect((await sendJson('/api/ingest', { cookie }, { ...SNAPSHOT, messages: [] })).status).toBe(401);
    expect((await sendJson('/api/logs/push', { cookie }, { lines: ['forged line'] })).status).toBe(401);
    const still = await send({ path: '/api/messages?agentGroupId=ag-1&sessionId=sess-1', headers: { cookie } });
    expect(still.body).toContain(MARKER);
  });

  it('gets nothing with a tampered cookie', async () => {
    const cookie = sessionCookie(await login());
    const at = cookie.indexOf('=') + Math.floor((cookie.length - cookie.indexOf('=')) / 2);
    const tampered = cookie.slice(0, at) + (cookie[at] === 'A' ? 'B' : 'A') + cookie.slice(at + 1);
    expect(isRedirectToLogin(await send({ path: '/dashboard', headers: { cookie: tampered } }))).toBe(true);
    expect((await send({ path: '/api/overview', headers: { cookie: tampered } })).status).toBe(401);
  });

  it('keeps the session for its advertised lifetime and no longer', async () => {
    const start = Date.parse('2026-09-30T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start);
    const reply = await login();
    const cookie = sessionCookie(reply);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(reply.headers['set-cookie']?.[0] ?? '')?.[1]);

    vi.setSystemTime(start + (maxAge - 60) * 1000);
    expect((await send({ path: '/dashboard', headers: { cookie } })).status).toBe(200);

    vi.setSystemTime(start + (maxAge + 60) * 1000);
    expect(isRedirectToLogin(await send({ path: '/dashboard', headers: { cookie } }))).toBe(true);
  });

  it('loses the session when the secret is rotated', async () => {
    const cookie = sessionCookie(await login());
    await stopDashboard();
    startDashboard({ port, secret: 'nc-rotated0123456789abcdef01234567' });
    await waitForListener();
    expect(isRedirectToLogin(await send({ path: '/dashboard', headers: { cookie } }))).toBe(true);
  });

  it('gets pages that cannot be framed and data that is not cached', async () => {
    const cookie = sessionCookie(await login());
    expect((await send({ path: '/dashboard', headers: { cookie } })).headers['x-frame-options']).toBe('DENY');
    expect((await send({ path: '/api/overview', headers: { cookie } })).headers['cache-control']).toBe('no-store');
  });
});

describe('where the dashboard answers', () => {
  it('refuses requests that name another host, whatever they carry', async () => {
    const cookie = sessionCookie(await login());
    const attempts: Array<[string, http.OutgoingHttpHeaders]> = [
      ['/dashboard/login', {}],
      ['/dashboard', { cookie }],
      ['/api/messages?agentGroupId=ag-1&sessionId=sess-1', BEARER],
    ];
    for (const host of [`host.docker.internal:${port}`, `attacker.example:${port}`]) {
      for (const [path, headers] of attempts) {
        const reply = await send({ path, headers: { ...headers, host } });
        expect({ host, path, refused: reply.status >= 400 && reply.status < 500 }).toEqual({
          host,
          path,
          refused: true,
        });
        expect(reply.body).not.toContain(MARKER);
        expect(reply.body).not.toContain(SECRET);
      }
    }
  });

  it('answers the loopback names', async () => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      expect({ host, status: (await send({ path: '/dashboard/login', headers: { host } })).status }).toEqual({
        host,
        status: 200,
      });
    }
  });

  it('answers a malformed request target instead of leaving it hanging', async () => {
    const reply = await send({ path: '//', headers: BEARER });
    expect(reply.status).toBe(400);
    expect(reply.body).not.toContain(MARKER);
  });

  it('lets no other origin read a response', async () => {
    const origin = 'https://attacker.example';
    const page = await send({ path: '/dashboard/login', headers: { origin } });
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await send({
      method: 'OPTIONS',
      path: '/api/messages',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
  });

  it.skipIf(!networkAddress())('is not reachable on a network address', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = net.connect({ port, host: networkAddress()!, timeout: 1000 }, () => {
        socket.destroy();
        resolve('connected');
      });
      socket.on('timeout', () => {
        socket.destroy();
        resolve('timeout');
      });
      socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(outcome).toBe('ECONNREFUSED');
  });
});
