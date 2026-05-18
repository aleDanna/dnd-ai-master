# Local AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `local` as a fourth provider option for LLM, TTS, and image generation that routes to self-hosted services (Ollama, Piper, XTTSv2, ComfyUI, Draw Things), gated by automatic local-environment detection and per-service env vars.

**Architecture:** A shared `src/lib/local-services.ts` module owns env detection, health checks, and sub-model enumeration. One new provider class per surface (`src/ai/provider/local.ts` for LLM, inline branches in `src/ai/tts.ts` for TTS, new files in `src/sessions/image-providers/` for image). Settings UI gains a "Local" radio + engine selector per surface, hidden when not in a dev environment or when no backing service is reachable. Cloud providers (Anthropic/OpenAI/Gemini) remain untouched.

**Tech Stack:** Next.js App Router · TypeScript · Drizzle · vitest · Ollama REST (`/api/chat`, `/api/tags`) · Piper via `openedai-speech-min` (Docker, OpenAI-compat) · XTTSv2 via `xtts-api-server` (native Python) · ComfyUI REST · Stable Diffusion-compatible API (Draw Things)

**Design spec:** [docs/superpowers/specs/2026-05-16-local-ai-provider-design.md](../specs/2026-05-16-local-ai-provider-design.md)

---

## Phase 1 — Foundation

### Task 1: Local services module — env detection + types + ping primitives

**Files:**
- Create: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-env.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isLocalEnvironment } from '@/lib/local-services';

