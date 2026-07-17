import type { ProviderEvent } from './types.js';

export type FailureClass = 'quota' | 'auth' | 'billing';

export const FALLBACK_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>(['quota', 'auth', 'billing']);

const AUTH_RE = /\b(unauthorized|not logged in|please run \/login|invalid api key|invalid.*credential|401)\b/i;
const BILLING_RE = /\b(billing_error|credit balance|payment required|402|insufficient.*(credit|quota|funds))\b/i;
const QUOTA_RE = /\b(quota|usage limit|rate limit|429|too many requests)\b/i;

export function classifyMessage(message: string): FailureClass | null {
  if (AUTH_RE.test(message)) return 'auth';
  if (BILLING_RE.test(message)) return 'billing';
  if (QUOTA_RE.test(message)) return 'quota';
  return null;
}

export function classifyFailure(event: ProviderEvent): FailureClass | null {
  if (event.type === 'error') {
    if (event.retryable) return null;
    if (event.classification && FALLBACK_CLASSES.has(event.classification as FailureClass)) {
      return event.classification as FailureClass;
    }
    return classifyMessage(event.message);
  }
  if (event.type === 'result' && event.isError === true) {
    return classifyMessage(event.text ?? '');
  }
  return null;
}
