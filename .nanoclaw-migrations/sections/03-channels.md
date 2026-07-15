# §03 — Customization: channel adapters

**Intent:** Three adapters installed from `origin/channels` (absent from trunk), then customized: Telegram (multi-bot), WhatsApp (Baileys v7, dedicated-number), Slack (webhook-only).

| Channel | Install | `src/channels/` files |
|---------|---------|-----------------------|
| Telegram | `/add-telegram` → refactor for multi-bot (`1e1a972`) | `telegram.ts`, `telegram-pairing.ts`, `telegram-markdown-sanitize.ts` |
| WhatsApp | `/add-whatsapp` → Baileys v7 refresh (`da7a16c`) | `whatsapp.ts` |
| Slack | `/add-slack` | `slack.ts` |

**Barrel** (`src/channels/index.ts`, after `import './cli.js';`):
```typescript
import './telegram.js';
import './whatsapp.js';
import './slack.js';
```

## Telegram — multi-bot (`1e1a972`)
Stock registered one bot under `channel_type='telegram'`. Fork factors into `registerTelegramBot(channelType, tokenEnvVar)` + a data-driven loop over `.env`:
```typescript
function registerTelegramBot(channelType: string, tokenEnvVar: string): void {
  registerChannelAdapter(channelType, {
    factory: () => {
      const wrapped: ChannelAdapter = {
        ...bridge,
        // chat-sdk-bridge defaults name/channelType to 'telegram'; both bots
        // would collide under one registry key. Pin to the registration name.
        name: channelType,
        channelType,
        // ...
      };
      return wrapped;
    },
  });
}
registerTelegramBot('telegram', 'TELEGRAM_BOT_TOKEN');           // default (Zed)
for (const key of Object.keys(readEnvKeysWithPrefix('TELEGRAM_BOT_TOKEN_'))) {
  const suffix = key.slice('TELEGRAM_BOT_TOKEN_'.length).toLowerCase();
  if (!suffix) continue;
  registerTelegramBot(`telegram-${suffix}`, key);               // e.g. telegram-opencode (@JBH_OC_Bot)
}
```
`telegram-pairing.ts` + `telegram-markdown-sanitize.ts` are stock (no delta).

### `src/env.ts` — `readEnvKeysWithPrefix` (verbatim)
```typescript
export function readEnvKeysWithPrefix(prefix: string): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try { content = fs.readFileSync(envFile, 'utf-8'); }
  catch (err) { log.debug('.env file not found, using defaults', { err }); return {}; }
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!key.startsWith(prefix)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    if (value) result[key] = value;
  }
  return result;
}
```

## WhatsApp — Baileys v7, dedicated-number (`da7a16c`)
Stock has a shared-vs-dedicated abstraction; fork **dropped the shared-number path entirely** (dedicated bot number, `ASSISTANT_HAS_OWN_NUMBER=true`). Removed: `resolveSharedMode()`, `computeWhatsappDefaults()`, `rewriteBotLidMention()`, `appendMediaFailureNote()`, `WHATSAPP_SHARED`, `WHATSAPP_DEFAULTS`, `sharedModeLoggedChats`, `ChannelDefaults` import + `defaults:` field. Simplified: `computeIsMention(isGroup, botMentionedInGroup)`; `ASSISTANT_NAME`/`ASSISTANT_HAS_OWN_NUMBER` from `../config.js`; inline LID rewrite `content.replace(\`@${botLidUser}\`, \`@${ASSISTANT_NAME}\`)`; `downloadInboundMedia` returns attachments array; `isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? false : content.startsWith(...)`; `prefixed = ASSISTANT_HAS_OWN_NUMBER ? formatted : \`${ASSISTANT_NAME}: ${formatted}\``.

**v7 LID handling** (3 strategies): local `lidToPhoneMap` cache → `remoteJidAlt`/`participantAlt` from `extractAddressingContext` → `sock.signalRepository.lidMapping.getPNForLID(jid)`. `lid-mapping.update` event updates cache; bot's own LID stored in `botLidUser`.

**WA Web version resolver** (avoids Baileys' rate-limited `fetchLatestWaWebVersion` → 405):
```typescript
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', { signal: AbortSignal.timeout(5000) });
    if (res.ok) { const m = (await res.text()).match(/2\.3000\.(\d+)/); if (m) return [2, 3000, Number(m[1])]; }
  } catch { /* fall through */ }
  try { const { version } = await fetchLatestWaWebVersion({}); if (version) return version as [number,number,number]; } catch { /* */ }
  throw new Error('Could not fetch current WhatsApp Web version...');
}
```
`proto` is a named ESM import — the v6 `createRequire` `getPlatformId` patch is **gone** (fixed natively in v7). `isSafeAttachmentName` imported from `../attachment-safety.js`.

## Slack — webhook-only
Stock Socket Mode path **stripped**: drops `SLACK_APP_TOKEN`, `useSocketMode`, `mode`, `ChannelDefaults`/`SLACK_DEFAULTS`, `defaults:`. Retains `bridge.resolveChannelName = async ...` (safe — trunk `ChannelAdapter` declares `resolveChannelName?` at `adapter.ts:138`).

## Setup files
- `setup/whatsapp-auth.ts` — forked; replaced v6 `getPlatformId` `createRequire` patch with `resolveWaWebVersion()`. Otherwise stock (QR + pairing-code, writes `store/pairing-code.txt`).
- `setup/groups.ts` — new from `origin/channels`, not customized. WhatsApp group metadata sync via `sock.groupFetchAllParticipating()`; reads `store/messages.db`; `--list` flag for pipe-separated output.
- `src/channels/cli.ts` — trivial `catch (err)` → `catch` cleanup only.

## Gotchas
1. **Multi-bot Telegram — `name` + `channelType` MUST be pinned** on the wrapped bridge or the second bot clobbers the first (MEMORY `multi_bot_channeltype_collision`).
2. **`TELEGRAM_BOT_TOKEN_<SUFFIX>`** read from `.env` file (not `process.env`); `channel_type = telegram-<suffix-lowercased>`.
3. **`src/attachment-safety.ts` must be copied separately** from `origin/channels` — NOT bundled by `/add-whatsapp` (MEMORY `add_whatsapp_skill_drift`).
4. Shared-number WhatsApp + Slack Socket Mode are intentionally removed; restore from `origin/channels` only if needed.
5. `setup/groups.ts` reads `store/messages.db` (Baileys store), not `data/v2.db`.
