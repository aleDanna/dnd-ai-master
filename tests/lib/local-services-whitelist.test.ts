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