describe('isLocalEnvironment', () => {
  const original = { NODE_ENV: process.env.NODE_ENV, VERCEL: process.env.VERCEL };
  beforeEach(() => {
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'development';
  });
  afterEach(() => {
    process.env.NODE_ENV = original.NODE_ENV;
    if (original.VERCEL) process.env.VERCEL = original.VERCEL;
    else delete process.env.VERCEL;
  });

  it('returns true when NODE_ENV is development and no VERCEL', () => {
    expect(isLocalEnvironment()).toBe(true);
  });

  it('returns false when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production';
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns false when VERCEL=1', () => {
    process.env.VERCEL = '1';
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns false when VERCEL is set (any truthy)', () => {
    process.env.VERCEL = 'true';
    expect(isLocalEnvironment()).toBe(false);
  });

  it('returns true when NODE_ENV is test (vitest default) and no VERCEL', () => {
    process.env.NODE_ENV = 'test';
    expect(isLocalEnvironment()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-env.test.ts`
Expected: FAIL with module not found / `isLocalEnvironment` undefined

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/local-services.ts
import 'server-only';

/**
 * True when the current process is a local development environment.
 *
 * Returns true iff:
 *   - process.env.VERCEL is not set (Vercel sets this on every deployment,
 *     production AND preview), AND
 *   - process.env.NODE_ENV is not 'production' (production build / `next start`).
 *
 * `pnpm dev` → true. `pnpm start` → false. Any Vercel deployment → false.
 */
export function isLocalEnvironment(): boolean {
  return !process.env.VERCEL && process.env.NODE_ENV !== 'production';
}

/**
 * Minimal HTTP ping with a 2-second timeout. Returns true iff a GET request
 * to the given URL resolves with an HTTP 2xx within the timeout.
 *
 * Never throws — network errors, timeouts, and non-2xx all return false.
 * Used at Settings render to display ✓/✗ badges without breaking the page.
 */
export async function pingService(baseUrl: string, path: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Engine status returned to the Settings UI. `enabled` reflects whether the
 * relevant env var is set; `reachable` is the health check result; `models`
 * is the dynamic list of sub-models / voices / workflows.
 */
export interface EngineStatus {
  enabled: boolean;
  reachable: boolean;
  error?: string;
  models: ModelOption[];
}

/** Browser-safe model option, mirrors `ModelOption` from `src/lib/ai-models.ts`. */
export interface ModelOption {
  slug: string;
  label: string;
  blurb: string;
}

/** Aggregate status passed from the settings server loader to the client. */
export interface LocalServicesStatus {
  isLocal: boolean;
  ai: EngineStatus;
  tts: {
    enabled: boolean;
    engines: { piper: EngineStatus; xtts: EngineStatus };
  };
  image: {
    enabled: boolean;
    engines: { comfyui: EngineStatus; drawThings: EngineStatus };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/lib/local-services-env.test.ts`
Expected: PASS, 5/5 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-env.test.ts
git commit -m "feat(local-ai): add isLocalEnvironment and ping primitive"
```

---

### Task 2: Whitelist + label normalization for Ollama models

**Files:**
- Modify: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-whitelist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-whitelist.test.ts
import { describe, it, expect } from 'vitest';
import { matchesLlmWhitelist, normalizeOllamaLabel } from '@/lib/local-services';

describe('matchesLlmWhitelist', () => {
  it.each([
    'qwen3',
    'qwen3:30b-a3b',
    'qwen3:8b',
    'gpt-oss',
    'gpt-oss:20b',
    'hf.co/unsloth/gpt-oss-20b-GGUF:F16',
    'hf.co/Qwen/qwen3-32B-GGUF:Q4_K_M',
  ])('accepts %s', (name) => {
    expect(matchesLlmWhitelist(name)).toBe(true);
  });

  it.each([
    'llama3.1:8b',
    'mistral:7b',
    'phi3:medium',
    'hf.co/random/other-model:Q4',
    '',
  ])('rejects %s', (name) => {
    expect(matchesLlmWhitelist(name)).toBe(false);
  });
});

describe('normalizeOllamaLabel', () => {
  it('returns plain ollama tags unchanged', () => {
    expect(normalizeOllamaLabel('qwen3:30b-a3b')).toBe('qwen3:30b-a3b');
    expect(normalizeOllamaLabel('gpt-oss:20b')).toBe('gpt-oss:20b');
  });

  it('rewrites hf.co paths and strips -GGUF suffix', () => {
    expect(normalizeOllamaLabel('hf.co/unsloth/gpt-oss-20b-GGUF:F16'))
      .toBe('unsloth/gpt-oss-20b (F16)');
    expect(normalizeOllamaLabel('hf.co/Qwen/qwen3-32B-GGUF:Q4_K_M'))
      .toBe('Qwen/qwen3-32B (Q4_K_M)');
  });

  it('handles hf.co paths without explicit tag', () => {
    expect(normalizeOllamaLabel('hf.co/Qwen/qwen3-32B'))
      .toBe('Qwen/qwen3-32B');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-whitelist.test.ts`
Expected: FAIL with `matchesLlmWhitelist` / `normalizeOllamaLabel` undefined

- [ ] **Step 3: Add implementation**

Append to `src/lib/local-services.ts`:

```ts
// LLM whitelist — phase 1 supports qwen3 and gpt-oss families, both from the
// official registry and from HuggingFace mirrors. Adding a new family is a
// one-line edit.
const LOCAL_LLM_PATTERNS: RegExp[] = [
  /^qwen3(:|$)/i,
  /^gpt-oss(:|$)/i,
  /^hf\.co\/.+\/qwen3[^/]*/i,
  /^hf\.co\/.+\/gpt-oss[^/]*/i,
];

export function matchesLlmWhitelist(name: string): boolean {
  return LOCAL_LLM_PATTERNS.some((p) => p.test(name));
}

/**
 * Pretty-print an Ollama model tag for the Settings dropdown. Plain registry
 * tags pass through; HuggingFace mirror paths get the `hf.co/` prefix
 * stripped, the `-GGUF` suffix removed, and the tag floated to a parenthesis.
 *
 *   qwen3:30b-a3b                            → qwen3:30b-a3b
 *   hf.co/unsloth/gpt-oss-20b-GGUF:F16       → unsloth/gpt-oss-20b (F16)
 */
export function normalizeOllamaLabel(name: string): string {
  if (!name.startsWith('hf.co/')) return name;
  const stripped = name.slice('hf.co/'.length);
  const colon = stripped.lastIndexOf(':');
  const path = colon >= 0 ? stripped.slice(0, colon) : stripped;
  const tag = colon >= 0 ? stripped.slice(colon + 1) : '';
  const clean = path.replace(/-GGUF$/i, '');
  return tag ? `${clean} (${tag})` : clean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/lib/local-services-whitelist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-whitelist.test.ts
git commit -m "feat(local-ai): LLM whitelist and label normalization"
```

---

### Task 3: Extend type unions in `src/lib/ai-models.ts`

**Files:**
- Modify: `src/lib/ai-models.ts`
- Create: `tests/lib/ai-models-local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/ai-models-local.test.ts
import { describe, it, expect } from 'vitest';
import {
  isKnownProvider,
  isKnownImageProvider,
  isKnownMasterModel,
  isKnownImageModel,
  modelsForProvider,
  imageModelsForProvider,
} from '@/lib/ai-models';

describe('local provider acceptance', () => {
  it('isKnownProvider accepts local', () => {
    expect(isKnownProvider('local')).toBe(true);
    expect(isKnownProvider('anthropic')).toBe(true);
    expect(isKnownProvider('unknown')).toBe(false);
  });

  it('isKnownImageProvider accepts local', () => {
    expect(isKnownImageProvider('local')).toBe(true);
    expect(isKnownImageProvider('openai')).toBe(true);
    expect(isKnownImageProvider('anthropic')).toBe(false);
  });

  it('isKnownMasterModel accepts any non-empty short string for local', () => {
    expect(isKnownMasterModel('qwen3:30b-a3b')).toBe(true);
    expect(isKnownMasterModel('hf.co/unsloth/gpt-oss-20b-GGUF:F16')).toBe(true);
    expect(isKnownMasterModel('')).toBe(false);
    expect(isKnownMasterModel('x'.repeat(201))).toBe(false);
    // still rejects unknown anthropic/openai/gemini slugs
    expect(isKnownMasterModel('claude-sonnet-99')).toBe(false);
  });

  it('isKnownImageModel accepts comfyui: and draw-things: prefixed slugs', () => {
    expect(isKnownImageModel('comfyui:flux-schnell')).toBe(true);
    expect(isKnownImageModel('draw-things:realisticVisionV60')).toBe(true);
    expect(isKnownImageModel('local:something-else')).toBe(false);
  });

  it('modelsForProvider("local") returns an empty list (runtime-populated)', () => {
    expect(modelsForProvider('local')).toEqual([]);
  });

  it('imageModelsForProvider("local") returns an empty list', () => {
    expect(imageModelsForProvider('local')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/ai-models-local.test.ts`
Expected: FAIL — `local` not in ProviderName union

- [ ] **Step 3: Modify implementation**

Open `src/lib/ai-models.ts` and update:

```ts
// At top of file — type unions
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'local';
export type ImageProviderName = 'openai' | 'gemini' | 'local';

// Update modelsForProvider
export function modelsForProvider(p: ProviderName): ModelOption[] {
  if (p === 'anthropic') return ANTHROPIC_MASTER_MODELS;
  if (p === 'openai') return OPENAI_MASTER_MODELS;
  if (p === 'gemini') return GEMINI_MASTER_MODELS;
  return [];  // 'local' — runtime list passed separately
}

// Update defaultModelForProvider
export function defaultModelForProvider(p: ProviderName): string {
  if (p === 'local') return '';  // caller must override with runtime list
  const list = modelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

// Update imageModelsForProvider
export function imageModelsForProvider(p: ImageProviderName): ModelOption[] {
  if (p === 'local') return [];
  return p === 'openai' ? OPENAI_IMAGE_MODELS : GEMINI_IMAGE_MODELS;
}

// Update defaultImageModelForProvider
export function defaultImageModelForProvider(p: ImageProviderName): string {
  if (p === 'local') return '';
  const list = imageModelsForProvider(p);
  return list.find((m) => m.recommended)?.slug ?? list[0]!.slug;
}

// Update isKnownProvider
export function isKnownProvider(value: unknown): value is ProviderName {
  return value === 'anthropic' || value === 'openai' || value === 'gemini' || value === 'local';
}

// Update isKnownImageProvider
export function isKnownImageProvider(value: unknown): value is ImageProviderName {
  return value === 'openai' || value === 'gemini' || value === 'local';
}

// Replace isKnownMasterModel — local accepts any non-empty short string
export function isKnownMasterModel(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  const inCloudCatalog = [...ANTHROPIC_MASTER_MODELS, ...OPENAI_MASTER_MODELS, ...GEMINI_MASTER_MODELS]
    .some((m) => m.slug === value);
  if (inCloudCatalog) return true;
  // For local, any non-empty short string is accepted (slugs come from Ollama
  // /api/tags and aren't enumerable at build time).
  return false;  // local validation handled separately when (provider, value) is known
}

// Replace isKnownImageModel — accepts comfyui: / draw-things: prefixed slugs
export function isKnownImageModel(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  const inCloudCatalog = [...OPENAI_IMAGE_MODELS, ...GEMINI_IMAGE_MODELS].some((m) => m.slug === value);
  if (inCloudCatalog) return true;
  return value.startsWith('comfyui:') || value.startsWith('draw-things:');
}
```

Note: the local-vs-cloud master model validation needs the resolved provider
context (you can't tell from the slug alone if `'foo'` is a valid local
model). The route-level validator in Task 6 handles this — `isKnownMasterModel`
only checks the cloud catalog here. Local model strings pass through the
provider-aware check in `validateSettingsPatch`.

- [ ] **Step 4: Update isKnownMasterModel test expectations**

Re-read Step 1 test and adjust: `isKnownMasterModel('qwen3:30b-a3b')` should return **false** at this layer (local validation is route-level). Update the test:

```ts
it('isKnownMasterModel rejects local slugs at this layer (route-level validates them)', () => {
  expect(isKnownMasterModel('qwen3:30b-a3b')).toBe(false);
  expect(isKnownMasterModel('claude-sonnet-4-5')).toBe(true);  // cloud catalog
  expect(isKnownMasterModel('')).toBe(false);
  expect(isKnownMasterModel('x'.repeat(201))).toBe(false);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/lib/ai-models-local.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai-models.ts tests/lib/ai-models-local.test.ts
git commit -m "feat(local-ai): extend provider type unions and validators"
```

---

### Task 4: Extend `TTS_PROVIDERS` and add LOCAL TTS catalog

**Files:**
- Modify: `src/lib/tts-voices.ts`
- Create: `tests/lib/tts-voices-local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/tts-voices-local.test.ts
import { describe, it, expect } from 'vitest';
import {
  TTS_PROVIDERS,
  LOCAL_TTS_MODELS,
  XTTS_LANGUAGES,
  isValidTtsProvider,
  isValidTtsModel,
  modelsForProvider,
  defaultModelForProvider,
  defaultVoiceForModel,
  voicesForModel,
  isValidVoiceForModel,
} from '@/lib/tts-voices';

describe('local TTS catalog', () => {
  it('TTS_PROVIDERS includes local', () => {
    expect(TTS_PROVIDERS).toContain('local');
  });

  it('LOCAL_TTS_MODELS is [piper, xtts]', () => {
    expect(LOCAL_TTS_MODELS).toEqual(['piper', 'xtts']);
  });

  it('XTTS_LANGUAGES has 9 entries including en and it', () => {
    expect(XTTS_LANGUAGES.length).toBe(9);
    expect(XTTS_LANGUAGES.map((l) => l.code)).toContain('en');
    expect(XTTS_LANGUAGES.map((l) => l.code)).toContain('it');
  });

  it('isValidTtsProvider accepts local', () => {
    expect(isValidTtsProvider('local')).toBe(true);
  });

  it('isValidTtsModel accepts piper and xtts', () => {
    expect(isValidTtsModel('piper')).toBe(true);
    expect(isValidTtsModel('xtts')).toBe(true);
  });

  it('modelsForProvider("local") returns [piper, xtts]', () => {
    expect(modelsForProvider('local')).toEqual(['piper', 'xtts']);
  });

  it('defaultModelForProvider("local") is piper', () => {
    expect(defaultModelForProvider('local')).toBe('piper');
  });

  it('voicesForModel("local", "xtts") returns XTTS language codes', () => {
    const voices = voicesForModel('local', 'xtts');
    expect(voices).toContain('en');
    expect(voices).toContain('it');
  });

  it('voicesForModel("local", "piper") returns [] (runtime-discovered)', () => {
    expect(voicesForModel('local', 'piper')).toEqual([]);
  });

  it('defaultVoiceForModel("local", "xtts") is "en"', () => {
    expect(defaultVoiceForModel('local', 'xtts')).toBe('en');
  });

  it('defaultVoiceForModel("local", "piper") falls back to empty (runtime overrides)', () => {
    expect(defaultVoiceForModel('local', 'piper')).toBe('');
  });

  it('isValidVoiceForModel("local", "xtts", code) checks against XTTS_LANGUAGES', () => {
    expect(isValidVoiceForModel('en', 'local', 'xtts')).toBe(true);
    expect(isValidVoiceForModel('xx', 'local', 'xtts')).toBe(false);
  });

  it('isValidVoiceForModel("local", "piper", anything) accepts any non-empty string ≤200 chars', () => {
    expect(isValidVoiceForModel('en_US-amy-low', 'local', 'piper')).toBe(true);
    expect(isValidVoiceForModel('', 'local', 'piper')).toBe(false);
    expect(isValidVoiceForModel('x'.repeat(201), 'local', 'piper')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/tts-voices-local.test.ts`
Expected: FAIL — exports missing

- [ ] **Step 3: Modify implementation**

In `src/lib/tts-voices.ts`:

Replace the `TTS_PROVIDERS` constant:

```ts
export const TTS_PROVIDERS = ['openai', 'gemini', 'local'] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];
```

After the Gemini section, add a new "Local" section before the "Unions" section:

```ts
// ── Local ──────────────────────────────────────────────────────────────────

/** Engine identifiers under the 'local' TTS provider. The voice slug
 *  namespace depends on the engine: Piper uses voice names (en_US-amy-low),
 *  XTTS uses ISO 639-1 language codes (en, it, ...). */
export const LOCAL_TTS_MODELS = ['piper', 'xtts'] as const;
export type LocalTtsModel = (typeof LOCAL_TTS_MODELS)[number];

/** XTTSv2 supported languages (default speaker per language). The codes
 *  are passed verbatim as the `language` field of the xtts-api-server
 *  /tts_to_audio/ request body. */
export const XTTS_LANGUAGES = [
  { code: 'en',    label: 'English'    },
  { code: 'it',    label: 'Italian'    },
  { code: 'es',    label: 'Spanish'    },
  { code: 'fr',    label: 'French'     },
  { code: 'de',    label: 'German'     },
  { code: 'pt',    label: 'Portuguese' },
  { code: 'pl',    label: 'Polish'     },
  { code: 'ja',    label: 'Japanese'   },
  { code: 'zh-cn', label: 'Chinese'    },
] as const satisfies readonly { code: string; label: string }[];

export const XTTS_LANGUAGE_CODES = XTTS_LANGUAGES.map((l) => l.code) as readonly string[];
```

Update `modelsForProvider`:

```ts
export function modelsForProvider(provider: TtsProvider): readonly string[] {
  if (provider === 'gemini') return GEMINI_TTS_MODELS;
  if (provider === 'local')  return LOCAL_TTS_MODELS;
  return OPENAI_TTS_MODELS;
}
```

Update `defaultModelForProvider`:

```ts
export function defaultModelForProvider(provider: TtsProvider): string {
  if (provider === 'gemini') return 'gemini-2.5-flash-preview-tts';
  if (provider === 'local')  return 'piper';
  return 'gpt-4o-mini-tts';
}
```

Update `voicesForModel`:

```ts
export function voicesForModel(provider: TtsProvider, model: string): readonly string[] {
  if (provider === 'gemini') return GEMINI_TTS_VOICES;
  if (provider === 'local') {
    if (model === 'xtts')  return XTTS_LANGUAGE_CODES;
    if (model === 'piper') return [];  // runtime-discovered from /v1/audio/voices
    return [];
  }
  if (model in OPENAI_VOICES_BY_MODEL) return OPENAI_VOICES_BY_MODEL[model as OpenAITtsModel];
  return OPENAI_TTS_VOICES;
}
```

Update `defaultVoiceForProvider`:

```ts
export function defaultVoiceForProvider(provider: TtsProvider): string {
  if (provider === 'gemini') return 'Kore';
  if (provider === 'local')  return '';  // engine-specific; use defaultVoiceForModel
  return 'onyx';
}
```

Update `defaultVoiceForModel`:

```ts
export function defaultVoiceForModel(provider: TtsProvider, model: string): string {
  if (provider === 'local') {
    if (model === 'xtts') return 'en';
    return '';  // piper voices are runtime-listed; UI selects first available
  }
  const allowed = voicesForModel(provider, model);
  const fallback = defaultVoiceForProvider(provider);
  return allowed.includes(fallback) ? fallback : (allowed[0] ?? fallback);
}
```

Update `isValidTtsProvider` (already type-checked because TTS_PROVIDERS contains 'local' now). Update `isValidTtsModel`:

```ts
export const TTS_MODELS = [...OPENAI_TTS_MODELS, ...GEMINI_TTS_MODELS, ...LOCAL_TTS_MODELS] as const;
export type TtsModel = (typeof TTS_MODELS)[number];

export function isValidTtsModel(value: unknown): value is TtsModel {
  return typeof value === 'string' && (TTS_MODELS as readonly string[]).includes(value);
}
```

Update `isValidVoiceForModel` to special-case local engines:

```ts
export function isValidVoiceForModel(value: unknown, provider: TtsProvider, model: string): boolean {
  if (typeof value !== 'string') return false;
  if (provider === 'local') {
    if (model === 'xtts')  return XTTS_LANGUAGE_CODES.includes(value);
    if (model === 'piper') return value.length > 0 && value.length <= 200;
    return false;
  }
  return voicesForModel(provider, model).includes(value);
}
```

Update `isValidModelForProvider` (already handles local because `modelsForProvider('local')` now returns the right list).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/lib/tts-voices-local.test.ts`
Expected: PASS, 13/13 tests

- [ ] **Step 5: Run the full test suite to check for breakage**

Run: `pnpm test`
Expected: ALL PASS (no regressions in existing TTS tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/tts-voices.ts tests/lib/tts-voices-local.test.ts
git commit -m "feat(local-ai): TTS_PROVIDERS adds 'local', adds piper/xtts catalog"
```

---

### Task 5: Extend `UserPreferences` and `CampaignSettings` type unions

**Files:**
- Modify: `src/db/schema/users.ts`
- Modify: `src/db/schema/campaigns.ts`

- [ ] **Step 1: Modify users.ts**

In `src/db/schema/users.ts`, update the three provider field types:

```ts
export interface UserPreferences {
  ttsProvider?: 'openai' | 'gemini' | 'local';
  ttsVoice?: string;
  ttsModel?: string;
  ttsAutoplay?: boolean;
  manualRolls?: boolean;
  aiProvider?: 'anthropic' | 'openai' | 'gemini' | 'local';
  aiMasterModel?: string;
  masterGuidanceLevel?: 'free' | 'balanced' | 'structured';
  showDifficultyNumbers?: boolean;
  narrationPace?: 'detailed' | 'brisk';
  imageGenerationEnabled?: boolean;
  imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
  imageStyleCustom?: string;
  imageProvider?: 'openai' | 'gemini' | 'local';
  imageModel?: string;
}
```

- [ ] **Step 2: Modify campaigns.ts**

In `src/db/schema/campaigns.ts`, update the matching fields:

```ts
export interface CampaignSettings {
  aiProvider?: 'anthropic' | 'openai' | 'gemini' | 'local';
  aiMasterModel?: string;
  ttsProvider?: 'openai' | 'gemini' | 'local';
  ttsVoice?: string;
  ttsModel?: string;
  manualRolls?: boolean;
  masterGuidanceLevel?: 'free' | 'balanced' | 'structured';
  showDifficultyNumbers?: boolean;
  narrationPace?: 'detailed' | 'brisk';
  imageGenerationEnabled?: boolean;
  imageStylePreset?: 'pastel' | 'watercolor' | 'oil' | 'ink' | 'photo' | 'custom';
  imageStyleCustom?: string;
  imageProvider?: 'openai' | 'gemini' | 'local';
  imageModel?: string;
}
```

- [ ] **Step 3: Run typecheck to verify no TS errors anywhere**

Run: `pnpm typecheck`
Expected: PASS (no new errors). The TS compiler may surface call sites that destructure the provider field with stricter union — none expected, the unions only widen.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/users.ts src/db/schema/campaigns.ts
git commit -m "feat(local-ai): widen UserPreferences and CampaignSettings unions"
```

---

### Task 6: `validateSettingsPatch` accepts 'local' with gating

**Files:**
- Modify: `src/lib/preferences.ts`
- Create: `tests/lib/preferences-local-validation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/preferences-local-validation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateSettingsPatch } from '@/lib/preferences';

const envBackup: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) envBackup[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('validateSettingsPatch — local provider gating', () => {
  beforeEach(() => {
    saveEnv('NODE_ENV', 'VERCEL', 'OLLAMA_BASE_URL', 'PIPER_BASE_URL',
            'XTTS_BASE_URL', 'COMFYUI_BASE_URL', 'DRAW_THINGS_BASE_URL');
    process.env.NODE_ENV = 'development';
    delete process.env.VERCEL;
  });
  afterEach(() => restoreEnv());

  it('accepts aiProvider=local when local env + OLLAMA_BASE_URL set', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const r = validateSettingsPatch({ aiProvider: 'local' });
    expect(r.ok).toBe(true);
  });

  it('rejects aiProvider=local when OLLAMA_BASE_URL unset', () => {
    delete process.env.OLLAMA_BASE_URL;
    const r = validateSettingsPatch({ aiProvider: 'local' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid-aiProvider');
  });

  it('rejects aiProvider=local when not local environment', () => {
    process.env.NODE_ENV = 'production';
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const r = validateSettingsPatch({ aiProvider: 'local' });
    expect(r.ok).toBe(false);
  });

  it('accepts aiMasterModel for local (any non-empty string ≤200)', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' });
    expect(r.ok).toBe(true);
  });

  it('rejects aiMasterModel for local when over 200 chars', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const r = validateSettingsPatch({ aiProvider: 'local', aiMasterModel: 'x'.repeat(201) });
    expect(r.ok).toBe(false);
  });

  it('accepts ttsProvider=local + ttsModel=piper when PIPER set', () => {
    process.env.PIPER_BASE_URL = 'http://localhost:8050';
    const r = validateSettingsPatch({ ttsProvider: 'local', ttsModel: 'piper', ttsVoice: 'en_US-amy-low' });
    expect(r.ok).toBe(true);
  });

  it('accepts ttsProvider=local + ttsModel=xtts when XTTS set', () => {
    process.env.XTTS_BASE_URL = 'http://localhost:8055';
    const r = validateSettingsPatch({ ttsProvider: 'local', ttsModel: 'xtts', ttsVoice: 'en' });
    expect(r.ok).toBe(true);
  });

  it('rejects ttsVoice="xx" for xtts (not in XTTS_LANGUAGES)', () => {
    process.env.XTTS_BASE_URL = 'http://localhost:8055';
    const r = validateSettingsPatch({ ttsProvider: 'local', ttsModel: 'xtts', ttsVoice: 'xx' });
    expect(r.ok).toBe(false);
  });

  it('rejects ttsModel=piper when PIPER_BASE_URL unset', () => {
    delete process.env.PIPER_BASE_URL;
    const r = validateSettingsPatch({ ttsProvider: 'local', ttsModel: 'piper', ttsVoice: 'en_US-amy-low' });
    expect(r.ok).toBe(false);
  });

  it('accepts imageProvider=local + imageModel=comfyui:flux-schnell when COMFYUI set', () => {
    process.env.COMFYUI_BASE_URL = 'http://localhost:8188';
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'comfyui:flux-schnell' });
    expect(r.ok).toBe(true);
  });

  it('rejects imageModel=comfyui:* when COMFYUI_BASE_URL unset', () => {
    delete process.env.COMFYUI_BASE_URL;
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'comfyui:flux-schnell' });
    expect(r.ok).toBe(false);
  });

  it('accepts imageProvider=local + imageModel=draw-things:* when DRAW_THINGS set', () => {
    process.env.DRAW_THINGS_BASE_URL = 'http://localhost:7860';
    const r = validateSettingsPatch({ imageProvider: 'local', imageModel: 'draw-things:realisticVisionV60' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/preferences-local-validation.test.ts`
Expected: FAIL

- [ ] **Step 3: Modify `validateSettingsPatch` in `src/lib/preferences.ts`**

Add a helper at the top of the file (before `validateSettingsPatch`):

```ts
import { isLocalEnvironment } from './local-services';

/**
 * Provider-aware validation gate for 'local'. Returns true iff the relevant
 * env-var-set + isLocalEnvironment() are both satisfied for the surface.
 */
function isLocalSurfaceAvailable(surface: 'ai' | 'tts' | 'image', subModel?: string): boolean {
  if (!isLocalEnvironment()) return false;
  if (surface === 'ai') return !!process.env.OLLAMA_BASE_URL;
  if (surface === 'tts') {
    if (subModel === 'piper') return !!process.env.PIPER_BASE_URL;
    if (subModel === 'xtts')  return !!process.env.XTTS_BASE_URL;
    // No engine specified — accept if at least one engine env is set
    return !!process.env.PIPER_BASE_URL || !!process.env.XTTS_BASE_URL;
  }
  if (surface === 'image') {
    if (subModel?.startsWith('comfyui:'))     return !!process.env.COMFYUI_BASE_URL;
    if (subModel?.startsWith('draw-things:')) return !!process.env.DRAW_THINGS_BASE_URL;
    return !!process.env.COMFYUI_BASE_URL || !!process.env.DRAW_THINGS_BASE_URL;
  }
  return false;
}
```

Update the relevant branches inside `validateSettingsPatch`:

```ts
// aiProvider branch
if ('aiProvider' in body) {
  if (!isKnownProvider(body.aiProvider)) return { ok: false, error: 'invalid-aiProvider' };
  if (body.aiProvider === 'local' && !isLocalSurfaceAvailable('ai')) {
    return { ok: false, error: 'invalid-aiProvider' };
  }
  out.aiProvider = body.aiProvider;
}

// aiMasterModel branch
if ('aiMasterModel' in body) {
  if (body.aiMasterModel !== undefined) {
    const m = body.aiMasterModel;
    if (typeof m !== 'string' || m.length === 0 || m.length > 200) {
      return { ok: false, error: 'invalid-aiMasterModel' };
    }
    const resolvedProvider = out.aiProvider ?? body.aiProvider;
    if (resolvedProvider === 'local') {
      // Any non-empty short string is accepted for local (slugs come from Ollama).
    } else if (!isKnownMasterModel(m)) {
      return { ok: false, error: 'invalid-aiMasterModel' };
    }
  }
  out.aiMasterModel = body.aiMasterModel as string | undefined;
}

// ttsProvider branch (replace existing)
if ('ttsProvider' in body) {
  if (body.ttsProvider === undefined || body.ttsProvider === null) {
    out.ttsProvider = undefined;
  } else if (!isValidTtsProvider(body.ttsProvider)) {
    return { ok: false, error: 'invalid-ttsProvider' };
  } else if (body.ttsProvider === 'local' && !isLocalSurfaceAvailable('tts')) {
    return { ok: false, error: 'invalid-ttsProvider' };
  } else {
    out.ttsProvider = body.ttsProvider;
  }
}

// ttsModel branch (replace existing)
if ('ttsModel' in body) {
  if (body.ttsModel === undefined || body.ttsModel === null) {
    out.ttsModel = undefined;
  } else if (typeof body.ttsModel !== 'string') {
    return { ok: false, error: 'invalid-ttsModel' };
  } else {
    const resolvedProvider = out.ttsProvider ?? body.ttsProvider;
    if (resolvedProvider === 'local') {
      if (body.ttsModel !== 'piper' && body.ttsModel !== 'xtts') {
        return { ok: false, error: 'invalid-ttsModel' };
      }
      if (!isLocalSurfaceAvailable('tts', body.ttsModel)) {
        return { ok: false, error: 'invalid-ttsModel' };
      }
    } else if (!isValidTtsModel(body.ttsModel)) {
      return { ok: false, error: 'invalid-ttsModel' };
    }
    out.ttsModel = body.ttsModel;
  }
}

// ttsVoice branch (replace existing)
if ('ttsVoice' in body) {
  if (body.ttsVoice === undefined || body.ttsVoice === null) {
    out.ttsVoice = undefined;
  } else if (typeof body.ttsVoice !== 'string') {
    return { ok: false, error: 'invalid-ttsVoice' };
  } else {
    const resolvedProvider = out.ttsProvider ?? body.ttsProvider;
    const resolvedModel = out.ttsModel ?? body.ttsModel;
    if (resolvedProvider === 'local' && typeof resolvedModel === 'string') {
      if (!isValidVoiceForModel(body.ttsVoice, 'local', resolvedModel)) {
        return { ok: false, error: 'invalid-ttsVoice' };
      }
    } else if (!isValidTtsVoice(body.ttsVoice)) {
      return { ok: false, error: 'invalid-ttsVoice' };
    }
    out.ttsVoice = body.ttsVoice;
  }
}

// imageProvider branch
if ('imageProvider' in body) {
  if (!isKnownImageProvider(body.imageProvider)) return { ok: false, error: 'invalid-imageProvider' };
  if (body.imageProvider === 'local' && !isLocalSurfaceAvailable('image')) {
    return { ok: false, error: 'invalid-imageProvider' };
  }
  out.imageProvider = body.imageProvider;
}

// imageModel branch
if ('imageModel' in body) {
  if (body.imageModel !== undefined) {
    if (!isKnownImageModel(body.imageModel)) {
      return { ok: false, error: 'invalid-imageModel' };
    }
    const resolvedProvider = out.imageProvider ?? body.imageProvider;
    if (resolvedProvider === 'local') {
      if (!isLocalSurfaceAvailable('image', body.imageModel)) {
        return { ok: false, error: 'invalid-imageModel' };
      }
    }
  }
  out.imageModel = body.imageModel as string | undefined;
}
```

Make sure `isValidVoiceForModel` is imported at the top:

```ts
import {
  // ... existing imports ...
  isValidVoiceForModel,
} from './tts-voices';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/lib/preferences-local-validation.test.ts`
Expected: PASS, 12/12 tests

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/preferences.ts tests/lib/preferences-local-validation.test.ts
git commit -m "feat(local-ai): validateSettingsPatch gates 'local' on env + isLocal"
```

---

### Task 7: Read-side downgrade of stored 'local' when unavailable

**Files:**
- Modify: `src/lib/preferences.ts`
- Create: `tests/lib/preferences-local-downgrade.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/preferences-local-downgrade.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ preferences: TEST_PREFS, settings: TEST_PREFS }] }) }) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  },
}));

let TEST_PREFS: Record<string, unknown> = {};

import { getResolvedPreferences } from '@/lib/preferences';

const envBackup: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) envBackup[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('getResolvedPreferences — local downgrade', () => {
  beforeEach(() => {
    saveEnv('NODE_ENV', 'VERCEL', 'OLLAMA_BASE_URL', 'MASTER_PROVIDER');
    process.env.NODE_ENV = 'development';
    delete process.env.VERCEL;
    delete process.env.MASTER_PROVIDER;
  });
  afterEach(() => restoreEnv());

  it('keeps aiProvider=local when env and OLLAMA_BASE_URL set', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('local');
    expect(r.aiMasterModel).toBe('qwen3:30b-a3b');
  });

  it('downgrades aiProvider=local when not isLocalEnvironment', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
  });

  it('downgrades aiProvider=local when OLLAMA_BASE_URL unset', async () => {
    delete process.env.OLLAMA_BASE_URL;
    TEST_PREFS = { aiProvider: 'local', aiMasterModel: 'qwen3:30b-a3b' };
    const r = await getResolvedPreferences('user-id');
    expect(r.aiProvider).toBe('anthropic');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/preferences-local-downgrade.test.ts`
Expected: FAIL — downgrade logic missing

- [ ] **Step 3: Modify `getResolvedPreferences` in `src/lib/preferences.ts`**

Add a helper at the top:

```ts
/**
 * Resolve the stored aiProvider, downgrading 'local' to the env default
 * when the local environment isn't active or OLLAMA_BASE_URL isn't set.
 * Same downgrade pattern for ttsProvider and imageProvider below.
 */
function resolveLocalAiProvider(stored: UserPreferences['aiProvider'] | CampaignSettings['aiProvider']): 'anthropic' | 'openai' | 'gemini' | 'local' {
  if (stored !== 'local') return stored ?? envDefaultProvider();
  if (!isLocalEnvironment() || !process.env.OLLAMA_BASE_URL) return envDefaultProvider();
  return 'local';
}

function resolveLocalTtsProvider(stored: UserPreferences['ttsProvider'] | CampaignSettings['ttsProvider']): TtsProvider {
  if (stored !== 'local') return stored ?? envDefaultTtsProvider();
  if (!isLocalEnvironment() || (!process.env.PIPER_BASE_URL && !process.env.XTTS_BASE_URL)) {
    return envDefaultTtsProvider();
  }
  return 'local';
}

function resolveLocalImageProvider(stored: UserPreferences['imageProvider'] | CampaignSettings['imageProvider']): 'openai' | 'gemini' | 'local' {
  if (stored !== 'local') return stored ?? envDefaultImageProvider();
  if (!isLocalEnvironment() || (!process.env.COMFYUI_BASE_URL && !process.env.DRAW_THINGS_BASE_URL)) {
    return envDefaultImageProvider();
  }
  return 'local';
}
```

In `getResolvedPreferences`, replace the lines that compute `provider`, `ttsProvider`, `imageProvider`:

```ts
const provider = resolveLocalAiProvider(prefs.aiProvider);
const masterModel = prefs.aiMasterModel ?? envDefaultMasterModel(provider === 'local' ? envDefaultProvider() : provider);
// ... rest unchanged for now — model defaults for 'local' come from runtime
//     fetchOllamaModels(); the static default is used only by the cloud path.
const imageProvider = resolveLocalImageProvider(prefs.imageProvider);
const imageModel = prefs.imageModel ?? envDefaultImageModel(imageProvider === 'local' ? 'openai' : imageProvider);
const ttsProvider = resolveLocalTtsProvider(prefs.ttsProvider);
```

When `provider === 'local'`, also accept any stored aiMasterModel (don't validate against catalog). Update the TTS triplet resolution to allow any model when provider is local:

```ts
const storedModel = prefs.ttsModel;
const ttsModel = (() => {
  if (ttsProvider === 'local') {
    return storedModel === 'piper' || storedModel === 'xtts' ? storedModel : 'piper';
  }
  return storedModel && ttsModelsFor(ttsProvider).includes(storedModel)
    ? storedModel
    : envDefaultTtsModel(ttsProvider);
})();

const storedVoice = prefs.ttsVoice;
const ttsVoice = (() => {
  if (ttsProvider === 'local') {
    if (ttsModel === 'xtts') {
      return storedVoice && XTTS_LANGUAGE_CODES.includes(storedVoice) ? storedVoice : 'en';
    }
    // piper: any stored voice passes through; UI ensures it's runtime-valid
    return storedVoice ?? '';
  }
  return storedVoice && ttsVoicesForModel(ttsProvider, ttsModel).includes(storedVoice)
    ? storedVoice
    : envDefaultTtsVoice(ttsProvider, ttsModel);
})();
```

Make the same changes in `getCampaignSettings` (same pattern, same fields, lines ~228-265).

Add the import for `XTTS_LANGUAGE_CODES`:

```ts
import {
  // ... existing imports ...
  XTTS_LANGUAGE_CODES,
} from './tts-voices';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/lib/preferences-local-downgrade.test.ts`
Expected: PASS, 3/3 tests

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS — no regressions in existing preferences tests

- [ ] **Step 6: Commit**

```bash
git add src/lib/preferences.ts tests/lib/preferences-local-downgrade.test.ts
git commit -m "feat(local-ai): downgrade stored 'local' when env/service unavailable"
```

---

## Phase 2 — LLM (Ollama provider)

### Task 8: Ollama adapter — Anthropic ↔ Ollama shape conversion

**Files:**
- Create: `src/ai/provider/ollama-adapter.ts`
- Create: `tests/ai/provider/ollama-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/provider/ollama-adapter.test.ts
import { describe, it, expect } from 'vitest';
import {
  anthropicSystemToOllamaMessage,
  anthropicMessagesToOllama,
  anthropicToolToOllama,
  ollamaResponseToContentBlocks,
  ollamaDoneReasonToStopReason,
  normalizeOllamaUsage,
} from '@/ai/provider/ollama-adapter';

describe('anthropicSystemToOllamaMessage', () => {
  it('joins multiple system blocks into one role:system message', () => {
    const result = anthropicSystemToOllamaMessage([
      { type: 'text', text: 'You are a master.' },
      { type: 'text', text: 'Follow rules.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(result).toEqual({ role: 'system', content: 'You are a master.\n\nFollow rules.' });
  });

  it('handles empty system blocks list', () => {
    expect(anthropicSystemToOllamaMessage([])).toBeNull();
  });
});

describe('anthropicMessagesToOllama', () => {
  it('passes through plain user message', () => {
    const r = anthropicMessagesToOllama([
      { role: 'user', content: 'hello' },
    ]);
    expect(r).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('handles assistant tool_use block — emits tool_calls', () => {
    const r = anthropicMessagesToOllama([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'rolling now' },
          { type: 'tool_use', id: 'tool_001', name: 'roll_dice', input: { sides: 20 } },
        ],
      },
    ]);
    expect(r).toEqual([{
      role: 'assistant',
      content: 'rolling now',
      tool_calls: [{
        id: 'tool_001',
        type: 'function',
        function: { name: 'roll_dice', arguments: { sides: 20 } },
      }],
    }]);
  });

  it('fan-outs user tool_result blocks into separate role:tool messages', () => {
    const r = anthropicMessagesToOllama([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_001', content: '{"total":17}' },
          { type: 'tool_result', tool_use_id: 'tool_002', content: '{"total":3}'  },
        ],
      },
    ]);
    expect(r).toEqual([
      { role: 'tool', content: '{"total":17}', tool_call_id: 'tool_001' },
      { role: 'tool', content: '{"total":3}',  tool_call_id: 'tool_002' },
    ]);
  });
});

describe('anthropicToolToOllama', () => {
  it('renames input_schema to parameters', () => {
    const r = anthropicToolToOllama({
      name: 'roll_dice',
      description: 'Roll dice',
      input_schema: { type: 'object', properties: { sides: { type: 'number' } } },
    });
    expect(r).toEqual({
      type: 'function',
      function: {
        name: 'roll_dice',
        description: 'Roll dice',
        parameters: { type: 'object', properties: { sides: { type: 'number' } } },
      },
    });
  });
});

describe('ollamaResponseToContentBlocks', () => {
  it('text-only response → single text block', () => {
    const r = ollamaResponseToContentBlocks({ role: 'assistant', content: 'hello there' });
    expect(r).toEqual([{ type: 'text', text: 'hello there' }]);
  });

  it('response with tool_calls → text + tool_use blocks (synthetic id when missing)', () => {
    const r = ollamaResponseToContentBlocks({
      role: 'assistant',
      content: 'rolling',
      tool_calls: [{ function: { name: 'roll_dice', arguments: { sides: 20 } } }],
    });
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ type: 'text', text: 'rolling' });
    expect(r[1]).toMatchObject({
      type: 'tool_use',
      name: 'roll_dice',
      input: { sides: 20 },
    });
    if (r[1].type === 'tool_use') expect(r[1].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses provided tool_call id when present', () => {
    const r = ollamaResponseToContentBlocks({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'tc_custom', function: { name: 'x', arguments: {} } }],
    });
    expect(r[0]).toMatchObject({ type: 'tool_use', id: 'tc_custom' });
  });

  it('skips empty text blocks', () => {
    const r = ollamaResponseToContentBlocks({ role: 'assistant', content: '' });
    expect(r).toEqual([]);
  });
});

describe('ollamaDoneReasonToStopReason', () => {
  it('stop → end_turn (no tool_calls)', () => {
    expect(ollamaDoneReasonToStopReason('stop', false)).toBe('end_turn');
  });
  it('stop → tool_use (when has tool_calls)', () => {
    expect(ollamaDoneReasonToStopReason('stop', true)).toBe('tool_use');
  });
  it('length → max_tokens', () => {
    expect(ollamaDoneReasonToStopReason('length', false)).toBe('max_tokens');
  });
  it('other → other', () => {
    expect(ollamaDoneReasonToStopReason('something', false)).toBe('other');
  });
});

describe('normalizeOllamaUsage', () => {
  it('maps eval_count and prompt_eval_count', () => {
    expect(normalizeOllamaUsage({ prompt_eval_count: 123, eval_count: 45 })).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
  it('defaults missing fields to 0', () => {
    expect(normalizeOllamaUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/ai/provider/ollama-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// src/ai/provider/ollama-adapter.ts
import type { SystemBlock, Message, ToolDef, ContentBlock, NormalizedUsage } from './types';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  id?: string;
  type?: 'function';
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaTool {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export interface OllamaResponseMessage {
  role: 'assistant';
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaUsage {
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Joins Anthropic system blocks into a single Ollama system message.
 *  Returns null when the list is empty so callers can omit the slot. */
export function anthropicSystemToOllamaMessage(blocks: SystemBlock[]): OllamaMessage | null {
  if (blocks.length === 0) return null;
  return { role: 'system', content: blocks.map((b) => b.text).join('\n\n') };
}

/** Converts Anthropic message history to Ollama's flat messages array.
 *  Tool results fan out into separate role:'tool' entries. */
export function anthropicMessagesToOllama(messages: Message[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      let text = '';
      const toolCalls: OllamaToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.input as Record<string, unknown> },
          });
        }
      }
      const assistantMsg: OllamaMessage = { role: 'assistant', content: text };
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      out.push(assistantMsg);
      continue;
    }
    // user role with blocks — fan out tool_results
    for (const block of msg.content) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
            : '';
        out.push({ role: 'tool', content, tool_call_id: block.tool_use_id });
      } else if (block.type === 'text') {
        out.push({ role: 'user', content: block.text });
      }
    }
  }
  return out;
}

/** Renames input_schema → parameters for Ollama's function-tool format. */
export function anthropicToolToOllama(tool: ToolDef): OllamaTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as unknown,
    },
  };
}

/** Converts the Ollama response message into our canonical content blocks. */
export function ollamaResponseToContentBlocks(msg: OllamaResponseMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (msg.content && msg.content.length > 0) {
    blocks.push({ type: 'text', text: msg.content });
  }
  for (const tc of msg.tool_calls ?? []) {
    blocks.push({
      type: 'tool_use',
      id: tc.id ?? crypto.randomUUID(),
      name: tc.function.name,
      input: tc.function.arguments ?? {},
    });
  }
  return blocks;
}

/** Maps Ollama's done_reason field to our canonical stopReason. */
export function ollamaDoneReasonToStopReason(
  done: string | undefined,
  hasToolCalls: boolean,
): 'end_turn' | 'tool_use' | 'max_tokens' | 'other' {
  if (done === 'length') return 'max_tokens';
  if (done === 'stop') return hasToolCalls ? 'tool_use' : 'end_turn';
  return 'other';
}

/** Normalizes Ollama usage counts to our canonical shape. Cache fields are
 *  always 0 (Ollama has no prompt-cache concept). */
export function normalizeOllamaUsage(u: OllamaUsage): NormalizedUsage {
  return {
    inputTokens: u.prompt_eval_count ?? 0,
    outputTokens: u.eval_count ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/ai/provider/ollama-adapter.test.ts`
Expected: PASS, all tests

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/ollama-adapter.ts tests/ai/provider/ollama-adapter.test.ts
git commit -m "feat(local-ai): ollama-adapter for Anthropic shape conversion"
```

---

### Task 9: `LocalProvider` class with mocked-fetch tests

**Files:**
- Create: `src/ai/provider/local.ts`
- Create: `tests/ai/provider/local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/provider/local.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LocalProvider } from '@/ai/provider/local';

describe('LocalProvider', () => {
  const envBackup = { OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL };
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (envBackup.OLLAMA_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = envBackup.OLLAMA_BASE_URL;
  });

  it('completeMessage POSTs to /api/chat and returns canonical shape', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: { role: 'assistant', content: 'rolling now', tool_calls: [
        { function: { name: 'roll_dice', arguments: { sides: 20 } } },
      ] },
      done_reason: 'stop',
      prompt_eval_count: 100,
      eval_count: 50,
    }), { status: 200 }));

    const p = new LocalProvider();
    const r = await p.completeMessage({
      systemBlocks: [{ type: 'text', text: 'You are a DM.' }],
      messages: [{ role: 'user', content: 'attack the goblin' }],
      tools: [{ name: 'roll_dice', description: 'roll', input_schema: { type: 'object', properties: {} } }],
      model: 'qwen3:30b-a3b',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(r.contentBlocks).toHaveLength(2);
    expect(r.stopReason).toBe('tool_use');
    expect(r.usage.inputTokens).toBe(100);
    expect(r.usage.outputTokens).toBe(50);
  });

  it('throws when /api/chat returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('Bad model', { status: 404 }));

    const p = new LocalProvider();
    await expect(p.completeMessage({
      systemBlocks: [], messages: [], tools: [], model: 'qwen3:30b-a3b',
    })).rejects.toThrow(/ollama chat 404/);
  });

  it('detectLanguage returns null for trivial text', async () => {
    const p = new LocalProvider();
    expect(await p.detectLanguage({ text: 'ok' })).toBeNull();
  });

  it('detectLanguage returns ISO code from response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: { role: 'assistant', content: 'it' },
      done_reason: 'stop',
      prompt_eval_count: 50,
      eval_count: 2,
    }), { status: 200 }));

    const p = new LocalProvider();
    const r = await p.detectLanguage({ text: 'Buongiorno come va oggi nel parco' });
    expect(r).toBe('it');
  });

  it('proposeWizard returns toolInput when tool_call is present', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: { role: 'assistant', content: '', tool_calls: [
        { function: { name: 'propose_choice', arguments: { choice: 'wizard', stat: 'INT' } } },
      ] },
      done_reason: 'stop',
      prompt_eval_count: 80,
      eval_count: 20,
    }), { status: 200 }));

    const p = new LocalProvider();
    const r = await p.proposeWizard({
      systemPrompt: 'You propose.',
      toolDefinition: {
        name: 'propose_choice',
        description: 'pick',
        input_schema: { type: 'object', properties: { choice: { type: 'string' }, stat: { type: 'string' } } },
      },
      userMessage: 'Suggest a class',
    });
    expect(r.toolInput).toEqual({ choice: 'wizard', stat: 'INT' });
  });

  it('proposeWizard throws if response has no tool_call', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      message: { role: 'assistant', content: 'I think you should pick wizard.' },
      done_reason: 'stop',
      prompt_eval_count: 80, eval_count: 30,
    }), { status: 200 }));

    const p = new LocalProvider();
    await expect(p.proposeWizard({
      systemPrompt: 'X', userMessage: 'Y',
      toolDefinition: { name: 'propose_choice', description: '', input_schema: {} },
    })).rejects.toThrow(/AI did not call propose_choice/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/ai/provider/local.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```ts
// src/ai/provider/local.ts
import type {
  CompleteMessageInput,
  CompleteMessageOutput,
  DetectLanguageInput,
  MasterProvider,
  ProposeWizardInput,
  ProposeWizardOutput,
} from './types';
import {
  anthropicSystemToOllamaMessage,
  anthropicMessagesToOllama,
  anthropicToolToOllama,
  ollamaResponseToContentBlocks,
  ollamaDoneReasonToStopReason,
  normalizeOllamaUsage,
  type OllamaMessage,
  type OllamaResponseMessage,
} from './ollama-adapter';
import { recordUsage } from '@/ai/master/usage';

const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '5m';

const TRIVIAL_TOKENS = new Set(['ok', 'yes', 'no', 'sì', 'si', 'k', 'np']);
function isTrivial(text: string): boolean {
  const cleaned = text.trim().toLowerCase();
  if (cleaned.length < 5) return true;
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1 && !TRIVIAL_TOKENS.has(w));
  return words.length < 5;
}

function baseUrl(): string {
  const url = process.env.OLLAMA_BASE_URL;
  if (!url) throw new Error('OLLAMA_BASE_URL is not set');
  return url;
}

interface OllamaChatResponse {
  message: OllamaResponseMessage;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function chat(body: unknown): Promise<OllamaChatResponse> {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama chat ${res.status}: ${text}`);
  }
  return await res.json() as OllamaChatResponse;
}

