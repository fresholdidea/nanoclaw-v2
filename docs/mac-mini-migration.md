# Moving the NanoClaw host from the MacBook Pro to the Mac Mini

Status: **on hold, because the current Mini is too small** (checked 2026-11-10). The plan below assumes a Mini with 32 GB or more.

> **Hardware check result:** the Mini is a `Mac14,3` (M2, 2023) with **8 GB** of RAM. That can't host NanoClaw:
>
> - Each agent image is about 4 GB.
> - The Docker VM alone needs 8 to 12 GB.
> - Hermes already runs on the Mini.
>
> The MacBook (24 GB) already swaps under this load. Options, in order:
>
> 1. **Stay on the MacBook and lighten it:** reclaim disk, try OrbStack, cap the Docker VM at 8 to 10 GB and 6 to 8 CPUs.
> 2. **Replace the Mini** with one that has 32 GB or more, then follow this plan unchanged.
> 3. **VPS:** still not recommended, for the reasons below.
>
> Mac RAM can't be upgraded, so the current Mini stays a Hermes-only box.

## Why

The MacBook Pro (Mac16,8, 24 GB) is a bad always-on host:

- It sleeps, travels and closes its lid. Slack socket-mode logs a missed pong about every 5 minutes.
- It shares memory with Brad's own work. In October Docker Desktop crashed twice after host swap thrash (21 of 22.5 GB swap in use).
- Its data volume is 96% full.

The Mini is already always on and runs Hermes. A VPS was considered and rejected:

- NanoClaw bind-mounts local trees (Obsidian, super-productivity, `~/.config/gws*`, `~/.mnemon`, ad-metrics).
- It depends on macOS-only tools (Shadow, the `agy` Gemini broker sign-in, launchd jobs).
- It would put client data and credential stores on third-party hardware.

## 0. Before deciding

- [ ] **Mini RAM.** Run `sysctl -n hw.memsize hw.model` on the Mini.
  - Today's load is 23 agent groups, peaks of several concurrent containers at about 4 GB images, the OneCLI stack, and Hermes beside it.
  - 32 GB or more is comfortable. 24 GB works if Docker gets at most 12 GB and 6–8 CPUs. Under 24 GB, stop and reconsider.
- [ ] **Mini disk.** Allow at least 80 GB free for Docker (images, build cache) plus `data/` and `groups/`.
- [ ] **Same user and path.** The install slug is `sha1(<absolute project root>)[:8]` (`src/install-slug.ts`).
  - Clone to `/Users/bradhess/Documents/GitHub/nanoclaw-v2` on the Mini. The user is `bradhess` there too, so the slug stays `edb15411`.
  - The image names (`nanoclaw-agent-v2-edb15411:*`), container labels and OneCLI agent identities then carry over.
  - If the path ever has to differ, set `NANOCLAW_INSTALL_ID=edb15411` in `.env` instead.
- [ ] **macOS privacy (TCC).** launchd jobs under `~/Documents` need Full Disk Access for `~/.local/bin/node`, and for Docker if it is used. sshd cannot read `~/Documents` on the Mini, so the copy steps below either run from a logged-in session there or go through a non-Documents staging folder.

## 1. Prepare the Mini (MacBook stays live)

1. **Node.** Install Node 22 at `~/.local/bin/node`. The host is pinned to 22 (better-sqlite3 ABI); never point launchd at Homebrew node.
2. **Docker.** Choose Docker Desktop or OrbStack (see §6).
   - Docker Desktop: limit the VM to 6–8 CPUs and 10–12 GB.
