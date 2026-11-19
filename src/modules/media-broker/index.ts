/**
 * Media broker module: host-side video download and transcription.
 *
 * Registers the `media_request` delivery action (written by the container's
 * `transcribe_media` MCP tool) and the worker's start/stop hooks. The host
 * runs yt-dlp, ffmpeg and mlx-whisper itself, so containers need no media
 * tooling, no GPU and no extra egress. See ./project.md.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { handleMediaRequest, startMediaBroker, stopMediaBroker } from './broker.js';

registerDeliveryAction(
  'media_request',
  handleMediaRequest,
  unguarded(
    'fetches only public posts on an allowlist of platforms (no generic extractor, no cookies) and returns text; capped per day by the broker',
  ),
);

onHostStart(() => startMediaBroker());
onHostShutdown(() => stopMediaBroker());
