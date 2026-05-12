import { describe, it, expect } from 'vitest';
import { validateCreateBody, validatePatchBody } from '@/campaigns/validate';

describe('validateCreateBody', () => {
  it('accepts a valid body', () => {
    const r = validateCreateBody({ name: 'Adventure', premise: 'A long premise text.', characterTemplateId: '11111111-1111-1111-1111-111111111111' });
    expect(r.ok).toBe(true);
  });
  it('rejects missing fields', () => {
    const r = validateCreateBody({ name: 'x' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/premise|characterTemplateId/);
  });
  it('rejects non-uuid characterTemplateId', () => {
    const r = validateCreateBody({ name: 'x', premise: 'y', characterTemplateId: 'not-a-uuid' });
    expect(r.ok).toBe(false);
  });
});

describe('validatePatchBody', () => {
  it('accepts a rename', () => {
    const r = validatePatchBody({ name: 'new title' });
    expect(r.ok).toBe(true);
  });
  it('rejects premise changes', () => {
    const r = validatePatchBody({ premise: 'changed' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/immutable/);
  });
  it('rejects empty body', () => {
    const r = validatePatchBody({});
    expect(r.ok).toBe(false);
  });
});
