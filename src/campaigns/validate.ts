const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreateBody = { name: string; premise: string; characterTemplateId: string };
export type PatchBody = { name: string };

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validateCreateBody(input: unknown): ValidateResult<CreateBody> {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'body-not-object' };
  const o = input as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return { ok: false, reason: 'name-required' };
  if (typeof o.premise !== 'string' || o.premise.trim().length === 0) return { ok: false, reason: 'premise-required' };
  if (typeof o.characterTemplateId !== 'string' || !UUID_RE.test(o.characterTemplateId)) return { ok: false, reason: 'characterTemplateId-required' };
  return { ok: true, value: { name: o.name.trim(), premise: o.premise.trim(), characterTemplateId: o.characterTemplateId } };
}

export function validatePatchBody(input: unknown): ValidateResult<PatchBody> {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'body-not-object' };
  const o = input as Record<string, unknown>;
  if ('premise' in o) return { ok: false, reason: 'premise-is-immutable' };
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return { ok: false, reason: 'name-required' };
  return { ok: true, value: { name: o.name.trim() } };
}
