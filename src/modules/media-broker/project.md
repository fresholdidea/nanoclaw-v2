# Media broker module

Lets any agent turn a social-media video into text. The container tool `transcribe_media` writes a `media_request` system row. The host downloads the post's audio with `yt-dlp`, converts it with `ffmpeg`, transcribes it locally with `mlx-whisper` on the Apple GPU, and sends the result back as a chat message from `media-broker` with a Markdown document attached and a wake. Containers need no media tools, no GPU and no extra egress.

Built for the Wiki pipeline: agents could read an Instagram reel's caption (via `/embed/captioned/`) but not what was said in it, and for most reels the caption is a one-liner.

## Flow

1. `handleMediaRequest` (delivery action):
   - checks the agent folder against `MEDIA_BROKER_GROUPS`;
   - parses the URL with `parseMediaUrl` (`url.ts`). Only post URLs on Instagram, LinkedIn, YouTube, TikTok and X pass. Everything else is refused, including profiles, stories, playlists, other hosts, ports and credentials. The canonical URL drops tracking parameters;
   - answers from `data/media-broker/cache/<platform>-<id>.md` if the post was transcribed before. That is free and needs no tools;
   - checks the binaries, the queue (10 install-wide, 5 per agent) and the daily caps, writes `jobs/<id>.json` and queues the job. A job that fails before transcription (no video, refused or too-long download) gives its quota back.

   It never throws, and a re-delivered row with the same session and request id is dropped.

2. A single worker runs one job at a time, because Whisper takes the whole GPU (`pipeline.ts`):
   - `yt-dlp --ignore-config --use-extractors <platform only> --format bestaudio/best --max-filesize --match-filter "!is_live & duration <=? max" --playlist-items 1:5 --write-info-json -- <url>`, with no cookies and no generic extractor;
   - `ffprobe` duration check, `ffmpeg` to 16 kHz mono WAV, then `uvx --from mlx-whisper==0.4.3 mlx_whisper … --output-format json`;
   - each child runs in its own process group under one deadline (`MEDIA_BROKER_TIMEOUT_SEC`) and is SIGKILLed as a group on timeout or shutdown.
3. `document.ts` builds the Markdown: source, author, publish date, duration, engagement, then the caption, then the transcript with `[m:ss]` stamps about every 30 s. A carousel gets one section per video, up to 5. A download that fails partway is delivered marked `PARTIAL` and is not cached. The document carries nothing about the request, because the cache serves it to any group.
   - **Vault safety.** These documents get filed into the Obsidian vault, where plugins run code found in a note. DataviewJS is on, block and inline `$=` (checked 2026-11-19), so it runs a ```` ```dataviewjs ```` fence or an inline query when Brad opens the note. Templater runs `<% %>`, though its on-create trigger is currently off. Third-party text therefore never carries a backtick (it becomes `ˋ`, U+02CB) or a raw `<%` into the document. Poster-controlled metadata (uploader, channel) is flattened to one control-free line. The chat preview quotes every line with `│ ` after normalizing `\r` and U+2028/2029.
4. On host start, every job file left behind is re-queued (a job is just a URL), and the scratch root under `$TMPDIR/nanoclaw-media-broker-<hash>` is swept.

## Configuration (`.env`, read on every request)

| Key                                                   | Default                                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `MEDIA_BROKER_ENABLED`                                | on (`false` turns it off)                                                                       |
| `MEDIA_BROKER_GROUPS`                                 | `*`, or a comma-separated list of agent folders                                                 |
| `MEDIA_BROKER_DAILY_REQUESTS`                         | 40 install-wide (cache hits are free)                                                           |
| `MEDIA_BROKER_GROUP_DAILY_REQUESTS`                   | 20 per agent group                                                                              |
| `MEDIA_BROKER_MAX_DURATION_SEC`                       | 1800                                                                                            |
| `MEDIA_BROKER_MAX_DOWNLOAD_MB`                        | 300                                                                                             |
| `MEDIA_BROKER_TIMEOUT_SEC`                            | 900 per job                                                                                     |
| `MEDIA_BROKER_YTDLP_BIN` / `_FFMPEG_BIN` / `_UVX_BIN` | `/opt/homebrew/bin/…` (launchd has no Homebrew PATH; `ffprobe` must sit next to `ffmpeg`)       |
| `MEDIA_BROKER_WHISPER_PACKAGE`                        | `mlx-whisper==0.4.3`                                                                            |
| `MEDIA_BROKER_WHISPER_MODEL`                          | `mlx-community/whisper-large-v3-turbo` (~1.6 GB, cached in `~/.cache/huggingface` on first use) |

## State

`data/media-broker/`: `usage.json` (today's counts), `requests.jsonl` (one line per outcome: ok, failed, refused, cached), `jobs/` (pending), `cache/` (finished documents; delete a file to force a re-transcribe).

## Operating notes

- Measured on 2026-11-19: a 2:53 Instagram reel took 10.5 s end to end (audio-only download plus transcription), once the model was cached.
- `yt-dlp` is Homebrew's. Instagram and TikTok break extractors often, so when downloads start failing with extractor errors, run `brew upgrade yt-dlp` first.
- No platform login is used. A post that needs one fails with "the platform refused an anonymous download". Adding cookies would put a personal session on the host's request path. That is a deliberate decision for later, not a missing default.
- Children run in their own process group. A clean shutdown kills them, but a host *crash* can orphan a running `yt-dlp`. The deadline lives in the host, and the restart re-runs the job, so after a crash check `pgrep -fl yt-dlp`.
- Visual-only content (on-screen text, slides with no voice-over) is not captured. For that, frames could go to the Gemini broker; not built.
