/**
 * Download → audio → transcript, for one post.
 *
 * yt-dlp fetches the best audio-only format (falling back to the full video)
 * plus its info JSON; ffmpeg turns each media file into 16 kHz mono WAV;
 * mlx-whisper (Apple Silicon, local, no API key) transcribes it with segment
 * timestamps. Every child runs in its own process group under one deadline,
 * so a hung download or transcription is killed with everything it spawned.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { MediaBrokerConfig } from './config.js';
import type { MediaTarget } from './url.js';

export class MediaError extends Error {
  /** True when the job failed before any transcription ran, so its quota is given back. */
  constructor(
    message: string,
    readonly beforeTranscription = false,
  ) {
    super(message);
  }
}

export interface MediaMeta {
  title?: string;
  uploader?: string;
  channel?: string;
  /** ISO date-time of publication, when the platform gives one. */
  published?: string;
  description?: string;
  webpageUrl?: string;
  likeCount?: number;
  viewCount?: number;
}

export interface TranscriptSegment {
  start: number;
  text: string;
}

export interface MediaPart {
  /** 1-based position in a carousel; always 1 for a single video. */
  index: number;
  durationSec: number;
  language?: string;
  /** Empty when the media has no audio track. */
  segments: TranscriptSegment[];
  noAudio: boolean;
}

export interface MediaResult {
  meta: MediaMeta;
  parts: MediaPart[];
  /** yt-dlp exited with an error after some files arrived: later videos are missing. Never cached. */
  partial: boolean;
}

const MAX_PARTS = 5;
const OUTPUT_CAP = 256 * 1024;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  bin: string,
  args: string[],
  opts: { cwd: string; deadline: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const remaining = opts.deadline - Date.now();
    if (remaining <= 0) return reject(new MediaError('the request ran out of time'));
    if (opts.signal?.aborted) return reject(new MediaError('the request was cancelled'));
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedFor: string | null = null;
    const kill = (why: string) => {
      killedFor = why;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        // eslint-disable-next-line no-catch-all/no-catch-all -- the group may already be gone
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => kill('the request ran out of time'), remaining);
    const onAbort = () => kill('the request was cancelled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      // Keep the tail: the error line comes last, after any progress output.
      stdout = (stdout + d.toString('utf-8')).slice(-OUTPUT_CAP);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf-8')).slice(-OUTPUT_CAP);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new MediaError(`could not start ${path.basename(bin)} (${err.message})`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (killedFor) return reject(new MediaError(killedFor));
      resolve({ code, stdout, stderr });
    });
  });
}

/** The last meaningful yt-dlp error line, without its `ERROR: [extractor] id:` prefix. */
export function ytDlpReason(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'));
  const last = lines.at(-1);
  if (!last) return 'yt-dlp failed without an error message';
  return last
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[^:]*:\s*/, '')
    .slice(0, 300);
}

export function friendlyDownloadError(stderr: string): string {
  const reason = ytDlpReason(stderr);
  if (/no video (formats )?(found|in this post)|no video in this post|There is no video/i.test(stderr)) {
    return 'this post has no video or audio (an image or text post); read its caption or text instead';
  }
  if (/log ?in|login required|cookies|rate.?limit|429|Requested content is not available/i.test(reason)) {
    return `the platform refused an anonymous download (${reason}). The host has no login for it; read the caption or ask Brad to paste the text`;
  }
  if (/private|unavailable|removed|does not exist|404/i.test(reason)) return `the post is not available (${reason})`;
  return `the download failed (${reason})`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function metaFromInfo(info: Record<string, unknown>): MediaMeta {
  const ts = num(info.timestamp);
  const ud = str(info.upload_date);
  return {
    title: str(info.title),
    uploader: str(info.uploader),
    channel: str(info.channel) ?? str(info.uploader_id),
    published: ts
      ? new Date(ts * 1000).toISOString()
      : ud && /^\d{8}$/.test(ud)
        ? `${ud.slice(0, 4)}-${ud.slice(4, 6)}-${ud.slice(6, 8)}`
        : undefined,
    description: str(info.description),
    webpageUrl: str(info.webpage_url),
    likeCount: num(info.like_count),
    viewCount: num(info.view_count),
  };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or broken file is just "no metadata"
  } catch {
    return null;
  }
}

function toolEnv(cfg: MediaBrokerConfig): NodeJS.ProcessEnv {
  // mlx-whisper and yt-dlp both shell out to `ffmpeg` by name.
  const dirs = [path.dirname(cfg.ffmpegBin), path.dirname(cfg.uvxBin), '/usr/bin', '/bin'];
  return { ...process.env, PATH: [...new Set(dirs)].join(':') };
}

