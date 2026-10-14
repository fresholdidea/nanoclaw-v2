import type { HudToday } from '../types.js';
export function parseCarryover(text: string): HudToday['directives'] {
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Invalid carryover');
  return Object.entries(obj).flatMap(([key, value]) => {
    const r = value as Record<string, any>;
    if (
      !r ||
      typeof r.title !== 'string' ||
      !['decision', 'access', 'action'].includes(r.cls) ||
      !Number.isFinite(r.appearances)
    )
      throw new Error('Invalid directive');
    return r.resolved
      ? []
      : [
          {
            key,
            title: r.title,
            cls: r.cls,
            appearances: r.appearances,
            escalate: r.appearances > 2 && !(r.owner && r.date && r.alt),
            ...(typeof r.deadline === 'string' ? { deadline: r.deadline } : {}),
          },
        ];
  });
}
export function sortDirectives(rows: HudToday['directives']) {
  const escalate = (r: HudToday['directives'][number]) =>
    /ESCALATE/i.test(r.title) || (r as typeof r & { escalate?: boolean }).escalate === true;
  return [...rows].sort(
    (a, b) =>
      Number(escalate(b)) - Number(escalate(a)) ||
      (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999') ||
      b.appearances - a.appearances,
  );
}