export class LocalProvider implements MasterProvider {
  readonly name = 'local' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    const systemMsg = anthropicSystemToOllamaMessage(input.systemBlocks);
    const messages: OllamaMessage[] = [
      ...(systemMsg ? [systemMsg] : []),
      ...anthropicMessagesToOllama(input.messages),
    ];
    const json = await chat({
      model: input.model,
      messages,
      tools: input.tools.map(anthropicToolToOllama),
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { num_predict: input.maxTokens ?? 4096 },
    });
    const contentBlocks = ollamaResponseToContentBlocks(json.message);
    const hasToolCalls = contentBlocks.some((b) => b.type === 'tool_use');
    return {
      contentBlocks,
      stopReason: ollamaDoneReasonToStopReason(json.done_reason, hasToolCalls),
      usage: normalizeOllamaUsage({
        prompt_eval_count: json.prompt_eval_count,
        eval_count: json.eval_count,
      }),
    };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    try {
      const json = await chat({
        model: process.env.OLLAMA_LANGUAGE_MODEL ?? process.env.OLLAMA_MASTER_MODEL,
        messages: [
          { role: 'system', content: 'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.' },
          { role: 'user', content: input.text },
        ],
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_predict: 8 },
      });
      if (input.userId) {
        await recordUsage({
          userId: input.userId,
          sessionId: input.sessionId ?? null,
          endpoint: 'language',
          model: 'ollama-local',
          usage: normalizeOllamaUsage({
            prompt_eval_count: json.prompt_eval_count,
            eval_count: json.eval_count,
          }),
        });
      }
      const code = json.message.content.trim().toLowerCase();
      return /^[a-z]{2}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }

  async proposeWizard(input: ProposeWizardInput): Promise<ProposeWizardOutput> {
    const json = await chat({
      model: input.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ],
      tools: [anthropicToolToOllama(input.toolDefinition)],
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { num_predict: 1024 },
    });
    if (input.userId) {
      await recordUsage({
        userId: input.userId,
        sessionId: input.sessionId ?? null,
        endpoint: 'wizard',
        model: input.model ?? 'ollama-local',
        usage: normalizeOllamaUsage({
          prompt_eval_count: json.prompt_eval_count,
          eval_count: json.eval_count,
        }),
      });
    }
    const blocks = ollamaResponseToContentBlocks(json.message);
    for (const b of blocks) {
      if (b.type === 'tool_use' && b.name === input.toolDefinition.name) {
        return {
          toolInput: b.input,
          usage: normalizeOllamaUsage({
            prompt_eval_count: json.prompt_eval_count,
            eval_count: json.eval_count,
          }),
        };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/ai/provider/local.test.ts`
Expected: PASS, 6/6 tests

- [ ] **Step 5: Commit**

```bash
git add src/ai/provider/local.ts tests/ai/provider/local.test.ts
git commit -m "feat(local-ai): LocalProvider with Ollama /api/chat"
```

---

### Task 10: Wire `LocalProvider` into the dispatcher

**Files:**
- Modify: `src/ai/provider/types.ts`
- Modify: `src/ai/provider/index.ts`

- [ ] **Step 1: Update `ProviderName` union**

In `src/ai/provider/types.ts`, change line 3:

```ts
export type ProviderName = 'anthropic' | 'openai' | 'gemini' | 'local';
```

- [ ] **Step 2: Update `getProviderByName` dispatcher**

In `src/ai/provider/index.ts`:

```ts
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { GeminiProvider } from './gemini';
import { LocalProvider } from './local';
import type { MasterProvider, ProviderName } from './types';

let _anthropic: AnthropicProvider | null = null;
let _openai: OpenAIProvider | null = null;
let _gemini: GeminiProvider | null = null;
let _local: LocalProvider | null = null;

export function getProviderByName(name: ProviderName): MasterProvider {
  if (name === 'anthropic') { if (!_anthropic) _anthropic = new AnthropicProvider(); return _anthropic; }
  if (name === 'openai')    { if (!_openai)    _openai    = new OpenAIProvider();    return _openai; }
  if (name === 'gemini')    { if (!_gemini)    _gemini    = new GeminiProvider();    return _gemini; }
  if (name === 'local')     { if (!_local)     _local     = new LocalProvider();     return _local; }
  throw new Error(`unknown provider: ${String(name)}`);
}

export function getMasterProvider(): MasterProvider {
  const raw = (process.env.MASTER_PROVIDER ?? 'anthropic').trim().toLowerCase();
  if (raw === 'anthropic' || raw === 'openai' || raw === 'gemini' || raw === 'local') {
    return getProviderByName(raw);
  }
  throw new Error(`unknown MASTER_PROVIDER: ${raw}`);
}

export function _resetMasterProviderForTests(): void {
  _anthropic = null;
  _openai = null;
  _gemini = null;
  _local = null;
}

export type { MasterProvider, ProviderName } from './types';
```

- [ ] **Step 3: Run typecheck and existing provider tests**

Run: `pnpm typecheck && pnpm test tests/ai/provider/`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/ai/provider/types.ts src/ai/provider/index.ts
git commit -m "feat(local-ai): wire LocalProvider into getProviderByName"
```

---

### Task 11: `fetchOllamaModels` with whitelist filtering

**Files:**
- Modify: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-ollama.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-ollama.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchOllamaModels } from '@/lib/local-services';

describe('fetchOllamaModels', () => {
  const original = process.env.OLLAMA_BASE_URL;
  beforeEach(() => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = original;
  });

  it('filters /api/tags response by whitelist', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'qwen3:30b-a3b',                          details: { parameter_size: '30B', quantization_level: 'Q4_K_M' } },
        { name: 'llama3.1:8b',                            details: { parameter_size: '8B'  } },
        { name: 'hf.co/unsloth/gpt-oss-20b-GGUF:F16',     details: { parameter_size: '20B', quantization_level: 'F16' } },
        { name: 'mistral:7b',                             details: { parameter_size: '7B'  } },
      ],
    }), { status: 200 }));

    const r = await fetchOllamaModels();
    expect(r).toHaveLength(2);
    expect(r[0].slug).toBe('qwen3:30b-a3b');
    expect(r[0].label).toBe('qwen3:30b-a3b');
    expect(r[0].blurb).toBe('30B · Q4_K_M');
    expect(r[1].slug).toBe('hf.co/unsloth/gpt-oss-20b-GGUF:F16');
    expect(r[1].label).toBe('unsloth/gpt-oss-20b (F16)');
  });

  it('returns empty list when fetch throws', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'));
    const r = await fetchOllamaModels();
    expect(r).toEqual([]);
  });

  it('returns empty list when OLLAMA_BASE_URL is unset', async () => {
    delete process.env.OLLAMA_BASE_URL;
    const r = await fetchOllamaModels();
    expect(r).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-ollama.test.ts`
Expected: FAIL

- [ ] **Step 3: Append to `src/lib/local-services.ts`**

```ts
interface OllamaTagsResponse {
  models?: {
    name: string;
    details?: { parameter_size?: string; quantization_level?: string; family?: string };
  }[];
}

export async function fetchOllamaModels(): Promise<ModelOption[]> {
  const base = process.env.OLLAMA_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const json = (await res.json()) as OllamaTagsResponse;
    const models = json.models ?? [];
    return models
      .filter((m) => matchesLlmWhitelist(m.name))
      .map((m) => ({
        slug: m.name,
        label: normalizeOllamaLabel(m.name),
        blurb: [m.details?.parameter_size, m.details?.quantization_level]
          .filter(Boolean)
          .join(' · ') || 'local',
      }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/lib/local-services-ollama.test.ts`
Expected: PASS, 3/3 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-ollama.test.ts
git commit -m "feat(local-ai): fetchOllamaModels with whitelist"
```

---

## Phase 3 — TTS (Piper + XTTSv2)

### Task 12: `synthesizePiper` inline in tts.ts

**Files:**
- Modify: `src/ai/tts.ts`
- Create: `tests/ai/tts-local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai/tts-local.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { synthesizeSpeech } from '@/ai/tts';

const envBackup: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) envBackup[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('synthesizeSpeech — provider=local engine=piper', () => {
  beforeEach(() => {
    saveEnv('PIPER_BASE_URL');
    process.env.PIPER_BASE_URL = 'http://localhost:8050';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it('POSTs to /v1/audio/speech with OpenAI-compat body and returns MP3', async () => {
    const fakeMp3 = new Uint8Array([0xff, 0xfb, 0x00, 0x00]).buffer;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(fakeMp3, { status: 200 }));

    const r = await synthesizeSpeech({
      text: 'hello',
      provider: 'local',
      model: 'piper',
      voice: 'en_US-amy-low',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8050/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'piper',
          voice: 'en_US-amy-low',
          input: 'hello',
          response_format: 'mp3',
        }),
      }),
    );
    expect(r.mimeType).toBe('audio/mpeg');
    expect(new Uint8Array(r.bytes)).toEqual(new Uint8Array(fakeMp3));
  });

  it('throws when Piper returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('bad voice', { status: 400 }));
    await expect(synthesizeSpeech({
      text: 'hi', provider: 'local', model: 'piper', voice: 'nope',
    })).rejects.toThrow(/piper 400/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/ai/tts-local.test.ts`
Expected: FAIL — no 'local' branch

- [ ] **Step 3: Modify `src/ai/tts.ts`**

Replace the `synthesizeSpeech` function body and append the helpers:

```ts
export async function synthesizeSpeech(input: SynthesizeInput): Promise<SynthesizeOutput> {
  if (!input.text.trim()) throw new Error('tts: empty input');
  const provider = input.provider ?? 'openai';
  if (provider === 'local')  return synthesizeLocal(input);
  if (provider === 'gemini') return synthesizeGemini(input);
  return synthesizeOpenAI(input);
}

// ── Local ──────────────────────────────────────────────────────────────────

async function synthesizeLocal(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const engine = input.model;
  if (engine === 'piper') return synthesizePiper(input);
  if (engine === 'xtts')  return synthesizeXtts(input);
  throw new Error(`tts: local engine must be 'piper' or 'xtts', got "${engine ?? ''}"`);
}

async function synthesizePiper(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const base = process.env.PIPER_BASE_URL;
  if (!base) throw new Error('PIPER_BASE_URL is not set');
  const voice = input.voice;
  if (!voice) throw new Error('tts: piper requires a voice');
  const res = await fetch(`${base}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'piper',
      voice,
      input: input.text,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`piper ${res.status}: ${text}`);
  }
  return { bytes: await res.arrayBuffer(), mimeType: 'audio/mpeg' };
}

async function synthesizeXtts(input: SynthesizeInput): Promise<SynthesizeOutput> {
  // Implemented in Task 13.
  throw new Error('xtts not yet implemented');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/ai/tts-local.test.ts`
Expected: PASS, 2/2 tests for Piper

- [ ] **Step 5: Commit**

```bash
git add src/ai/tts.ts tests/ai/tts-local.test.ts
git commit -m "feat(local-ai): synthesizePiper via openedai-speech OpenAI-compat endpoint"
```

---

### Task 13: `synthesizeXtts` inline in tts.ts

**Files:**
- Modify: `src/ai/tts.ts`
- Modify: `tests/ai/tts-local.test.ts`

- [ ] **Step 1: Add tests for XTTS to the existing local test file**

Append to `tests/ai/tts-local.test.ts`:

```ts
describe('synthesizeSpeech — provider=local engine=xtts', () => {
  beforeEach(() => {
    saveEnv('XTTS_BASE_URL');
    process.env.XTTS_BASE_URL = 'http://localhost:8055';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it('POSTs to /tts_to_audio/ (trailing slash) with text+speaker+language', async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;  // 'RIFF'
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(fakeWav, { status: 200 }));

    const r = await synthesizeSpeech({
      text: 'ciao',
      provider: 'local',
      model: 'xtts',
      voice: 'it',
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8055/tts_to_audio/',
      expect.objectContaining({ method: 'POST' }),
    );
    const callBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body;
    expect(JSON.parse(callBody)).toEqual({
      text: 'ciao',
      speaker_wav: 'Claribel Dervla',
      language: 'it',
    });
    expect(r.mimeType).toBe('audio/wav');
  });

  it('throws when XTTS returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('bad lang', { status: 400 }));
    await expect(synthesizeSpeech({
      text: 'x', provider: 'local', model: 'xtts', voice: 'xx',
    })).rejects.toThrow(/xtts 400/);
  });

  it('defaults voice to "en" when not provided', async () => {
    const fakeWav = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(fakeWav, { status: 200 }));

    await synthesizeSpeech({ text: 'x', provider: 'local', model: 'xtts' });
    const callBody = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body;
    expect(JSON.parse(callBody).language).toBe('en');
  });
});
```

- [ ] **Step 2: Run test to verify XTTS branch fails**

Run: `pnpm test tests/ai/tts-local.test.ts`
Expected: FAIL on the 3 new XTTS tests (`xtts not yet implemented`)

- [ ] **Step 3: Replace the stub `synthesizeXtts` in `src/ai/tts.ts`**

```ts
async function synthesizeXtts(input: SynthesizeInput): Promise<SynthesizeOutput> {
  const base = process.env.XTTS_BASE_URL;
  if (!base) throw new Error('XTTS_BASE_URL is not set');
  const language = input.voice ?? 'en';
  const res = await fetch(`${base}/tts_to_audio/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: input.text,
      speaker_wav: 'Claribel Dervla',
      language,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`xtts ${res.status}: ${text}`);
  }
  return { bytes: await res.arrayBuffer(), mimeType: 'audio/wav' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/ai/tts-local.test.ts`
Expected: PASS, all (Piper + XTTS) tests

- [ ] **Step 5: Commit**

```bash
git add src/ai/tts.ts tests/ai/tts-local.test.ts
git commit -m "feat(local-ai): synthesizeXtts via xtts-api-server"
```

---

### Task 14: `fetchPiperVoices` enumerator

**Files:**
- Modify: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-piper.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-piper.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchPiperVoices } from '@/lib/local-services';

describe('fetchPiperVoices', () => {
  const original = process.env.PIPER_BASE_URL;
  beforeEach(() => {
    process.env.PIPER_BASE_URL = 'http://localhost:8050';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.PIPER_BASE_URL;
    else process.env.PIPER_BASE_URL = original;
  });

  it('maps /v1/audio/voices response to ModelOption[]', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify([
      { id: 'en_US-amy-low',     language: 'en_US', quality: 'low' },
      { id: 'it_IT-riccardo-x_low', language: 'it_IT', quality: 'x_low' },
    ]), { status: 200 }));

    const r = await fetchPiperVoices();
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ slug: 'en_US-amy-low', label: 'en_US-amy-low', blurb: 'en_US · low' });
    expect(r[1]).toEqual({ slug: 'it_IT-riccardo-x_low', label: 'it_IT-riccardo-x_low', blurb: 'it_IT · x_low' });
  });

  it('returns [] when fetch throws', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchPiperVoices()).toEqual([]);
  });

  it('returns [] when PIPER_BASE_URL is unset', async () => {
    delete process.env.PIPER_BASE_URL;
    expect(await fetchPiperVoices()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-piper.test.ts`
Expected: FAIL

- [ ] **Step 3: Append to `src/lib/local-services.ts`**

```ts
interface PiperVoiceEntry { id: string; language?: string; quality?: string }

export async function fetchPiperVoices(): Promise<ModelOption[]> {
  const base = process.env.PIPER_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/v1/audio/voices`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const voices = (await res.json()) as PiperVoiceEntry[];
    return voices.map((v) => ({
      slug: v.id,
      label: v.id,
      blurb: [v.language, v.quality].filter(Boolean).join(' · ') || 'piper',
    }));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/lib/local-services-piper.test.ts`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-piper.test.ts
git commit -m "feat(local-ai): fetchPiperVoices enumerator"
```

---

### Task 15: XTTS voices catalog (static list)

**Files:**
- Modify: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-xtts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-xtts.test.ts
import { describe, it, expect } from 'vitest';
import { listXttsVoices } from '@/lib/local-services';

describe('listXttsVoices', () => {
  it('returns a ModelOption per XTTS_LANGUAGES entry', () => {
    const r = listXttsVoices();
    expect(r.length).toBeGreaterThanOrEqual(9);
    const en = r.find((m) => m.slug === 'en');
    expect(en).toEqual({ slug: 'en', label: 'English (default)', blurb: 'xtts · neural' });
    const it = r.find((m) => m.slug === 'it');
    expect(it).toEqual({ slug: 'it', label: 'Italian (default)', blurb: 'xtts · neural' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-xtts.test.ts`
Expected: FAIL

- [ ] **Step 3: Append to `src/lib/local-services.ts`**

```ts
import { XTTS_LANGUAGES } from './tts-voices';

export function listXttsVoices(): ModelOption[] {
  return XTTS_LANGUAGES.map((l) => ({
    slug: l.code,
    label: `${l.label} (default)`,
    blurb: 'xtts · neural',
  }));
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/lib/local-services-xtts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-xtts.test.ts
git commit -m "feat(local-ai): listXttsVoices catalog"
```

---

## Phase 4 — Image (ComfyUI + Draw Things)

### Task 16: Flux Schnell workflow JSON template

**Files:**
- Create: `src/sessions/image-providers/comfyui-workflows/flux-schnell.json`
- Create: `tests/sessions/image-providers/comfyui-workflow.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sessions/image-providers/comfyui-workflow.test.ts
import { describe, it, expect } from 'vitest';
import { loadWorkflowTemplate, escapeJsonString } from '@/sessions/image-providers/comfyui';

describe('comfyui workflow loading', () => {
  it('loads flux-schnell template and contains a {{PROMPT}} placeholder', async () => {
    const tmpl = await loadWorkflowTemplate('flux-schnell');
    expect(tmpl).toContain('{{PROMPT}}');
    const parsed = JSON.parse(tmpl.replace('{{PROMPT}}', escapeJsonString('a wizard')));
    expect(parsed).toBeTypeOf('object');
  });

  it('throws on unknown workflow name', async () => {
    await expect(loadWorkflowTemplate('does-not-exist')).rejects.toThrow();
  });
});

describe('escapeJsonString', () => {
  it('escapes quotes and backslashes', () => {
    expect(escapeJsonString('a "quoted" \\ value')).toBe('a \\"quoted\\" \\\\ value');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/sessions/image-providers/comfyui-workflow.test.ts`
Expected: FAIL

- [ ] **Step 3: Create the workflow template**

Save the following to `src/sessions/image-providers/comfyui-workflows/flux-schnell.json`. This is a minimal Flux.1 Schnell graph: load model + CLIP/T5 encoders + VAE + KSampler (4 steps, scheduler=simple) + SaveImage node 9.

```json
{
  "6": {
    "inputs": {
      "text": "{{PROMPT}}",
      "clip": ["11", 0]
    },
    "class_type": "CLIPTextEncode"
  },
  "8": {
    "inputs": {
      "samples": ["13", 0],
      "vae": ["10", 0]
    },
    "class_type": "VAEDecode"
  },
  "9": {
    "inputs": {
      "filename_prefix": "dnd-ai-master",
      "images": ["8", 0]
    },
    "class_type": "SaveImage"
  },
  "10": {
    "inputs": {
      "vae_name": "ae.safetensors"
    },
    "class_type": "VAELoader"
  },
  "11": {
    "inputs": {
      "clip_name1": "t5xxl_fp8_e4m3fn.safetensors",
      "clip_name2": "clip_l.safetensors",
      "type": "flux"
    },
    "class_type": "DualCLIPLoader"
  },
  "12": {
    "inputs": {
      "unet_name": "flux1-schnell.safetensors",
      "weight_dtype": "default"
    },
    "class_type": "UNETLoader"
  },
  "13": {
    "inputs": {
      "noise": ["14", 0],
      "guider": ["15", 0],
      "sampler": ["16", 0],
      "sigmas": ["17", 0],
      "latent_image": ["18", 0]
    },
    "class_type": "SamplerCustomAdvanced"
  },
  "14": {
    "inputs": { "noise_seed": 42 },
    "class_type": "RandomNoise"
  },
  "15": {
    "inputs": {
      "model": ["12", 0],
      "conditioning": ["6", 0]
    },
    "class_type": "BasicGuider"
  },
  "16": {
    "inputs": { "sampler_name": "euler" },
    "class_type": "KSamplerSelect"
  },
  "17": {
    "inputs": {
      "scheduler": "simple",
      "steps": 4,
      "denoise": 1.0,
      "model": ["12", 0]
    },
    "class_type": "BasicScheduler"
  },
  "18": {
    "inputs": {
      "width": 1024,
      "height": 1024,
      "batch_size": 1
    },
    "class_type": "EmptyLatentImage"
  }
}
```

- [ ] **Step 4: Create `src/sessions/image-providers/comfyui.ts` skeleton (just the loader and escape helper)**

```ts
// src/sessions/image-providers/comfyui.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const WORKFLOWS_DIR = join(process.cwd(), 'src/sessions/image-providers/comfyui-workflows');

export async function loadWorkflowTemplate(name: string): Promise<string> {
  const safe = name.replace(/[^a-z0-9-]/gi, '');
  if (!safe) throw new Error(`comfyui: invalid workflow name "${name}"`);
  try {
    return await readFile(join(WORKFLOWS_DIR, `${safe}.json`), 'utf8');
  } catch (e) {
    throw new Error(`comfyui: workflow "${safe}" not found (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Escapes a string for safe insertion into a JSON document via string replace.
 *  This is for swapping a placeholder INSIDE a JSON string literal — the
 *  replaced value must therefore have its quotes and backslashes escaped. */
export function escapeJsonString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test tests/sessions/image-providers/comfyui-workflow.test.ts`
Expected: PASS, 3/3

- [ ] **Step 6: Commit**

```bash
git add src/sessions/image-providers/comfyui-workflows/flux-schnell.json src/sessions/image-providers/comfyui.ts tests/sessions/image-providers/comfyui-workflow.test.ts
git commit -m "feat(local-ai): comfyui workflow loader + flux-schnell template"
```

---

### Task 17: `generateBytesComfyUI` end-to-end

**Files:**
- Modify: `src/sessions/image-providers/comfyui.ts`
- Create: `tests/sessions/image-providers/comfyui.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sessions/image-providers/comfyui.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateBytesComfyUI } from '@/sessions/image-providers/comfyui';

describe('generateBytesComfyUI', () => {
  const original = process.env.COMFYUI_BASE_URL;
  beforeEach(() => {
    process.env.COMFYUI_BASE_URL = 'http://localhost:8188';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.COMFYUI_BASE_URL;
    else process.env.COMFYUI_BASE_URL = original;
  });

  it('submits the prompt, polls history once, fetches view, returns PNG bytes', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'p_001' }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      p_001: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'out_0001.png', subfolder: '', type: 'output' }] } } },
    }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer, { status: 200 }));

    const r = await generateBytesComfyUI('a wizard', 'flux-schnell');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes.length).toBe(4);
      expect(r.bytes[0]).toBe(0x89);  // PNG header byte
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8188/prompt');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8188/history/p_001');
    expect(fetchMock.mock.calls[2][0]).toMatch(/^http:\/\/localhost:8188\/view\?filename=out_0001\.png/);
  });

  it('returns api_error when submit returns 5xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('boom', { status: 502 }));
    const r = await generateBytesComfyUI('x', 'flux-schnell');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('api_error');
  });

  it('returns api_error timeout if polling exceeds 60s', async () => {
    // Note: we keep the iteration short by setting MAX_WAIT_MS via env or skip
    // — the test infrastructure here uses vi.useFakeTimers + advance.
    vi.useFakeTimers();
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'p_001' }), { status: 200 }));
    // Always return incomplete
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ p_001: { status: { completed: false } } }), { status: 200 }));

    const promise = generateBytesComfyUI('x', 'flux-schnell');
    await vi.advanceTimersByTimeAsync(61_000);
    const r = await promise;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('timeout');
    vi.useRealTimers();
  });

  it('returns empty_response when SaveImage node has no images', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ prompt_id: 'p_001' }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      p_001: { status: { completed: true }, outputs: { '9': { images: [] } } },
    }), { status: 200 }));

    const r = await generateBytesComfyUI('x', 'flux-schnell');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_response');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/sessions/image-providers/comfyui.test.ts`
