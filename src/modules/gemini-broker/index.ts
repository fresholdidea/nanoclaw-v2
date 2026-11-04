/**
 * Gemini broker module — host-side big reads on Brad's Google AI Pro sign-in.
 *
 * Registers the `gemini_request` delivery action (written by the container's
 * `ask_gemini` MCP tool) and the worker's start/stop hooks. The Google
 * sign-in never enters a container: the host runs agy itself, under an
 * isolated HOME, against copies of files the caller's container can already
 * read. See ./project.md.
 *
 * Without this module the tool still writes its outbound row, delivery logs
 * "Unknown system action" and drops it, and the agent waits for an answer
 * that never comes; the tool description tells it so.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { handleGeminiRequest, startBroker, stopBroker } from './broker.js';

registerDeliveryAction(
  'gemini_request',
  handleGeminiRequest,
  unguarded(
    "reads only files the caller's container already mounts, resolved through its own mount table; spend is capped per day by the broker",
  ),
);

onHostStart(() => startBroker());
onHostShutdown(() => stopBroker());
