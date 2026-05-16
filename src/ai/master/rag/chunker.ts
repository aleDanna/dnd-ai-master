import type { Chunk, ChunkSource } from './types';

export interface ChunkerOptions {
  /** Max tokens per chunk (chars/4 heuristic). */
  maxTokens: number;
  /** Tokens of overlap when a section exceeds maxTokens and must split. */
  overlapTokens: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  maxTokens: 300,
  overlapTokens: 50,
};

interface Section {
  path: string;
  body: string;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split markdown into sections at H2 and H3 boundaries. Headings deeper
 * than H3 stay inline in the body — chunking only at top-level structure
 * keeps the path readable and the chunks self-contained.
 */
function splitIntoSections(md: string): Section[] {
  const lines = md.split('\n');
  const sections: Section[] = [];
  let h2: string | null = null;
  let h3: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (!body) {
      buffer = [];
      return;
    }
    const path = h2 && h3 ? `${h2} > ${h3}` : h2 ?? '(root)';
    sections.push({ path, body });
    buffer = [];
  };

  for (const line of lines) {
    // Skip H1 headings — they are document titles, not section boundaries
    if (/^#\s/.test(line) && !/^##/.test(line)) continue;
    const h2Match = /^##\s+(.+?)\s*$/.exec(line);
    const h3Match = /^###\s+(.+?)\s*$/.exec(line);
    if (h2Match) {
      flush();
      h2 = h2Match[1]!;
      h3 = null;
      continue;
    }
    if (h3Match) {
      flush();
      h3 = h3Match[1]!;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * Split a single section's body into sub-chunks if it exceeds maxTokens.
 * We split on word boundaries (whitespace) to avoid mid-word cuts; overlap is
 * applied by carrying the last `overlapTokens` words forward. Chunk size is
 * measured with the chars/4 token heuristic to match the maxTokens contract.
 */
function splitOversize(body: string, opts: ChunkerOptions): string[] {
  if (approxTokens(body) <= opts.maxTokens) return [body];
  const words = body.split(/\s+/);
  const maxChars = opts.maxTokens * 4;
  const out: string[] = [];
  let start = 0;

  while (start < words.length) {
    // Greedily accumulate words until we'd exceed maxChars
    let end = start;
    let len = 0;
    while (end < words.length) {
      const addition = (end > start ? 1 : 0) + words[end]!.length; // +1 for space
      if (len + addition > maxChars && end > start) break;
      len += addition;
      end++;
    }

    const slice = words.slice(start, end).join(' ');
    if (slice.trim()) out.push(slice);

    if (end >= words.length) break;

    // Advance by (chunk size - overlap), measured in words
    const overlap = Math.min(opts.overlapTokens, end - start - 1);
    start = end - overlap;
  }

  return out;
}

/**
 * Public entry. Produces a flat list of chunks ready for embedding.
 */
export function chunkMarkdown(
  source: ChunkSource,
  markdown: string,
  opts: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS,
): Chunk[] {
  const sections = splitIntoSections(markdown);
  const out: Chunk[] = [];
  for (const s of sections) {
    const parts = splitOversize(s.body, opts);
    for (const p of parts) {
      out.push({ source, sectionPath: s.path, content: p });
    }
  }
  return out;
}