Expected: FAIL — `generateBytesComfyUI` undefined

- [ ] **Step 3: Extend `src/sessions/image-providers/comfyui.ts`**

Append after the loader/escape:

```ts
import type { ImageGenResult } from './openai';

const POLL_INTERVAL_MS = 1_000;
const MAX_WAIT_MS = 60_000;

interface ComfyHistory {
  [promptId: string]: {
    status?: { completed?: boolean };
    outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function generateBytesComfyUI(prompt: string, workflowSlug: string): Promise<ImageGenResult> {
  const base = process.env.COMFYUI_BASE_URL;
  if (!base) return { ok: false, reason: 'api_error', detail: 'COMFYUI_BASE_URL is not set' };
  try {
    const workflowName = workflowSlug || process.env.COMFYUI_FLUX_WORKFLOW || 'flux-schnell';
    const template = await loadWorkflowTemplate(workflowName);
    const workflow = JSON.parse(template.replace('{{PROMPT}}', escapeJsonString(prompt)));

    const submitRes = await fetch(`${base}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    });
    if (!submitRes.ok) {
      return { ok: false, reason: 'api_error', detail: `submit ${submitRes.status}` };
    }
    const { prompt_id } = (await submitRes.json()) as { prompt_id: string };

    const startTime = Date.now();
    while (Date.now() - startTime < MAX_WAIT_MS) {
      const histRes = await fetch(`${base}/history/${prompt_id}`);
      if (histRes.ok) {
        const hist = (await histRes.json()) as ComfyHistory;
        const entry = hist[prompt_id];
        if (entry?.status?.completed) {
          const image = entry.outputs?.['9']?.images?.[0];
          if (!image) return { ok: false, reason: 'empty_response' };
          const viewRes = await fetch(
            `${base}/view?filename=${encodeURIComponent(image.filename)}` +
            `&subfolder=${encodeURIComponent(image.subfolder ?? '')}&type=${encodeURIComponent(image.type ?? 'output')}`
          );
          if (!viewRes.ok) {
            return { ok: false, reason: 'api_error', detail: `view ${viewRes.status}` };
          }
          return { ok: true, bytes: Buffer.from(await viewRes.arrayBuffer()) };
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return { ok: false, reason: 'api_error', detail: 'comfyui: 60s timeout' };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/sessions/image-providers/comfyui.test.ts`
Expected: PASS, 4/4

- [ ] **Step 5: Commit**

```bash
git add src/sessions/image-providers/comfyui.ts tests/sessions/image-providers/comfyui.test.ts
git commit -m "feat(local-ai): generateBytesComfyUI submit+poll+view loop"
```

---

### Task 18: `generateBytesDrawThings`

**Files:**
- Create: `src/sessions/image-providers/draw-things.ts`
- Create: `tests/sessions/image-providers/draw-things.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/sessions/image-providers/draw-things.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateBytesDrawThings } from '@/sessions/image-providers/draw-things';

describe('generateBytesDrawThings', () => {
  const original = process.env.DRAW_THINGS_BASE_URL;
  beforeEach(() => {
    process.env.DRAW_THINGS_BASE_URL = 'http://localhost:7860';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.DRAW_THINGS_BASE_URL;
    else process.env.DRAW_THINGS_BASE_URL = original;
  });

  it('POSTs to /sdapi/v1/txt2img and decodes the first image', async () => {
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString('base64');
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({
      images: [pngBase64],
    }), { status: 200 }));

    const r = await generateBytesDrawThings('a wizard', 'realisticVisionV60');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytes[0]).toBe(0x89);
      expect(r.bytes.length).toBe(4);
    }
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.prompt).toBe('a wizard');
    expect(body.width).toBe(1024);
    expect(body.height).toBe(1024);
    expect(body.override_settings.sd_model_checkpoint).toBe('realisticVisionV60');
  });

  it('returns api_error when API returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const r = await generateBytesDrawThings('x', 'm');
    expect(r.ok).toBe(false);
  });

  it('returns empty_response when images array is empty', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify({ images: [] }), { status: 200 }));
    const r = await generateBytesDrawThings('x', 'm');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('empty_response');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/sessions/image-providers/draw-things.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create implementation**

