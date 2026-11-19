/**
 * Media broker configuration, read from `.env` on every request so an
 * operator can change a cap or a binary path without restarting the host.
 *
 * Binary paths are absolute because the host runs under launchd, whose PATH
 * has no Homebrew directory.
 */
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { readEnvFile } from '../../env.js';

export interface MediaBrokerConfig {
  enabled: boolean;
  ytDlpBin: string;
  ffmpegBin: string;
  /** Runs mlx-whisper from a pinned package, so nothing is installed globally. */
  uvxBin: string;
  whisperPackage: string;
  whisperModel: string;
  /** Host-only state: usage ledger, request log, pending jobs, transcript cache. */
  stateDir: string;
  /** Agent folders allowed to use the broker, or '*' for all. */
  groups: '*' | string[];
  dailyRequests: number;
  groupDailyRequests: number;
  maxDurationSec: number;
  maxDownloadBytes: number;
  timeoutSec: number;
  maxQueue: number;
}

const KEYS = [
  'MEDIA_BROKER_ENABLED',
  'MEDIA_BROKER_YTDLP_BIN',
  'MEDIA_BROKER_FFMPEG_BIN',
  'MEDIA_BROKER_UVX_BIN',
  'MEDIA_BROKER_WHISPER_PACKAGE',
  'MEDIA_BROKER_WHISPER_MODEL',
  'MEDIA_BROKER_GROUPS',
  'MEDIA_BROKER_DAILY_REQUESTS',
  'MEDIA_BROKER_GROUP_DAILY_REQUESTS',
  'MEDIA_BROKER_MAX_DURATION_SEC',
  'MEDIA_BROKER_MAX_DOWNLOAD_MB',
  'MEDIA_BROKER_TIMEOUT_SEC',
];

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadMediaConfig(env: Record<string, string> = readEnvFile(KEYS)): MediaBrokerConfig {
  const groupsRaw = (env.MEDIA_BROKER_GROUPS ?? '*').trim();
  const groups =
    groupsRaw === '' || groupsRaw === '*'
      ? ('*' as const)
      : groupsRaw
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean);
  return {
    enabled: !/^(0|false|no|off)$/i.test((env.MEDIA_BROKER_ENABLED ?? '').trim()),
    ytDlpBin: env.MEDIA_BROKER_YTDLP_BIN?.trim() || '/opt/homebrew/bin/yt-dlp',
    ffmpegBin: env.MEDIA_BROKER_FFMPEG_BIN?.trim() || '/opt/homebrew/bin/ffmpeg',
    uvxBin: env.MEDIA_BROKER_UVX_BIN?.trim() || '/opt/homebrew/bin/uvx',
    whisperPackage: env.MEDIA_BROKER_WHISPER_PACKAGE?.trim() || 'mlx-whisper==0.4.3',
    whisperModel: env.MEDIA_BROKER_WHISPER_MODEL?.trim() || 'mlx-community/whisper-large-v3-turbo',
    stateDir: path.join(DATA_DIR, 'media-broker'),
    groups,
    dailyRequests: int(env.MEDIA_BROKER_DAILY_REQUESTS, 40, 0, 10_000),
    groupDailyRequests: int(env.MEDIA_BROKER_GROUP_DAILY_REQUESTS, 20, 0, 10_000),
    maxDurationSec: int(env.MEDIA_BROKER_MAX_DURATION_SEC, 1800, 10, 4 * 3600),
    maxDownloadBytes: int(env.MEDIA_BROKER_MAX_DOWNLOAD_MB, 300, 1, 4096) * 1024 * 1024,
    timeoutSec: int(env.MEDIA_BROKER_TIMEOUT_SEC, 900, 30, 4 * 3600),
    maxQueue: 10,
  };
}
