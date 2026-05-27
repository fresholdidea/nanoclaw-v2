/**
 * One-shot: create the Cache agent group.
 *
 * - Inserts `agent_groups` row (id=ag-1779138549391-cache6, folder=cache)
 * - Builds `container_configs` row by reading ads' existing MCP envs (Google
 *   developer token, Meta credentials, LinkedIn credentials, etc.) and
 *   hard-coding Cache's GOOGLE_ADS_CUSTOMER_ID for read-scoping. PostHog is
 *   stubbed with a REPLACE_ME placeholder until Brad re-auths.
 *
 * Idempotent: skips if the row already exists.
 */
import Database from 'better-sqlite3';

const DB_PATH = 'data/v2.db';
const ADS_ID = 'ag-1777521678769-obgxhn';
const CACHE_ID = 'ag-1779138549391-cache6';

const db = new Database(DB_PATH);

const existing = db.prepare('SELECT id FROM agent_groups WHERE id = ?').get(CACHE_ID);
if (existing) {
  console.log(`Cache group already exists: ${CACHE_ID}`);
  process.exit(0);
}

const adsConfig = db
  .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
  .get(ADS_ID) as { mcp_servers: string } | undefined;
if (!adsConfig) throw new Error('Ads container_config row missing — cannot inherit MCP envs');

const adsMcp = JSON.parse(adsConfig.mcp_servers) as Record<string, { command: string; args: string[]; env?: Record<string, string> }>;

// Cache MCP servers: base 3 (Google/Meta/LinkedIn) with shared user-account
// tokens from ads, plus a Cache-scoped googleAdsServer customer ID, plus
// posthog stub.
const cacheMcp = {
  googleAdsServer: {
    ...adsMcp.googleAdsServer,
    env: {
      ...adsMcp.googleAdsServer.env,
      GOOGLE_ADS_CUSTOMER_ID: '4004081947',
    },
  },
  metaAds: { ...adsMcp.metaAds },
  linkedinAds: { ...adsMcp.linkedinAds },
  posthog: {
    command: 'npx',
    args: ['-y', 'posthog-mcp'],
    env: {
      POSTHOG_PERSONAL_API_KEY: 'REPLACE_ME_AFTER_REAUTH',
      POSTHOG_HOST: 'https://us.posthog.com',
    },
  },
};

const additionalMounts = [
  {
    hostPath: '/Users/bradhess/Documents/GitHub/super-productivity/projects/cache-financials',
    containerPath: 'cache',
    readonly: false,
  },
  {
    hostPath: '/Users/bradhess/.config/gws-cache',
    containerPath: 'gws-config',
    readonly: true,
  },
  {
    hostPath: '/Users/bradhess/Documents/GitHub/mcp-google-ads',
    containerPath: 'mcp-google-ads',
    readonly: false,
  },
  {
    hostPath: '/Users/bradhess/Documents/GitHub/linkedin-ads-mcp',
    containerPath: 'mcp-linkedin-ads',
    readonly: false,
  },
  {
    hostPath: '/Users/bradhess/.linkedin-ads-mcp',
    containerPath: 'linkedin-ads-tokens',
    readonly: false,
  },
];

const now = new Date().toISOString();

db.transaction(() => {
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES (?, ?, ?, NULL, ?)`,
  ).run(CACHE_ID, 'Cache', 'cache', now);

  db.prepare(
    `INSERT INTO container_configs (
       agent_group_id, provider, model, effort, image_tag, assistant_name,
       max_messages_per_prompt, skills, mcp_servers, packages_apt, packages_npm,
       additional_mounts, cli_scope, updated_at
     ) VALUES (?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, 'group', ?)`,
  ).run(
    CACHE_ID,
    'nanoclaw-agent:latest',
    'Cache',
    JSON.stringify('all'),
    JSON.stringify(cacheMcp),
    JSON.stringify([]),
    JSON.stringify(['@googleworkspace/cli']),
    JSON.stringify(additionalMounts),
    now,
  );
})();

console.log(`Created Cache agent group ${CACHE_ID} (folder=cache)`);
console.log(`MCPs: ${Object.keys(cacheMcp).join(', ')}`);
console.log(`Mounts: ${additionalMounts.length} (cache RW, gws-config RO, 3 MCP source dirs)`);