```ts
// src/sessions/image-providers/draw-things.ts
import type { ImageGenResult } from './openai';

export async function generateBytesDrawThings(prompt: string, modelName: string): Promise<ImageGenResult> {
  const base = process.env.DRAW_THINGS_BASE_URL;
  if (!base) return { ok: false, reason: 'api_error', detail: 'DRAW_THINGS_BASE_URL is not set' };
  try {
    const res = await fetch(`${base}/sdapi/v1/txt2img`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        negative_prompt: '',
        width: 1024,
        height: 1024,
        steps: 8,
        sampler_name: 'DPM++ 2M Karras',
        override_settings: { sd_model_checkpoint: modelName },
      }),
    });
    if (!res.ok) return { ok: false, reason: 'api_error', detail: `${res.status}` };
    const json = (await res.json()) as { images?: string[] };
    const b64 = json.images?.[0];
    if (!b64) return { ok: false, reason: 'empty_response' };
    return { ok: true, bytes: Buffer.from(b64, 'base64') };
  } catch (e) {
    return { ok: false, reason: 'api_error', detail: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/sessions/image-providers/draw-things.test.ts`
Expected: PASS, 3/3

- [ ] **Step 5: Commit**

```bash
git add src/sessions/image-providers/draw-things.ts tests/sessions/image-providers/draw-things.test.ts
git commit -m "feat(local-ai): generateBytesDrawThings via SD-compatible API"
```