3. **Code.** Clone the repo to the same path and check out the same `main` commit as the MacBook.
4. **Build.**

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   ./container/build.sh
   pnpm exec tsx scripts/rebuild-agent-image.ts   # per-agent images
   ```

5. **Leave the old job disabled.** The Mini's `com.nanoclaw-v2-edb15411` job stays disabled; the MacBook's label is `com.nanoclaw`. Pick one label for the Mini and install that plist later in §3. Never let two jobs exist on the Mini.
6. **OneCLI.** Install the same version as the MacBook, 1.45.0. Never go below 1.43.1. Also set up the Caddy shim (`onecli-shim`, `:10254`, `ONECLI_API_KEY`) and the egress forwarder (`~/.onecli/egress-fwd`).
   - Do **not** start the gateway against a copy of the vault yet. See §3.

## 2. What moves

| Item | Where | How |
|---|---|---|
| Central DB and session DBs | `data/` (v2.db, per-session dirs, `data/onecli/provider-credentials.json`) | Copy with the host **stopped**. Never copy a live WAL database. |
| Group folders | `groups/` (memory, skills, CLAUDE.local.md / AGENTS.md sources) | rsync with the host stopped |
| Host env | `.env` | Copy by hand. Never paste values into chat or logs. |
| OneCLI vault and gateway | `~/.onecli/`, the onecli containers and their volumes | Stop the MacBook gateway, then move the data volume (`docker run --rm -v <vol>:/v alpine tar`), compose files, the shim and egress-fwd |
| Google Workspace OAuth | `~/.config/gws`, `gws-falcone`, `gws-cache`, `gws-meadow`, `gws-agency` | Copy, then on the Mini run `~/.config/gws/sync-account.sh --resync <email> --dry-run` for each account |
| Google Ads OAuth | `~/.mcp-google-ads` (RW), `~/Documents/GitHub/mcp-google-ads`, `google-ads-mcp-write` (RO) | Copy the state dir and clone the repos |
| LinkedIn Ads | `~/.linkedin-ads-mcp*` and launchd `com.bradhess.linkedin-ads-token-refresh` | Move the job. It must run on the same machine as the OneCLI vault it pushes to. |
| ad-metrics | `~/.local/share/ad-metrics` and launchd `com.bradhess.ad-metrics-host` | Move with the host |
| Receivables refresh | launchd `com.bradhess.nanoclaw-receivables-refresh` (runs `scripts/ops/receivables-refresh.mjs`) | Move with the host. **The script is untracked** in the live checkout (added 2026-11-09, along with its `.test.mjs` and `.md`), so a fresh clone won't have it. Commit it first, or copy `scripts/ops/` across. |
| Other untracked files in the live checkout | `git status --ignored` in the live checkout | Review before the clone. Anything the host or a launchd job runs must be committed or copied. |
| NotebookLM | `~/.notebooklm-mcp-cli` | Copy, or sign in again on the Mini |
| Builder worktrees | `~/Documents/GitHub/builder-worktrees`, `p22-recruiting-website` | Clone from remotes |
| Mount allowlist | `~/.config/nanoclaw/mount-allowlist.json` | Copy. Paths stay the same because the user and layout are the same. |
| Status bar | `com.nanoclaw.statusbar` | Already on the Mini |

### Shared state that needs a decision

- **mnemon authority.** Today the MacBook is authoritative and the Mini forwards writes to it over ssh (`mnemon-remote-exec`, `mnemon-mini-sync`). Containers write to `~/.mnemon/queue`, which the host's `src/mnemon-sync.ts` drains, so the authority must sit next to the NanoClaw host.
  - **Recommendation:** move authority to the Mini (as in Aug–Sep 2026) and turn the MacBook into the forwarding side.
  - The sync scripts need their direction swapped. Do this as its own step, verified with `mnemon recall` from both machines, before the NanoClaw cutover.
- **Obsidian vault** (`~/Documents/Obsidian/JBH`). Agents write to 50-Sources, 50-Wiki, 30-Areas/Clients, 90-System/*. The Mini needs a synced copy (Obsidian Sync, or the iCloud/git method already in use). Agent writes made on the Mini must reach the MacBook within minutes.
  - Check that the sync tool doesn't create conflict copies when both sides write.
- **super-productivity.** The per-client nested repos already have remotes at `Demand-Gen-Guy/client-<slug>`, and the autosync wrapper walks them. Clone them on the Mini and run the autosync wrapper there too, so pushes come from where agents write.

### Still tied to the MacBook (do not move)

- **Shadow meeting files and `com.bradhess.shadow-archive`, `fluidmeet-export`.** Meetings are recorded on the MacBook. The meetings and meeting-review agents read their output (`groups/dm-with-brad/meeting-reviews`, Obsidian Timestamps/Meetings). Choose one:
  - (a) sync the archive output folder to the Mini (rsync over Tailscale from the archive job), or
  - (b) leave those jobs writing into Obsidian and rely on vault sync.
  - (b) needs no new moving parts if the vault sync is reliable.
- **Gemini broker.** The host runs `agy` under an isolated HOME on the operator's Google sign-in, and `gemini` can't sign in headless. Sign `agy` in on the Mini during a screen-sharing session, or leave `ask_gemini` disabled until you do.
- Personal launchd jobs (search-term analyzers, cache reports, folder-audit, obsidian-cleanup) are not NanoClaw's. Move them separately or leave them.

## 3. Cutover (one Telegram poller at a time)

Two hosts polling the same bot token cause `Conflict: terminated by other getUpdates request` (August 2026). Order matters:

1. Announce a maintenance window. Make sure no scheduled task fires during it (check `ncl tasks list`).
2. **MacBook: stop and disable the host.**

   ```bash
   launchctl bootout gui/$(id -u)/com.nanoclaw
   ```

   Then stop the receivables, ad-metrics and LinkedIn-refresh jobs.
3. **MacBook: stop the agent containers** (label `nanoclaw-install=edb15411`), then the OneCLI stack.
4. Copy `data/`, `groups/`, `.env`, the OneCLI volume and the credential dirs from §2 to the Mini.
5. **Mini: start OneCLI**, then check:
   - `curl` the health endpoint through the shim
   - `onecli secrets list` via the API, since the CLI caps at 20 rows
   - grants are present
6. **Mini: install and bootstrap the host plist** with `~/.local/bin/node`, then the companion jobs.
7. Verify:
   - [ ] Host log shows startup, a clean migration check, and a stamped `upgrade-state`
   - [ ] Telegram: DM Zed and get a reply, with no `getUpdates` conflict on either machine
   - [ ] Slack: one room mention and a reply
   - [ ] One Claude and one Codex group run a canary task (grants, model credentials)
   - [ ] A mount-heavy group (wiki or an AM) writes to Obsidian, and the write shows up on the MacBook
   - [ ] A container `mnemon remember` reaches the authoritative store
   - [ ] The Daily Ops topics route
   - [ ] The dashboard on `127.0.0.1:3100` (on the Mini; reach it over Tailscale with the login cookie)
8. Watch for 24 h:
   - `logs/nanoclaw.error.log`
   - `docker ps` for leftover containers
   - Slack pong warnings, which should mostly stop

## 4. Rollback

The MacBook copy is the rollback, as long as nothing has been deleted from it:

1. On the Mini, boot out the host and the companion jobs, then stop the containers and OneCLI.
2. Copy back `data/`, `groups/` and the OneCLI volume, but **only** if they changed on the Mini and you want to keep those changes. Otherwise skip this step.
3. Bootstrap `com.nanoclaw` and the companion jobs on the MacBook again.

Keep the MacBook copy as-is for two weeks. Then retire its `data/`/`groups/` copies to `~/Documents/_attic/<date>/` (never `rm`).

## 5. After a stable week

- Delete the Mini's legacy `com.nanoclaw-v2-edb15411` job if it is unused.
- Update the auto-memory notes "Mini nanoclaw disabled", "Mnemon shared store" and "Host pinned to Node 22", plus the CLAUDE.md "Do not touch" section that names the MacBook path as the live gateway.
- Reclaim MacBook disk: old agent images and the Docker build cache.

## 6. Optional: OrbStack instead of Docker Desktop

The October crashes were Docker Desktop's VM file sharing (grpcfuse) stalling under large bind mounts and host swap (docker/desktop-feedback#204, unfixed). OrbStack uses less memory and shares files faster, and it accepts the same `docker` CLI and image format.

- Images must be rebuilt or loaded again.
- The OneCLI stack's container names, ports and the `onecli-shim` port forward need a re-check.
- `host.docker.internal` works the same way.

Try it on the Mini first, during §1, before any cutover. It is a separate change from the move.
