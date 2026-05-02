/**
 * Browser-safe model catalogs for the settings UI. Both server and client can import
 * this file. The "slug" is the value shipped to the provider's API; the label is for
 * the dropdown. Picking a slug that the underlying account doesn't have access to
 * will surface as a provider 404/permission error at request time — a clear,
 * actionable failure.
 */

export type ProviderName = 'anthropic' | 'openai';

export interface ModelOption {
  slug: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

export const ANTHROPIC_MASTER_MODELS: ModelOption[] = [
  {
    slug: 'claude-opus-4-5',
    label: 'Claude Opus 4.5',
    blurb: 'Most capable; slowest and most expensive.',
  },
  {
    slug: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    blurb: 'Balanced speed and quality.',
    recommended: true,
  },
  {
    slug: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    blurb: 'Fast, cheap, smaller context.',
  },
];

export const OPENAI_MASTER_MODELS: ModelOption[] = [
  {
    slug: 'gpt-5.5',
    label: 'GPT-5.5',
    blurb: 'Latest flagship.',
  },
  {
    slug: 'gpt-5.5-mini',
    label: 'GPT-5.5 mini',
    blurb: 'Smaller, faster 5.5.',
  },
  {
    slug: 'gpt-5',
    label: 'GPT-5',
    blurb: 'Stable flagship.',
    recommended: true,
  },
  {
    slug: 'gpt-5-mini',
    label: 'GPT-5 mini',
    blurb: 'Smaller, faster 5.',
  },
  {
    slug: 'gpt-4.1',
    label: 'GPT-4.1',
    blurb: 'Previous-gen flagship; battle-tested with tools.',
  },
];

export function modelsForProvider(p: ProviderName): ModelOption[] {
  return p === 'anthropic' ? ANTHROPIC_MASTER_MODELS : OPENAI_MASTER_MODELS;
}

export function defaultModelForProvider(p: ProviderName): string {
  const list = modelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function isKnownProvider(value: unknown): value is ProviderName {
  return value === 'anthropic' || value === 'openai';
}

/** Validates that the slug is in the union of known model slugs (no provider-consistency check). */
export function isKnownMasterModel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return [...ANTHROPIC_MASTER_MODELS, ...OPENAI_MASTER_MODELS].some((m) => m.slug === value);
}
