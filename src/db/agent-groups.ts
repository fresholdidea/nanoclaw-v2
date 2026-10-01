import { AGENT_TIERS, type AgentGroup, type AgentPersona, type AgentTier } from '../types.js';
import { getDb } from './connection.js';

export async function createAgentGroup(group: AgentGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, tier, reports_to, role, persona)
     VALUES (@id, @name, @folder, @agent_provider, @created_at, @tier, @reports_to, @role, @persona)`,
    {
      id: group.id,
      name: group.name,
      folder: group.folder,
      agent_provider: group.agent_provider,
      created_at: group.created_at,
      tier: group.tier ?? null,
      reports_to: group.reports_to ?? null,
      role: group.role ?? null,
      persona: group.persona ?? null,
    },
  );
}

export async function getAgentGroup(id: string): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>('SELECT * FROM agent_groups WHERE id = ?', id);
}

export async function getAgentGroupByFolder(folder: string): Promise<AgentGroup | undefined> {
  return getDb().get<AgentGroup>('SELECT * FROM agent_groups WHERE folder = ?', folder);
}

export async function getAllAgentGroups(): Promise<AgentGroup[]> {
  return getDb().all<AgentGroup>('SELECT * FROM agent_groups ORDER BY name');
}

// ---------------------------------------------------------------------------
// Architecture metadata (tier / reports_to / role / persona) — validation
// ---------------------------------------------------------------------------

const PERSONA_KEYS = ['emoji', 'color', 'initials'] as const;
/** Keep persona and role small: they are rendered on cards and in tables. */
const PERSONA_VALUE_MAX = 64;
const ROLE_MAX = 200;

/**
 * Decode a stored `persona` column. Returns null for NULL/empty/invalid JSON
 * so a display path never throws on a hand-edited row.
 */
export function parseAgentPersona(raw: string | null | undefined): AgentPersona | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as AgentPersona;
  } catch {
    return null;
  }
}

/** Parse + validate a persona payload (JSON text or an already-parsed object). */
export function normalizeAgentPersona(input: unknown): string {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (err) {
      throw new Error('persona must be a JSON object like {"emoji":"🦉","color":"#1e90ff","initials":"ZD"}', {
        cause: err,
      });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('persona must be a JSON object with optional string keys: emoji, color, initials');
  }
  const out: AgentPersona = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(PERSONA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`persona: unknown key "${key}" (allowed: ${PERSONA_KEYS.join(', ')})`);
    }
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`persona.${key} must be a string`);
    const trimmed = v.trim();
    if (trimmed === '') continue;
    if (trimmed.length > PERSONA_VALUE_MAX) {
      throw new Error(`persona.${key} is too long (max ${PERSONA_VALUE_MAX} characters)`);
    }
    out[key as keyof AgentPersona] = trimmed;
  }
  return JSON.stringify(out);
}

export function isAgentTier(value: unknown): value is AgentTier {
  return typeof value === 'string' && (AGENT_TIERS as readonly string[]).includes(value);
}

export type AgentArchitectureUpdates = Partial<Pick<AgentGroup, 'tier' | 'reports_to' | 'role' | 'persona'>>;

/**
 * Validate and canonicalize an architecture update for group `id`, in place.
 * `""` (the CLI's clear convention) and `null` both mean "clear". Throws an
 * actionable Error on an invalid value.
 *
 * - `tier` must be one of `AGENT_TIERS`
 * - `reports_to` must name an existing agent group, not the group itself, and
 *   must not close a reporting cycle
 * - `role` is a single line, trimmed, at most 200 characters
 * - `persona` is re-encoded canonically from a JSON object
 */
export async function normalizeAgentArchitectureUpdates(id: string, updates: Record<string, unknown>): Promise<void> {
  const clear = (v: unknown): boolean => v === null || v === '';

  if (updates.tier !== undefined) {
    if (clear(updates.tier)) updates.tier = null;
    else if (!isAgentTier(updates.tier)) {
      throw new Error(`tier must be one of: ${AGENT_TIERS.join(', ')} (or "" to clear)`);
    }
  }

  if (updates.reports_to !== undefined) {
    if (clear(updates.reports_to)) updates.reports_to = null;
    else {
      const target = String(updates.reports_to);
      if (target === id) throw new Error('reports_to cannot point at the group itself');
      const parent = await getAgentGroup(target);
      if (!parent) throw new Error(`reports_to: agent group not found: ${target}`);
      // Walk up from the proposed parent; reaching `id` again means a cycle.
      const seen = new Set<string>([target]);
      let cursor: string | null | undefined = parent.reports_to;
      while (cursor) {
        if (cursor === id) {
          throw new Error(
            `reports_to: "${target}" already reports (transitively) to this group — that would form a cycle`,
          );
        }
        if (seen.has(cursor)) break; // pre-existing cycle elsewhere: not ours to fix here
        seen.add(cursor);
        cursor = (await getAgentGroup(cursor))?.reports_to;
      }
      updates.reports_to = target;
    }
  }

  if (updates.role !== undefined) {
    if (clear(updates.role)) updates.role = null;
    else {
      const role = String(updates.role).trim();
      if (role === '') updates.role = null;
      else {
        if (/[\r\n]/.test(role)) throw new Error('role must be a single line');
        if (role.length > ROLE_MAX) throw new Error(`role is too long (max ${ROLE_MAX} characters)`);
        updates.role = role;
      }
    }
  }

  if (updates.persona !== undefined) {
    updates.persona = clear(updates.persona) ? null : normalizeAgentPersona(updates.persona);
  }
}

export async function updateAgentGroup(
  id: string,
  updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider'>> & AgentArchitectureUpdates,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  const pending: Record<string, unknown> = { ...updates };
  await normalizeAgentArchitectureUpdates(id, pending);

  for (const [key, value] of Object.entries(pending)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function deleteAgentGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM agent_groups WHERE id = ?', id);
}
