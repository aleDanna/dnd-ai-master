import type { RetrievedChunk } from './types';

/**
 * Render retrieved chunks as a single system-prompt block. The header is
 * deliberately verbose ("relevant", "use as reference") so the model
 * understands these aren't gospel — they're best-effort retrievals that
 * may or may not be on-topic.
 */
export function formatRagBlock(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  const body = chunks
    .map((c) => `### ${c.source} > ${c.sectionPath}\n${c.content}`)
    .join('\n\n');
  return `## RELEVANT CONTEXT (handbook + lore excerpts, use as reference if applicable)\n\n${body}`;
}