async function download(
  cfg: MediaBrokerConfig,
  t: MediaTarget,
  dir: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ files: string[]; meta: MediaMeta; partial: boolean }> {
  const args = [
    '--ignore-config',
    '--no-progress',
    '--no-mtime',
    '--use-extractors',
    t.extractors.join(','),
    '--format',
    'bestaudio/best',
    '--max-filesize',
    String(cfg.maxDownloadBytes),
    '--match-filter',
    `!is_live & duration <=? ${cfg.maxDurationSec}`,
    '--playlist-items',
    `1:${MAX_PARTS}`,
    '--write-info-json',
    '--socket-timeout',
    '30',
    '--retries',
    '2',
    '--ffmpeg-location',
    cfg.ffmpegBin,
    '--output',
    path.join(dir, '%(playlist_index|0)02d-media.%(ext)s'),
    '--',
    t.url,
  ];
  const r = await run(cfg.ytDlpBin, args, { cwd: dir, deadline, signal, env: toolEnv(cfg) });
  const names = fs.readdirSync(dir).sort();
  const files = names
    .filter((n) => /-media\.[A-Za-z0-9]+$/.test(n) && !n.endsWith('.json') && !n.endsWith('.part'))
    .map((n) => path.join(dir, n));
  const infoName = names.find((n) => /-media\.info\.json$/.test(n));
  const playlistInfo = names.find((n) => n.endsWith('.info.json') && !/-media\.info\.json$/.test(n));
  const info =
    (infoName && readJson(path.join(dir, infoName))) || (playlistInfo && readJson(path.join(dir, playlistInfo)));
  const meta = info ? metaFromInfo(info) : {};
  if (files.length === 0) {
    if (r.code === 0 && /does not pass filter/i.test(r.stdout + r.stderr)) {
      throw new MediaError(
        `the video is a live stream or longer than the ${Math.round(cfg.maxDurationSec / 60)}-minute limit`,
        true,
      );
    }
    if (r.code === 0 && /larger than max-filesize|File is larger/i.test(r.stdout + r.stderr)) {
      throw new MediaError(`the download is larger than ${Math.round(cfg.maxDownloadBytes / 1024 / 1024)} MB`, true);
    }
    throw new MediaError(friendlyDownloadError(r.stderr), true);
  }
  return { files, meta, partial: r.code !== 0 };
}

async function probeDuration(
  cfg: MediaBrokerConfig,
  file: string,
  dir: string,
  deadline: number,
  signal?: AbortSignal,
) {
  const ffprobe = path.join(path.dirname(cfg.ffmpegBin), 'ffprobe');
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], {
    cwd: dir,
    deadline,
    signal,
    env: toolEnv(cfg),
  });
  const n = Number.parseFloat(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

async function transcribePart(
  cfg: MediaBrokerConfig,
  file: string,
  index: number,
  dir: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<MediaPart> {
  const durationSec = await probeDuration(cfg, file, dir, deadline, signal);
  if (durationSec > cfg.maxDurationSec) {
    throw new MediaError(`the video is longer than the ${Math.round(cfg.maxDurationSec / 60)}-minute limit`);
  }
  const wav = path.join(dir, `audio-${index}.wav`);
  const ff = await run(
    cfg.ffmpegBin,
    ['-nostdin', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav],
    { cwd: dir, deadline, signal, env: toolEnv(cfg) },
  );
  if (ff.code !== 0 || !fs.existsSync(wav)) {
    if (/does not contain any stream|Output file .* does not contain|matches no streams/i.test(ff.stderr)) {
      return { index, durationSec, segments: [], noAudio: true };
    }
    throw new MediaError(`ffmpeg could not extract the audio (${ff.stderr.trim().split('\n').at(-1)?.slice(0, 200)})`);
  }
  const w = await run(
    cfg.uvxBin,
    [
      '--from',
      cfg.whisperPackage,
      'mlx_whisper',
      wav,
      '--model',
      cfg.whisperModel,
      '--output-format',
      'json',
      '--output-dir',
      dir,
      '--verbose',
      'False',
    ],
    { cwd: dir, deadline, signal, env: toolEnv(cfg) },
  );
  const out = readJson(path.join(dir, `audio-${index}.json`));
  if (w.code !== 0 || !out) {
    const last = w.stderr.trim().split('\n').filter(Boolean).at(-1) ?? `exit ${w.code}`;
    throw new MediaError(`transcription failed (${last.slice(0, 200)})`);
  }
  const segments = (Array.isArray(out.segments) ? out.segments : [])
    .map((s: Record<string, unknown>) => ({ start: num(s.start) ?? 0, text: (str(s.text) ?? '').trim() }))
    .filter((s: TranscriptSegment) => s.text);
  return { index, durationSec, language: str(out.language), segments, noAudio: false };
}

export async function runPipeline(
  cfg: MediaBrokerConfig,
  t: MediaTarget,
  dir: string,
  signal?: AbortSignal,
): Promise<MediaResult> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + cfg.timeoutSec * 1000;
  let downloaded: Awaited<ReturnType<typeof download>>;
  try {
    downloaded = await download(cfg, t, dir, deadline, signal);
  } catch (err) {
    // A timeout or cancellation during the download also ran no transcription.
    if (err instanceof MediaError && !err.beforeTranscription) throw new MediaError(err.message, true);
    throw err;
  }
  const { files, meta, partial } = downloaded;
  const parts: MediaPart[] = [];
  for (const [i, file] of files.slice(0, MAX_PARTS).entries()) {
    parts.push(await transcribePart(cfg, file, i + 1, dir, deadline, signal));
  }
  return { meta, parts, partial };
}
