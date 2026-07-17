export interface FallbackState {
  v: 1;
  /** Provider name currently in effect. */
  active: string;
  /** Each child provider's own last continuation token. */
  children: Record<string, string>;
  /** ISO-8601 UTC; null when active === primary (no re-probe pending). */
  cooldownUntil: string | null;
}

export function encodeState(state: FallbackState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function decodeState(token: string | undefined): FallbackState | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as Partial<FallbackState>;
    if (parsed.v !== 1 || typeof parsed.active !== 'string' || typeof parsed.children !== 'object' || parsed.children === null) {
      return null;
    }
    return {
      v: 1,
      active: parsed.active,
      children: parsed.children as Record<string, string>,
      cooldownUntil: typeof parsed.cooldownUntil === 'string' ? parsed.cooldownUntil : null,
    };
  } catch {
    return null;
  }
}