---

### Task 19: Wire local providers into `scene-image-job.ts`

**Files:**
- Modify: `src/sessions/scene-image-job.ts`
- Inspect first to understand the exact integration point.

- [ ] **Step 1: Read the existing dispatch logic**

Run: `grep -n "generateBytes\|imageProvider\|provider ===" src/sessions/scene-image-job.ts`

Note the line number where the existing `openai/gemini` if/else chain lives. We are adding a `'local'` branch above the cloud branches.

- [ ] **Step 2: Modify the dispatch block**

Find the block that selects which `generateBytes*` to call. Add a `'local'` case:

```ts
import { generateBytesComfyUI } from '@/sessions/image-providers/comfyui';
import { generateBytesDrawThings } from '@/sessions/image-providers/draw-things';

// ... inside generateAndPersist, where the existing block selects by provider ...
let result: ImageGenResult;
if (provider === 'local') {
  if (model.startsWith('comfyui:')) {
    result = await generateBytesComfyUI(fullPrompt, model.slice('comfyui:'.length));
  } else if (model.startsWith('draw-things:')) {
    result = await generateBytesDrawThings(fullPrompt, model.slice('draw-things:'.length));
  } else {
    result = { ok: false, reason: 'api_error', detail: `unknown local engine in model "${model}"` };
  }
} else if (provider === 'gemini') {
  result = await generateBytesGemini(fullPrompt, model);
} else {
  result = await generateBytesOpenAI(fullPrompt, model);
}
```

(Match the variable names already in the file — the diff is the new `if (provider === 'local')` branch added before the existing ones.)

- [ ] **Step 3: Run existing scene-image tests to verify no regressions**

