import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(raw: string): ParsedFile {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: raw };
  const lines = m[1].split("\n");
  const fm: Record<string, unknown> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (val === "") continue;
    const n = Number(val);
    fm[key] = Number.isFinite(n) && val.match(/^-?\d+(\.\d+)?$/) ? n : val;
  }
  return { frontmatter: fm, body: m[2] };
}

export function serializeMarkdown(parsed: ParsedFile): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(parsed.frontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  return `---\n${lines.join("\n")}\n---\n${parsed.body}`;
}

/**
 * Atomic frontmatter patch via read → mutate → tmp-write → rename(2).
 * POSIX rename is atomic on the same filesystem.
 */
export async function patchFrontmatter(
  path: string,
  patch: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const raw = await readFile(path, "utf8");
  const parsed = parseMarkdown(raw);
  parsed.frontmatter = patch(parsed.frontmatter);
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, serializeMarkdown(parsed), "utf8");
  await rename(tmp, path);
}
