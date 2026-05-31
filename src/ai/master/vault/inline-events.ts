/**
 * Inline-event fallback parser.
 *
 * Local models (notably qwen3) are *supposed* to drive D&D combat by calling
 * the `apply_event` tool. In practice they frequently make ZERO tool calls and
 * instead "leak" the events as **markdown bold** text inside their narration —
 * so the combat state is never actually applied. This module is a server-side
 * recovery pass: it scans the model's text for those leaked markers, parses the
 * (often non-strict-JSON) payloads, and returns both the recovered events and a
 * cleaned narration with the markers/payloads stripped out.
 *
 * The integration into the tool loop is done elsewhere; this is the pure parser.
 *
 * Determinism contract: pure function. No I/O, no Date.now, no Math.random, no
 * globals. Same input → same output.
 */

export interface InlineEvent {
  type: string;
  payload: Record<string, unknown>;
}

export interface ParsedInlineEvents {
  events: InlineEvent[];
  cleanedText: string;
}

/** A markdown bold span `**...**`, located by absolute string offsets. */
interface BoldMarker {
  /** Index of the opening `**`. */
  start: number;
  /** Index just past the closing `**`. */
  end: number;
  /** The text between the `**` fences, verbatim. */
  inner: string;
}

/** A span of the source text scheduled for removal from `cleanedText`. */
interface Consumed {
  start: number;
  end: number;
}

const BOLD_RE = /\*\*([\s\S]*?)\*\*/g;

/**
 * Strip an optional single pair of surrounding double-quotes (and whitespace)
 * from a marker's inner text. `"combat_start"` → `combat_start`.
 */
function unwrapMarkerName(inner: string): string {
  const trimmed = inner.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Tolerantly parse a payload object literal. The model emits non-strict JSON
 * with unquoted keys (`{id: "x", hpMax: 24}`), so we escalate:
 *   1. strict `JSON.parse`
 *   2. quote bare keys, then `JSON.parse`
 *   3. additionally drop trailing commas, then `JSON.parse`
 * Returns `undefined` if every attempt fails (caller then skips the event).
 */
function tolerantParseObject(raw: string): Record<string, unknown> | undefined {
  const attempts: string[] = [raw];

  // Quote unquoted object keys: `{id:` / `, hpMax:` → `{"id":` / `, "hpMax":`.
  const keyQuoted = raw.replace(
    /([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g,
    '$1"$2"$3',
  );
  attempts.push(keyQuoted);

  // Also tolerate trailing commas before a closing brace/bracket.
  const noTrailingCommas = keyQuoted.replace(/,(\s*[}\]])/g, '$1');
  attempts.push(noTrailingCommas);

  for (const candidate of attempts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (isPlainObject(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Find a balanced `{...}` brace span starting at `from`, skipping only
 * whitespace and markdown hard-break / single-newline characters before the
 * opening brace. Brace depth accounts for nested `{}` and `[]` and ignores
 * braces/brackets that appear inside string literals.
 *
 * Returns the [openIndex, closeIndexExclusive) of the balanced object, or
 * `undefined` if the next non-gap character is not `{` or the braces never
 * balance.
 */
function findBalancedObject(
  text: string,
  from: number,
): { start: number; end: number } | undefined {
  let i = from;
  // Allow spaces, tabs, and at most a single newline between marker and object
  // (markdown hard breaks are trailing spaces + newline).
  let newlines = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') {
      newlines += 1;
      if (newlines > 1) return undefined;
      i += 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
    } else {
      break;
    }
  }
  if (text[i] !== '{') return undefined;

  const open = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let j = open; j < text.length; j += 1) {
    const ch = text[j]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return { start: open, end: j + 1 };
      }
    }
  }
  return undefined;
}

/**
 * If a parsed payload restates the event name under its own `type` key
 * (form (b): `{"type":"combat_start", ...}`), drop that key so the marker
 * type is not duplicated into the payload. Any other `type` value is left
 * untouched.
 */
function stripRedundantType(
  payload: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  if (typeof payload.type === 'string' && payload.type === name) {
    const { type: _omit, ...rest } = payload;
    void _omit;
    return rest;
  }
  return payload;
}

/**
 * Tidy the narration once markers + payloads have been excised:
 *   - strip markdown hard-break trailing spaces on each line,
 *   - collapse 3+ consecutive newlines to exactly 2,
 *   - trim leading/trailing whitespace.
 */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseInlineEvents(
  text: string,
  allowedTypes: ReadonlySet<string>,
): ParsedInlineEvents {
  const events: InlineEvent[] = [];
  const consumed: Consumed[] = [];

  // Collect every bold span up front so we can tell whether a standalone JSON
  // line belongs to a marker or is itself adjacent to the next marker.
  const markers: BoldMarker[] = [];
  BOLD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOLD_RE.exec(text)) !== null) {
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      inner: match[1] ?? '',
    });
  }

  for (let m = 0; m < markers.length; m += 1) {
    const marker = markers[m]!;
    const name = unwrapMarkerName(marker.inner);
    if (!allowedTypes.has(name)) {
      continue;
    }

    let payload: Record<string, unknown> = {};
    let consumedEnd = marker.end;
    const nextMarkerStart = m + 1 < markers.length ? markers[m + 1]!.start : text.length;

    // After the marker, optionally an object — either inline on the same span
    // (form a, unquoted-key brace object) or on the following line (form b,
    // standalone JSON, common after a quoted marker). Both are located the same
    // way: skip whitespace / a single newline, then read a balanced `{...}`.
    const object = findBalancedObject(text, marker.end);
    if (object && object.start < nextMarkerStart) {
      const parsed = tolerantParseObject(text.slice(object.start, object.end));
      if (parsed === undefined) {
        // Irrecoverable payload → skip the whole event (robustness > completeness).
        continue;
      }
      // Form (b) restates the event name under `type`; drop it so it is not
      // duplicated into the payload. Applies to both forms uniformly.
      payload = stripRedundantType(parsed, name);
      consumedEnd = object.end;
    }

    events.push({ type: name, payload });
    consumed.push({ start: marker.start, end: consumedEnd });
  }

  if (consumed.length === 0) {
    return { events, cleanedText: tidy(text) };
  }

  // Rebuild the text without the consumed spans (they are already in order and
  // non-overlapping by construction).
  let cleaned = '';
  let cursor = 0;
  for (const span of consumed) {
    cleaned += text.slice(cursor, span.start);
    cursor = span.end;
  }
  cleaned += text.slice(cursor);

  return { events, cleanedText: tidy(cleaned) };
}