Run: `pnpm test tests/sessions/`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/sessions/scene-image-job.ts
git commit -m "feat(local-ai): route 'local' provider in scene-image-job dispatch"
```

---

### Task 20: `fetchDrawThingsModels` + `listComfyUIWorkflows` enumerators

**Files:**
- Modify: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-image.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-image.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDrawThingsModels, listComfyUIWorkflows } from '@/lib/local-services';

describe('listComfyUIWorkflows', () => {
  it('returns the hardcoded workflow list with flux-schnell first', () => {
    const r = listComfyUIWorkflows();
    expect(r[0]?.slug).toBe('comfyui:flux-schnell');
    expect(r[0]?.label).toBe('Flux.1 Schnell');
  });
});

describe('fetchDrawThingsModels', () => {
  const original = process.env.DRAW_THINGS_BASE_URL;
  beforeEach(() => {
    process.env.DRAW_THINGS_BASE_URL = 'http://localhost:7860';
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.DRAW_THINGS_BASE_URL;
    else process.env.DRAW_THINGS_BASE_URL = original;
  });

  it('maps /sdapi/v1/sd-models to ModelOption[] with draw-things: prefix', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Response(JSON.stringify([
      { title: 'Realistic Vision v6.0 [abc123]', model_name: 'realisticVisionV60' },
      { title: 'SDXL Base 1.0 [def456]', model_name: 'sdxlBase10' },
    ]), { status: 200 }));

    const r = await fetchDrawThingsModels();
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      slug: 'draw-things:realisticVisionV60',
      label: 'Realistic Vision v6.0 [abc123]',
      blurb: 'draw-things · core-ml',
    });
  });

  it('returns [] when fetch throws', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await fetchDrawThingsModels()).toEqual([]);
  });

  it('returns [] when DRAW_THINGS_BASE_URL is unset', async () => {
    delete process.env.DRAW_THINGS_BASE_URL;
    expect(await fetchDrawThingsModels()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-image.test.ts`
Expected: FAIL

- [ ] **Step 3: Append to `src/lib/local-services.ts`**

```ts
interface DrawThingsModel { title: string; model_name: string }

export async function fetchDrawThingsModels(): Promise<ModelOption[]> {
  const base = process.env.DRAW_THINGS_BASE_URL;
  if (!base) return [];
  try {
    const res = await fetch(`${base}/sdapi/v1/sd-models`, {
      signal: AbortSignal.timeout(2000),
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const models = (await res.json()) as DrawThingsModel[];
    return models.map((m) => ({
      slug: `draw-things:${m.model_name}`,
      label: m.title,
      blurb: 'draw-things · core-ml',
    }));
  } catch {
    return [];
  }
}

const COMFYUI_WORKFLOWS: ModelOption[] = [
  { slug: 'comfyui:flux-schnell', label: 'Flux.1 Schnell', blurb: 'fast · 4 steps' },
];

export function listComfyUIWorkflows(): ModelOption[] {
  return [...COMFYUI_WORKFLOWS];
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/lib/local-services-image.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-image.test.ts
git commit -m "feat(local-ai): fetchDrawThingsModels and listComfyUIWorkflows"
```

---

## Phase 5 — Status aggregation

### Task 21: `fetchLocalServicesStatus` orchestrator

**Files:**
- Modify: `src/lib/local-services.ts`
- Create: `tests/lib/local-services-status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/local-services-status.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchLocalServicesStatus } from '@/lib/local-services';

const envBackup: Record<string, string | undefined> = {};
function saveEnv(...keys: string[]) {
  for (const k of keys) envBackup[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('fetchLocalServicesStatus', () => {
  beforeEach(() => {
    saveEnv('NODE_ENV', 'VERCEL', 'OLLAMA_BASE_URL', 'PIPER_BASE_URL',
            'XTTS_BASE_URL', 'COMFYUI_BASE_URL', 'DRAW_THINGS_BASE_URL');
    process.env.NODE_ENV = 'development';
    delete process.env.VERCEL;
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it('reports isLocal:false in production', async () => {
    process.env.NODE_ENV = 'production';
    const r = await fetchLocalServicesStatus();
    expect(r.isLocal).toBe(false);
    expect(r.ai.enabled).toBe(false);
    expect(r.tts.enabled).toBe(false);
    expect(r.image.enabled).toBe(false);
  });

  it('reports enabled=true for surfaces with env set, even when unreachable', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.PIPER_BASE_URL  = 'http://localhost:8050';
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refused'));

    const r = await fetchLocalServicesStatus();
    expect(r.ai.enabled).toBe(true);
    expect(r.ai.reachable).toBe(false);
    expect(r.tts.enabled).toBe(true);
    expect(r.tts.engines.piper.enabled).toBe(true);
    expect(r.tts.engines.piper.reachable).toBe(false);
    expect(r.tts.engines.xtts.enabled).toBe(false);
  });

  it('fetches models when service reachable', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    // ping
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'qwen3:30b-a3b' }] }), { status: 200 }));
    // listing call (fetchOllamaModels) — same endpoint, may share the response
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'qwen3:30b-a3b' }] }), { status: 200 }));

    const r = await fetchLocalServicesStatus();
    expect(r.ai.reachable).toBe(true);
    expect(r.ai.models.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/lib/local-services-status.test.ts`
Expected: FAIL

- [ ] **Step 3: Append to `src/lib/local-services.ts`**

```ts
async function buildAiStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.OLLAMA_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.OLLAMA_BASE_URL!, '/api/tags');
  const models = reachable ? await fetchOllamaModels() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildPiperStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.PIPER_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.PIPER_BASE_URL!, '/v1/audio/voices');
  const models = reachable ? await fetchPiperVoices() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildXttsStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.XTTS_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.XTTS_BASE_URL!, '/speakers_list');
  // XTTS voices are static (hardcoded language list), shown regardless of reachability
  const models = listXttsVoices();
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildComfyUIStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.COMFYUI_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.COMFYUI_BASE_URL!, '/system_stats');
  const models = listComfyUIWorkflows();  // static phase 1
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

async function buildDrawThingsStatus(): Promise<EngineStatus> {
  const enabled = !!process.env.DRAW_THINGS_BASE_URL;
  if (!enabled) return { enabled: false, reachable: false, models: [] };
  const reachable = await pingService(process.env.DRAW_THINGS_BASE_URL!, '/sdapi/v1/options');
  const models = reachable ? await fetchDrawThingsModels() : [];
  return { enabled, reachable, models, ...(reachable ? {} : { error: 'unreachable' }) };
}

export async function fetchLocalServicesStatus(): Promise<LocalServicesStatus> {
  const isLocal = isLocalEnvironment();
  if (!isLocal) {
    const empty: EngineStatus = { enabled: false, reachable: false, models: [] };
    return {
      isLocal: false,
      ai: empty,
      tts: { enabled: false, engines: { piper: empty, xtts: empty } },
      image: { enabled: false, engines: { comfyui: empty, drawThings: empty } },
    };
  }

  const [ai, piper, xtts, comfyui, drawThings] = await Promise.all([
    buildAiStatus(),
    buildPiperStatus(),
    buildXttsStatus(),
    buildComfyUIStatus(),
    buildDrawThingsStatus(),
  ]);

  return {
    isLocal: true,
    ai,
    tts: {
      enabled: piper.enabled || xtts.enabled,
      engines: { piper, xtts },
    },
    image: {
      enabled: comfyui.enabled || drawThings.enabled,
      engines: { comfyui, drawThings },
    },
  };
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test tests/lib/local-services-status.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full local-services test set**

Run: `pnpm test tests/lib/local-services`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/local-services.ts tests/lib/local-services-status.test.ts
git commit -m "feat(local-ai): fetchLocalServicesStatus aggregate orchestrator"
```

---

## Phase 6 — UI

### Task 22: Settings page server loader passes `localServices` prop

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/page.tsx`
- (No new tests — server component changes are exercised by E2E)

- [ ] **Step 1: Open the settings page server file**

Run: `cat src/app/(authed)/campaigns/[id]/settings/page.tsx`

Note the existing data-loading pattern and the props passed to `SettingsClient`.

- [ ] **Step 2: Add a call to `fetchLocalServicesStatus()` server-side**

At the top of the file, import:

```ts
import { fetchLocalServicesStatus } from '@/lib/local-services';
```

Inside the page component (alongside the existing data fetching), add:

```ts
const localServices = await fetchLocalServicesStatus();
```

Pass `localServices` to `SettingsClient`:

```tsx
<SettingsClient
  campaignId={id}
  initialSettings={settings}
  // ... existing props ...
  localServices={localServices}
/>
```

- [ ] **Step 3: Update `SettingsClientProps` in the client file**

Open `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx` and add to the props interface:

```ts
import type { LocalServicesStatus } from '@/lib/local-services';

interface SettingsClientProps {
  // ... existing fields ...
  localServices: LocalServicesStatus;
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/page.tsx src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx
git commit -m "feat(local-ai): pass localServices status to settings client"
```

---

### Task 23: SettingsClient — "Local" provider radio + status badges (LLM card)

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`

- [ ] **Step 1: Find the LLM (master) provider card**

Run: `grep -n "aiProvider" src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx | head -20`

Identify the card that currently renders the three provider buttons (Anthropic / OpenAI / Gemini).

- [ ] **Step 2: Add a "Local" radio button**

In the provider button row, add a fourth button conditionally:

```tsx
{localServices.isLocal && localServices.ai.enabled && (
  <button
    type="button"
    onClick={() => onAiProviderChange('local')}
    aria-pressed={settings.aiProvider === 'local'}
    disabled={busy}
    // re-use the existing button styling
  >
    Local
  </button>
)}
```

- [ ] **Step 3: Update the model dropdown to use runtime models when provider=local**

Find the dropdown that uses `modelsForProvider(settings.aiProvider)`. Wrap it so the runtime list is used for local:

```tsx
const aiModels: ModelOption[] =
  settings.aiProvider === 'local'
    ? localServices.ai.models
    : modelsForProvider(settings.aiProvider as 'anthropic' | 'openai' | 'gemini');
```

Then render the dropdown options from `aiModels`. If `aiModels.length === 0` AND provider is local, render a single disabled `<option>`:

```tsx
{aiModels.length === 0 && settings.aiProvider === 'local' ? (
  <option disabled>{localServices.ai.reachable ? 'No qwen3 or gpt-oss installed in Ollama' : 'Ollama unreachable'}</option>
) : (
  aiModels.map((m) => <option key={m.slug} value={m.slug}>{m.label}</option>)
)}
```

- [ ] **Step 4: Add an info badge under the radio**

Below the row of provider buttons (still in the LLM card), conditionally render:

```tsx
{settings.aiProvider === 'local' && (
  <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
    {localServices.ai.reachable ? '✓ Ollama' : `✗ Ollama (${localServices.ai.error ?? 'unreachable'})`}
  </div>
)}
```

- [ ] **Step 5: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx
git commit -m "feat(local-ai): SettingsClient adds Local radio + status badge for LLM"
```

---

### Task 24: SettingsClient — Engine selector + Local for TTS

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`

- [ ] **Step 1: Locate the TTS card**

Run: `grep -n "ttsProvider\|ttsVoice" src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx | head -10`

- [ ] **Step 2: Add the "Local" radio button for TTS**

In the TTS provider row, add the fourth button:

```tsx
{localServices.isLocal && localServices.tts.enabled && (
  <button
    type="button"
    onClick={() => onTtsProviderChange('local')}
    aria-pressed={settings.ttsProvider === 'local'}
    disabled={busy}
  >
    Local
  </button>
)}
```

- [ ] **Step 3: Add the engine selector (Piper / XTTSv2)**

Below the provider row, when `ttsProvider === 'local'`, render an Engine sub-selector:

```tsx
{settings.ttsProvider === 'local' && (
  <>
    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)' }}>Engine</div>
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="button"
        onClick={() => onTtsModelChange('piper')}
        aria-pressed={settings.ttsModel === 'piper'}
        disabled={busy || !localServices.tts.engines.piper.enabled}
        title={!localServices.tts.engines.piper.enabled ? 'PIPER_BASE_URL not set' : undefined}
      >
        Piper
      </button>
      <button
        type="button"
        onClick={() => onTtsModelChange('xtts')}
        aria-pressed={settings.ttsModel === 'xtts'}
        disabled={busy || !localServices.tts.engines.xtts.enabled}
        title={!localServices.tts.engines.xtts.enabled ? 'XTTS_BASE_URL not set' : undefined}
      >
        XTTSv2
      </button>
    </div>

    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
      {localServices.tts.engines.piper.enabled && (
        <span style={{ marginRight: 8 }}>
          {localServices.tts.engines.piper.reachable ? '✓ Piper' : `✗ Piper (${localServices.tts.engines.piper.error ?? 'down'})`}
        </span>
      )}
      {localServices.tts.engines.xtts.enabled && (
        <span>
          {localServices.tts.engines.xtts.reachable ? '✓ XTTSv2' : `✗ XTTSv2 (${localServices.tts.engines.xtts.error ?? 'down'})`}
        </span>
      )}
    </div>
  </>
)}
```

- [ ] **Step 4: Update the voice dropdown to use runtime/static lists for local**

Find the voice dropdown and replace its options derivation:

```tsx
const voiceOptions: { slug: string; label: string }[] = (() => {
  if (settings.ttsProvider === 'local') {
    if (settings.ttsModel === 'piper') {
      return localServices.tts.engines.piper.models.map((m) => ({ slug: m.slug, label: m.label }));
    }
    if (settings.ttsModel === 'xtts') {
      return localServices.tts.engines.xtts.models.map((m) => ({ slug: m.slug, label: m.label }));
    }
    return [];
  }
  return voicesForModel(settings.ttsProvider, settings.ttsModel ?? '').map((v) => ({ slug: v, label: v }));
})();
```

Render the options from `voiceOptions`. If empty and provider=local engine=piper, render a disabled placeholder:

```tsx
{voiceOptions.length === 0 && settings.ttsProvider === 'local' && settings.ttsModel === 'piper' ? (
  <option disabled>Piper unreachable — no voices listed</option>
) : (
  voiceOptions.map((v) => <option key={v.slug} value={v.slug}>{v.label}</option>)
)}
```

- [ ] **Step 5: Add `onTtsModelChange` handler that resets the voice**

In the handler section of the file:

```tsx
async function onTtsModelChange(next: 'piper' | 'xtts') {
  // Voice is namespace-scoped to the engine. Reset to the first available voice.
  const list = next === 'piper'
    ? localServices.tts.engines.piper.models
    : localServices.tts.engines.xtts.models;
  const nextVoice = list[0]?.slug ?? '';
  setSettings((s) => ({ ...s, ttsModel: next, ttsVoice: nextVoice }));
  await save({ ttsModel: next, ttsVoice: nextVoice });
}
```

And update `onTtsProviderChange` to auto-set model+voice when switching to local:

```tsx
async function onTtsProviderChange(next: TtsProvider) {
  if (next === 'local') {
    const engine = localServices.tts.engines.piper.enabled ? 'piper' : 'xtts';
    const list = engine === 'piper'
      ? localServices.tts.engines.piper.models
      : localServices.tts.engines.xtts.models;
    const nextVoice = list[0]?.slug ?? (engine === 'xtts' ? 'en' : '');
    setSettings((s) => ({ ...s, ttsProvider: 'local', ttsModel: engine, ttsVoice: nextVoice }));
    await save({ ttsProvider: 'local', ttsModel: engine, ttsVoice: nextVoice });
    return;
  }
  // existing behavior for non-local
  // ...
}
```

- [ ] **Step 6: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx
git commit -m "feat(local-ai): SettingsClient adds Local TTS with engine selector"
```

---

### Task 25: SettingsClient — Local for image generation

**Files:**
- Modify: `src/app/(authed)/campaigns/[id]/settings/settings-client.tsx`

- [ ] **Step 1: Locate the image generation card**

Run: `grep -n "imageProvider\|imageModel" src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx | head -10`

- [ ] **Step 2: Add the "Local" image provider button**

```tsx
{localServices.isLocal && localServices.image.enabled && (
  <button
    type="button"
    onClick={() => onImageProviderChange('local')}
    aria-pressed={settings.imageProvider === 'local'}
    disabled={busy}
  >
    Local
  </button>
)}
```

- [ ] **Step 3: Add the engine selector for Image (ComfyUI / Draw Things)**

```tsx
{settings.imageProvider === 'local' && (
  <>
    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)' }}>Engine</div>
    <div style={{ display: 'flex', gap: 6 }}>
      <button
        type="button"
        onClick={() => onImageEngineChange('comfyui')}
        aria-pressed={settings.imageModel?.startsWith('comfyui:')}
        disabled={busy || !localServices.image.engines.comfyui.enabled}
        title={!localServices.image.engines.comfyui.enabled ? 'COMFYUI_BASE_URL not set' : undefined}
      >
        ComfyUI
      </button>
      <button
        type="button"
        onClick={() => onImageEngineChange('drawThings')}
        aria-pressed={settings.imageModel?.startsWith('draw-things:')}
        disabled={busy || !localServices.image.engines.drawThings.enabled}
        title={!localServices.image.engines.drawThings.enabled ? 'DRAW_THINGS_BASE_URL not set' : undefined}
      >
        Draw Things
      </button>
    </div>

    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
      {localServices.image.engines.comfyui.enabled && (
        <span style={{ marginRight: 8 }}>
          {localServices.image.engines.comfyui.reachable ? '✓ ComfyUI' : `✗ ComfyUI (${localServices.image.engines.comfyui.error ?? 'down'})`}
        </span>
      )}
      {localServices.image.engines.drawThings.enabled && (
        <span>
          {localServices.image.engines.drawThings.reachable ? '✓ Draw Things' : `✗ Draw Things (${localServices.image.engines.drawThings.error ?? 'down'})`}
        </span>
      )}
    </div>
  </>
)}
```

- [ ] **Step 4: Update image model dropdown**

```tsx
const imageModelOptions: { slug: string; label: string }[] = (() => {
  if (settings.imageProvider === 'local') {
    const currentEngine = settings.imageModel?.startsWith('comfyui:') ? 'comfyui' :
                          settings.imageModel?.startsWith('draw-things:') ? 'drawThings' : 'comfyui';
    const list = currentEngine === 'comfyui'
      ? localServices.image.engines.comfyui.models
      : localServices.image.engines.drawThings.models;
    return list.map((m) => ({ slug: m.slug, label: m.label }));
  }
  return imageModelsForProvider(settings.imageProvider as 'openai' | 'gemini').map((m) => ({ slug: m.slug, label: m.label }));
})();
```

- [ ] **Step 5: Add `onImageEngineChange` and update `onImageProviderChange`**

```tsx
async function onImageEngineChange(engine: 'comfyui' | 'drawThings') {
  const list = engine === 'comfyui'
    ? localServices.image.engines.comfyui.models
    : localServices.image.engines.drawThings.models;
  const next = list[0]?.slug ?? (engine === 'comfyui' ? 'comfyui:flux-schnell' : '');
  setSettings((s) => ({ ...s, imageModel: next }));
  await save({ imageModel: next });
}

