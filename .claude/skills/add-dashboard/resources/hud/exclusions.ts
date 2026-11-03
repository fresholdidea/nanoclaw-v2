const FLOOR = ['falcone', 'vast.dev', 'growing wellness'];
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
export function exclusionFilter(registry: unknown, enabled = true) {
  const e = (registry as { exclusions?: Record<string, unknown> } | null)?.exclusions;
  const terms = [
    ...FLOOR,
    ...['ids', 'domains', 'aliases'].flatMap((k) => (Array.isArray(e?.[k]) ? (e![k] as string[]) : [])),
  ]
    .filter((x) => typeof x === 'string')
    .map(norm)
    .filter(Boolean);
  let hiddenCount = 0;
  function matches(value: unknown): boolean {
    if (!enabled) return false;
    if (typeof value === 'string') {
      const s = norm(value);
      return terms.some((t) => s.includes(t) || s.replaceAll(' ', '').includes(t.replaceAll(' ', '')));
    }
    if (Array.isArray(value)) return value.some(matches);
    return !!value && typeof value === 'object' && Object.entries(value).some(([k, v]) => matches(k) || matches(v));
  }
  return {
    keep(value: unknown) {
      if (!matches(value)) return true;
      hiddenCount++;
      return false;
    },
    get hiddenCount() {
      return hiddenCount;
    },
  };
}
export type Keep = (value: unknown) => boolean;
