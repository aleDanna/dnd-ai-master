/**
 * Browser-safe model catalogs for the settings UI. Both server and client can import
 * this file. The "slug" is the value shipped to the provider's API; the label is for
 * the dropdown. Picking a slug that the underlying account doesn't have access to
 * will surface as a provider 404/permission error at request time — a clear,
 * actionable failure.
 */

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'ollama';
export type ImageProviderName = 'openai' | 'gemini';

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
  { slug: 'gpt-5.5', label: 'GPT-5.5', blurb: 'Latest flagship.' },
  { slug: 'gpt-5.5-mini', label: 'GPT-5.5 mini', blurb: 'Smaller, faster 5.5.' },
  { slug: 'gpt-5', label: 'GPT-5', blurb: 'Stable flagship.', recommended: true },
  { slug: 'gpt-5-mini', label: 'GPT-5 mini', blurb: 'Smaller, faster 5.' },
  { slug: 'gpt-4.1', label: 'GPT-4.1', blurb: 'Previous-gen flagship; battle-tested with tools.' },
];

export const GEMINI_MASTER_MODELS: ModelOption[] = [
  {
    slug: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    blurb: 'Most capable; deep reasoning.',
    recommended: true,
  },
  {
    slug: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    blurb: 'Balanced speed and quality.',
  },
  {
    slug: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    blurb: 'Fastest, cheapest, smaller context.',
  },
];

export const OPENAI_IMAGE_MODELS: ModelOption[] = [
  { slug: 'gpt-image-1', label: 'GPT Image 1', blurb: 'Current default; high quality.', recommended: true },
];

export const GEMINI_IMAGE_MODELS: ModelOption[] = [
  {
    slug: 'gemini-2.5-flash-image',
    label: 'Gemini 2.5 Flash Image',
    blurb: 'Fast and cheap; good defaults.',
    recommended: true,
  },
  {
    slug: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    blurb: 'Higher quality; slower and pricier.',
  },
];

export function modelsForProvider(p: ProviderName): ModelOption[] {
  if (p === 'anthropic') return ANTHROPIC_MASTER_MODELS;
  if (p === 'openai') return OPENAI_MASTER_MODELS;
  if (p === 'gemini') return GEMINI_MASTER_MODELS;
  // Ollama's list is supplied at runtime from /api/tags, not enumerated here.
  return [];
}

export function defaultModelForProvider(p: ProviderName): string {
  const list = modelsForProvider(p);
  // Ollama has no enumerated list — the caller must supply the runtime list.
  // Returning '' here lets the caller detect "no static default" and pick from the live probe.
  if (list.length === 0) return '';
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function imageModelsForProvider(p: ImageProviderName): ModelOption[] {
  return p === 'openai' ? OPENAI_IMAGE_MODELS : GEMINI_IMAGE_MODELS;
}

export function defaultImageModelForProvider(p: ImageProviderName): string {
  const list = imageModelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function isKnownProvider(value: unknown): value is ProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'gemini' || value === 'ollama';
}

export function isKnownImageProvider(value: unknown): value is ImageProviderName {
  return value === 'openai' || value === 'gemini';
}

/** Validates that the slug is in the union of known master model slugs.
 *  For Ollama, slugs are dynamic — accept any non-empty string ≤200 chars. */
export function isKnownMasterModel(value: unknown, provider?: ProviderName): boolean {
  if (typeof value !== 'string') return false;
  if (provider === 'ollama') return value.length > 0 && value.length <= 200;
  return [...ANTHROPIC_MASTER_MODELS, ...OPENAI_MASTER_MODELS, ...GEMINI_MASTER_MODELS].some(
    (m) => m.slug === value,
  );
}

/** Validates that the slug is in the union of known image model slugs. */
export function isKnownImageModel(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return [...OPENAI_IMAGE_MODELS, ...GEMINI_IMAGE_MODELS].some((m) => m.slug === value);
}