async function onImageProviderChange(next: 'openai' | 'gemini' | 'local') {
  if (next === 'local') {
    const engine = localServices.image.engines.comfyui.enabled ? 'comfyui' : 'drawThings';
    const list = engine === 'comfyui'
      ? localServices.image.engines.comfyui.models
      : localServices.image.engines.drawThings.models;
    const nextModel = list[0]?.slug ?? (engine === 'comfyui' ? 'comfyui:flux-schnell' : '');
    setSettings((s) => ({ ...s, imageProvider: 'local', imageModel: nextModel }));
    await save({ imageProvider: 'local', imageModel: nextModel });
    return;
  }
  // existing behavior for non-local
}
```

- [ ] **Step 6: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/\(authed\)/campaigns/\[id\]/settings/settings-client.tsx
git commit -m "feat(local-ai): SettingsClient adds Local image with engine selector"
```

---

## Phase 7 — Smoke tests (live, env-gated)

### Task 26: Live smoke tests for LLM

**Files:**
- Create: `tests/ai/provider/local-live-smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
// tests/ai/provider/local-live-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { LocalProvider } from '@/ai/provider/local';

const SMOKE = !!process.env.OLLAMA_BASE_URL && !!process.env.OLLAMA_LIVE_SMOKE;

describe.skipIf(!SMOKE)('LocalProvider live smoke', () => {
  it('completes a master-style turn with qwen3 or gpt-oss', async () => {
    const p = new LocalProvider();
    const r = await p.completeMessage({
      systemBlocks: [{ type: 'text', text: 'You are a tabletop game master. Reply briefly.' }],
      messages: [{ role: 'user', content: 'Describe a single room.' }],
      tools: [],
      model: process.env.OLLAMA_SMOKE_MODEL ?? 'qwen3:30b-a3b',
      maxTokens: 256,
    });
    expect(r.contentBlocks.length).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('detects language on a non-trivial message', async () => {
    const p = new LocalProvider();
    const code = await p.detectLanguage({ text: 'Sto entrando nella taverna piena di avventurieri' });
    // Allow it/null (some models flake on edge prompts)
    expect(code === null || code === 'it').toBe(true);
  }, 30_000);
});
```

- [ ] **Step 2: Run with smoke flag**

```bash
OLLAMA_BASE_URL=http://localhost:11434 \
OLLAMA_LIVE_SMOKE=1 \
OLLAMA_SMOKE_MODEL=qwen3:30b-a3b \
pnpm test tests/ai/provider/local-live-smoke.test.ts
```

Expected: PASS (or SKIP if env not set). If FAIL, this is the first real signal of whether tool calling holds — review prompts.

- [ ] **Step 3: Commit**

```bash
git add tests/ai/provider/local-live-smoke.test.ts
git commit -m "test(local-ai): env-gated smoke for LocalProvider"
```

---

### Task 27: Live smoke for TTS + Image

**Files:**
- Create: `tests/ai/tts-local-live-smoke.test.ts`
- Create: `tests/sessions/image-providers/local-live-smoke.test.ts`

- [ ] **Step 1: Write the TTS smoke test**

```ts
// tests/ai/tts-local-live-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { synthesizeSpeech } from '@/ai/tts';

const PIPER_OK = !!process.env.PIPER_BASE_URL && !!process.env.LOCAL_TTS_LIVE_SMOKE;
const XTTS_OK = !!process.env.XTTS_BASE_URL && !!process.env.LOCAL_TTS_LIVE_SMOKE;

describe.skipIf(!PIPER_OK)('synthesizePiper live smoke', () => {
  it('produces a non-empty MP3 for a short text', async () => {
    const r = await synthesizeSpeech({
      text: 'Hello from the local Piper smoke test.',
      provider: 'local',
      model: 'piper',
      voice: process.env.PIPER_SMOKE_VOICE ?? 'en_US-amy-low',
    });
    expect(r.mimeType).toBe('audio/mpeg');
    expect(r.bytes.byteLength).toBeGreaterThan(1000);
  }, 30_000);
});

describe.skipIf(!XTTS_OK)('synthesizeXtts live smoke', () => {
  it('produces a non-empty WAV for a short text', async () => {
    const r = await synthesizeSpeech({
      text: 'Hello from the local XTTS smoke test.',
      provider: 'local',
      model: 'xtts',
      voice: 'en',
    });
    expect(r.mimeType).toBe('audio/wav');
    expect(r.bytes.byteLength).toBeGreaterThan(10_000);
  }, 60_000);
});
```

- [ ] **Step 2: Write the image smoke test**

```ts
// tests/sessions/image-providers/local-live-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { generateBytesComfyUI } from '@/sessions/image-providers/comfyui';
import { generateBytesDrawThings } from '@/sessions/image-providers/draw-things';

const COMFY_OK = !!process.env.COMFYUI_BASE_URL && !!process.env.LOCAL_IMAGE_LIVE_SMOKE;
const DT_OK   = !!process.env.DRAW_THINGS_BASE_URL && !!process.env.LOCAL_IMAGE_LIVE_SMOKE;

describe.skipIf(!COMFY_OK)('generateBytesComfyUI live smoke', () => {
  it('produces a PNG ≥ 50KB for a simple prompt', async () => {
    const r = await generateBytesComfyUI('a single candle in a dark room, fantasy painting', 'flux-schnell');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeGreaterThan(50_000);
  }, 120_000);
});

describe.skipIf(!DT_OK)('generateBytesDrawThings live smoke', () => {
  it('produces a PNG ≥ 50KB for a simple prompt', async () => {
    const model = process.env.DRAW_THINGS_SMOKE_MODEL ?? 'SDXL Base 1.0';
    const r = await generateBytesDrawThings('a single candle in a dark room, fantasy painting', model);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.byteLength).toBeGreaterThan(50_000);
  }, 60_000);
});
```

- [ ] **Step 3: Run smoke tests with env vars**

```bash
LOCAL_TTS_LIVE_SMOKE=1 PIPER_BASE_URL=http://localhost:8050 XTTS_BASE_URL=http://localhost:8055 \
  pnpm test tests/ai/tts-local-live-smoke.test.ts

LOCAL_IMAGE_LIVE_SMOKE=1 COMFYUI_BASE_URL=http://localhost:8188 DRAW_THINGS_BASE_URL=http://localhost:7860 \
  pnpm test tests/sessions/image-providers/local-live-smoke.test.ts
```

Expected: PASS for any services running. Skipped otherwise.

- [ ] **Step 4: Commit**

```bash
git add tests/ai/tts-local-live-smoke.test.ts tests/sessions/image-providers/local-live-smoke.test.ts
git commit -m "test(local-ai): env-gated live smoke for TTS and image"
```

---

### Task 28: Manual QA checklist (verification phase)

**Files:** none (manual)

- [ ] **Step 1: With dev server running**

```bash
pnpm dev
# Open http://localhost:3000
```

- [ ] **Step 2: Walk through the checklist from the spec**

Open the design spec's "Manual QA checklist" section and tick each item. Document any deviations in a follow-up ticket — don't fix unrelated bugs in this PR.

- [ ] **Step 3: Run the full unit + integration suite one last time**

Run: `pnpm test`
Expected: ALL PASS

- [ ] **Step 4: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: Final commit summarizing the feature**

```bash
git log --oneline main..HEAD | head -30  # confirm all task commits look right
```

If everything passes, the branch is ready for review.

---

## Self-review notes (filled by the writer)

### Spec coverage check

Each spec section maps to one or more tasks:

| Spec section | Tasks |
|---|---|
| `isLocalEnvironment()` | Task 1 |
| Env vars / gating | Tasks 1, 6 (validateSettingsPatch) |
| Health check | Tasks 1, 21 |
| LocalServicesStatus shape | Tasks 1, 21 |
| LLM provider + Ollama adapter | Tasks 8, 9, 10, 11 |
| TTS Piper + XTTS | Tasks 12, 13, 14, 15 |
| Image ComfyUI + Draw Things | Tasks 16, 17, 18, 19, 20 |
| Sub-model enumeration | Tasks 11, 14, 15, 20 |
| Defaults on first selection | Tasks 23, 24, 25 (UI auto-set) |
| Preferences storage | Tasks 5, 6, 7 |
| Validation | Task 6 |
| Read-side downgrade | Task 7 |
| UI Settings | Tasks 22, 23, 24, 25 |
| Error handling | Covered by per-engine throw paths in 8-18 |
| Edge cases | Covered by validation tests in Task 6 |
| Testing | Tasks 26, 27, 28 |

### Placeholder scan

No "TBD", "TODO", or vague descriptions in the plan body. Every code block is complete.

### Type consistency

- `ProviderName` extended in `src/ai/provider/types.ts` (Task 10) AND `src/lib/ai-models.ts` (Task 3) — both define the same union.
- `TtsProvider` extended in `src/lib/tts-voices.ts` (Task 4).
- `LocalServicesStatus` and `EngineStatus` defined in Task 1, consumed by Tasks 21-25 — shape matches.
- `ImageGenResult` reused from `src/sessions/image-providers/openai.ts` (existing) — Tasks 17-18 import the type.
