/**
 * Browser-safe model catalogs for the settings UI. Both server and client can import
 * this file. The "slug" is the value shipped to the provider's API; the label is for
 * the dropdown. Picking a slug that the underlying account doesn't have access to
 * will surface as a provider 404/permission error at request time — a clear,
 * actionable failure.
 */

export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'local';
export type ImageProviderName = 'openai' | 'gemini' | 'local';

export interface ModelOption {
  slug: string;
  label: string;
  blurb: string;
  recommended?: boolean;
}

/**
 * Input for {@link shouldShowBakedBuildTip}. Browser-safe (no DB types) — the
 * settings client passes its already-resolved values.
 */
export interface BakedTipInput {
  /** Active campaign master provider. */
  provider: ProviderName;
  /** Whether the local Ollama engine is reachable. */
  aiReachable: boolean;
  /** Installed local models; only the `kind` discriminator is consulted. */
  models: ReadonlyArray<{ kind?: 'baked' | 'raw' }>;
  /** Campaign master backend (`'vault'` once cut over; `'baked'`/undefined legacy). */
  masterBackend?: 'vault' | 'baked';
}

/**
 * Should the settings UI show the "Run `pnpm build-local-models` to enable
 * optimized variants (faster turns)" tip?
 *
 * Post-cutover staleness fix: baked variants only speed up the LEGACY baked
 * path (they pre-bake the big static blocks — MASTER_TOOL_CONTRACT, SRD,
 * handbook). On the VAULT path the system prompt is already minimal, so a
 * baked variant gives no speed-up and the tip is misleading. Gate it off when
 * `masterBackend === 'vault'`.
 *
 * Shows only when ALL hold: provider is local, Ollama reachable, ≥1 model
 * installed, none already baked, and the campaign is not on the vault path.
 */
export function shouldShowBakedBuildTip(input: BakedTipInput): boolean {
  if (input.provider !== 'local') return false;
  if (!input.aiReachable) return false;
  if (input.masterBackend === 'vault') return false;
  if (input.models.length === 0) return false;
  const anyBaked = input.models.some((m) => m.kind === 'baked');
  return !anyBaked;
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
  return [];  // 'local' — runtime list passed separately
}

export function defaultModelForProvider(p: ProviderName): string {
  if (p === 'local') return '';  // caller must override with runtime list
  const list = modelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function imageModelsForProvider(p: ImageProviderName): ModelOption[] {
  if (p === 'local') return [];
  return p === 'openai' ? OPENAI_IMAGE_MODELS : GEMINI_IMAGE_MODELS;
}

export function defaultImageModelForProvider(p: ImageProviderName): string {
  if (p === 'local') return '';
  const list = imageModelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

export function isKnownProvider(value: unknown): value is ProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'gemini' || value === 'local';
}

export function isKnownImageProvider(value: unknown): value is ImageProviderName {
  return value === 'openai' || value === 'gemini' || value === 'local';
}

/** Validates that the slug is in the union of known master model slugs. */
export function isKnownMasterModel(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  return [...ANTHROPIC_MASTER_MODELS, ...OPENAI_MASTER_MODELS, ...GEMINI_MASTER_MODELS].some(
    (m) => m.slug === value,
  );
}

/** Validates that the slug is in the union of known image model slugs. */
export function isKnownImageModel(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  const inCloudCatalog = [...OPENAI_IMAGE_MODELS, ...GEMINI_IMAGE_MODELS].some((m) => m.slug === value);
  if (inCloudCatalog) return true;
  return value.startsWith('draw-things:');
}
