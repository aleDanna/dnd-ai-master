import { createHash } from 'node:crypto';
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
import { isBakedModel, thinkingFlagFor } from '@/ai/master/baked-models';
import { ollamaHeaders } from '@/lib/local-fetch';

const KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE ?? '5m';
// Ollama defaults `num_ctx` to 2048 which truncates the master prompt
// (system + 18 tool defs + history is typically 30-45k tokens). Set high
// enough to FIT the full prompt without truncation — otherwise the KV
// prefix cache misses on every turn because Ollama's sliding-window
// truncation shifts the effective prefix between requests.
// Both qwen3:30b-a3b and gpt-oss:20b support 128k context natively.
// Cost: each extra 8k of num_ctx allocates ~2-4GB of KV cache RAM (model
// dependent). User can lower via OLLAMA_NUM_CTX if RAM-bound.
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? '65536');

/** Back-compat: legacy callers test "is this a thinking model?" as a
 *  boolean. The single source of truth (thinkingFlagFor) is now in
 *  baked-models.ts so the turn route can reuse it. Map the tri-state
 *  down to a boolean for the `noReasoning` preamble path which only
 *  cares whether the model has a thinking head at all (true for both
 *  Max 3 with thinking-on AND the others with thinking-off-via-flag). */
function isThinkingModel(model: string | undefined): boolean {
  return thinkingFlagFor(model) !== undefined;
}

/** qwen3 responds to a `/no_think` control token in the user message — BUT
 *  only when the request has no tools. With tools present qwen3 silently
 *  ignores the marker and still produces a chain-of-thought (which it parks
 *  in the `thinking` field, leaving content empty and the tool loop with
 *  nothing to render). Since we always include tools on master turns and on
 *  wizard proposals, /no_think is a no-op for our use case — keep the
 *  thinking phase, then strip the `<think>…</think>` envelope at the
 *  adapter layer (stripThinkingFromContent in ollama-adapter.ts).
 *
 *  Kept as a stub so the call sites stay symmetric; can re-enable selectively
 *  for tool-less calls later (e.g. detectLanguage already skips it). */
function prependNoThinkIfQwen3(messages: OllamaMessage[], _model: string | undefined): OllamaMessage[] {
  return messages;
}

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
  /** Streaming: present on every chunk; non-streaming: absent or true on
   *  the single response. We use it in the NDJSON consumer to detect the
   *  final frame (which carries the usage stats). */
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  load_duration?: number;
}

function fingerprintSystem(body: unknown): string {
  try {
    const b = body as { messages?: { role: string; content: string }[] };
    const sys = b.messages?.find((m) => m.role === 'system')?.content ?? '';
    const h = createHash('md5').update(sys).digest('hex').slice(0, 8);
    return `len=${sys.length} h=${h}`;
  } catch {
    return 'n/a';
  }
}

// Markerless reasoning openers that small local models (qwen3:4b, llama3.2:3b)
// emit at the start of `content` when they ignore `think: false`. Matched
// against the first chunk window (~80 chars) — when we see one of these
// patterns we treat the stream as "in thinking mode" until we hit a
// paragraph break followed by non-reasoning content.
//
// Pattern philosophy: legitimate narration in the campaign language
// (Italian/English/...) is in second-person ("You see...", "Vedi...") OR
// describes a scene/NPC directly ("La luce dell'alba...", "Il guardiano..."),
// it NEVER opens with "The user / The current state / The player / The DC /
// The scene card / The tool / The rules / Wait / Okay / Let me / I need to /
// According to / Since the / First, ...". So anything matching these is
// meta-reasoning to drop.
const MARKERLESS_THINKING_OPENERS = /^[ \t\r\n]*(?:Okay,?|Alright,?|Hmm,?|Wait,?|Let'?s|Let me|First,?|Then,?|Now,?|So,?|But,?|However,?|Looking at|Given (?:the|that|what|how)|Since (?:the|that|what)|Considering|Based on|According to|To (?:handle|address|resolve|adjudicate|narrate|determine|figure)|The (?:user|player|current|scene|tool|tools|DC|roll|rules|sentry|monster|enemy|character|response|narration|next|previous|action|situation|lore|handbook|SRD|context|state|game|combat|attack|check|saving|spell|output|task|goal|key|main|first|second|last|final)|We (?:are|have|need|should|must|will|'ll|'re|do|start)|He'?s|She'?s|It'?s|I'(?:ll|ve|m|d|re)|I (?:need|should|must|will|have|can|might|am)|My (?:role|job|task)|Example[ \t]*:|For example,?)/i;

// A paragraph that opens with one of these is still reasoning even after a
// paragraph break. Used to keep state in "thinking" mode across multiple
// reasoning paragraphs before the model finally gets to the narration.
// Same anchored-at-paragraph-start heuristic as above, with a few extra
// English connectors that show up mid-thought.
const REASONING_PARAGRAPH_RE = /^[ \t]*(?:Okay,?|Alright,?|Hmm,?|Wait,?|Let'?s|Let me|First,?|Then,?|Now,?|So,?|But,?|However,?|Also,?|Moreover,?|Additionally,?|Furthermore,?|Therefore,?|Thus,?|Looking at|Given|Since|Considering|Based on|According to|To (?:handle|address|resolve|adjudicate|narrate|determine|figure)|The (?:user|player|current|scene|tool|tools|DC|roll|rules|sentry|monster|enemy|character|response|narration|next|previous|action|situation|lore|handbook|SRD|context|state|game|combat|attack|check|saving|spell|output|task|goal|key|main|first|second|last|final)|We (?:are|have|need|should|must|will|'ll|'re|do|start|can|might)|He'?s|She'?s|It'?s|I'(?:ll|ve|m|d|re)|I (?:will|should|need|must|can|might|have|am|do)|My (?:role|job|task|response)|Example[ \t]*:|For example,?|Note|Reasoning|Plan|Thought|Thinking|Pensiero|Ragionamento)/i;

// Scalable language heuristic. The regexes above are a backstop for known
// opener phrases, but they require us to keep up with every English meta-
// reasoning template the model invents. The real signal is much simpler:
// if the campaign is non-English and the streaming content starts in
// English, it is necessarily chain-of-thought (the narration MUST be in
// the campaign language per the system prompt). We catch that with a tiny
// stopword count — language-detection libraries would be overkill for
// <100 char windows.
const LANG_STOPWORDS: Record<string, string[]> = {
  en: ['the', 'is', 'are', 'and', 'of', 'to', 'a', 'in', 'that', 'it', 'with', 'for', 'as', 'was', 'on', 'this', 'you', 'your', 'we', 'our', 'they', 'them', 'have', 'has', 'will', 'would', 'should', 'can', 'must'],
  it: ['il', 'la', 'lo', 'le', 'i', 'è', 'di', 'un', "un'", 'una', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'e', 'ma', 'che', 'in', 'con', 'per', 'su', 'gli', 'ti', 'mi', 'ci', 'si', 'al', 'allo', 'alla', 'ai', 'agli', 'alle', 'da', 'dal', 'dalla', 'sei', 'sono', 'hai', 'ha', 'tuo', 'tua'],
  es: ['el', 'los', 'las', 'es', 'son', 'de', 'y', 'en', 'un', 'una', 'que', 'no', 'te', 'le', 'su', 'sus', 'lo', 'al', 'del', 'por', 'para', 'con', 'tu', 'tus'],
  fr: ['le', 'les', 'de', 'et', 'est', 'sont', 'un', 'une', 'des', 'à', 'en', 'dans', 'pour', 'avec', 'sur', 'qui', 'que', 'ce', 'cette', 'tu', 'ton', 'ta', 'tes', 'au', 'aux'],
  de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'ein', 'eine', 'mit', 'von', 'zu', 'auf', 'für', 'ich', 'du', 'sie', 'wir', 'es', 'den', 'dem', 'des', 'dich', 'dir'],
  pt: ['o', 'os', 'as', 'é', 'são', 'de', 'em', 'um', 'uma', 'do', 'da', 'dos', 'das', 'que', 'com', 'por', 'para', 'no', 'na', 'nos', 'nas', 'teu', 'tua', 'tuas'],
};

function countStopwords(text: string, lang: string): number {
  const words = LANG_STOPWORDS[lang];
  if (!words) return 0;
  const lower = text.toLowerCase();
  let count = 0;
  for (const w of words) {
    // \b doesn't behave well around apostrophes / accented chars in JS, so
    // anchor on whitespace/punctuation/string boundaries instead.
    const re = new RegExp(`(?:^|[\\s.,!?;:"'()\\[\\]])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s.,!?;:"'()\\[\\]]|$)`, 'gi');
    const m = lower.match(re);
    if (m) count += m.length;
  }
  return count;
}

/** True when `text` looks like English meta-reasoning emitted on a non-English
 *  campaign. Conservative: requires ≥3 English stopwords AND zero hits for the
 *  expected language. Returns false for English campaigns (would be ambiguous
 *  vs legitimate English narration). */
function looksLikeForeignLanguageCoT(text: string, expectedLang?: string): boolean {
  if (!expectedLang || expectedLang === 'en') return false;
  if (!LANG_STOPWORDS[expectedLang]) return false;
  const englishCount = countStopwords(text, 'en');
  const expectedCount = countStopwords(text, expectedLang);
  return englishCount >= 3 && expectedCount === 0;
}

async function chat(
  body: unknown,
  onDelta?: (text: string) => void,
  onThinking?: (state: 'start' | 'end') => void,
  campaignLanguage?: string,
): Promise<OllamaChatResponse> {
  const t0 = Date.now();
  // eslint-disable-next-line no-console
  console.log('[ollama-start]', `sys[${fingerprintSystem(body)}]`,
    `tools=${(body as { tools?: unknown[] }).tools?.length ?? 0}`,
    `msgs=${(body as { messages?: unknown[] }).messages?.length ?? 0}`,
    `stream=${(body as { stream?: boolean }).stream === true}`);
  // Explicit timeout on the fetch — without this Node's default is
  // infinite and a hung Ollama would deadlock the tool loop silently
  // (the TURN_TIMEOUT_MS check upstream only runs between iterations).
  //
  // 15 min is generous because Plan D cold starts on a3b / 30b models
  // can spend 4-6 min just on prompt eval the first time. After the
  // KEEP_ALIVE window (default 60m), the model unloads and the next
  // first-call pays this again. Tune via OLLAMA_FETCH_TIMEOUT_MS env
  // var if you have a slower machine or are baking even bigger models.
  const fetchTimeoutMs = Number(process.env.OLLAMA_FETCH_TIMEOUT_MS ?? '900000');
  const isStream = (body as { stream?: boolean }).stream === true;
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: 'POST',
    headers: ollamaHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(fetchTimeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ollama chat ${res.status}: ${text}`);
  }

  let json: OllamaChatResponse;
  if (isStream && res.body) {
    json = await consumeStream(res.body, onDelta, onThinking, campaignLanguage);
  } else {
    json = await res.json() as OllamaChatResponse;
  }

  const promptMs = Math.round((json.prompt_eval_duration ?? 0) / 1_000_000);
  const evalMs = Math.round((json.eval_duration ?? 0) / 1_000_000);
  const loadMs = Math.round((json.load_duration ?? 0) / 1_000_000);
  const tokPerSec = json.eval_count && evalMs > 0 ? Math.round((json.eval_count / evalMs) * 1000) : 0;
  // eslint-disable-next-line no-console
  console.log('[ollama]', `${Date.now() - t0}ms`,
    'done_reason=', json.done_reason,
    'content.len=', json.message?.content?.length ?? 0,
    'tool_calls=', json.message?.tool_calls?.length ?? 0,
    `prompt(tok=${json.prompt_eval_count} ms=${promptMs})`,
    `eval(tok=${json.eval_count} ms=${evalMs} = ${tokPerSec}tok/s)`,
    `load=${loadMs}ms`,
    `sys[${fingerprintSystem(body)}]`);
  return json;
}

/**
 * Consume an Ollama `/api/chat` NDJSON stream. Each line is one JSON
 * object of the same shape returned by the non-streaming endpoint, but
 * with `message.content` carrying ONLY the delta since the previous
 * chunk. The final line has `done: true` and the cumulative usage
 * stats.
 *
 * We accumulate the full message content + tool_calls and return a
 * single OllamaChatResponse identical to what the non-stream path
 * produces, so callers don't need to know which mode was used. The
 * `onDelta` callback (if provided) fires for each non-empty content
 * delta — that's how the UI gets tokens live.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
  onThinking?: (state: 'start' | 'end') => void,
  campaignLanguage?: string,
): Promise<OllamaChatResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumContent = '';
  let accumThinking = '';
  const toolCalls: OllamaResponseMessage['tool_calls'] = [];
  let final: OllamaChatResponse | null = null;

  // Streaming state machine for thinking-mode filtering. The model emits
  // chain-of-thought directly into `content` (despite think:false) on small
  // models; we hide those tokens from the UI by holding them back and only
  // pumping real narration through onDelta.
  //
  // States:
  //   'init'      — buffering the opening chars; will transition to either
  //                 'thinking' (markerless or <think>) or 'narration'.
  //   'thinking'  — discarding tokens; watching for </think> or a paragraph
  //                 break followed by non-reasoning content to exit.
  //   'narration' — pumping tokens straight to onDelta.
  // Hold state in an object so closures + TypeScript don't lose narrowing.
  const st: { value: 'init' | 'thinking' | 'narration' } = { value: 'init' };
  let visibleBuffer = ''; // pending content not yet decided/emitted

  const setThinking = (next: 'thinking' | 'narration'): void => {
    if (st.value === 'thinking' && next === 'narration') onThinking?.('end');
    else if (st.value !== 'thinking' && next === 'thinking') onThinking?.('start');
    st.value = next;
  };

  const tryDecide = (): void => {
    // 1. `</think>` close — handled FIRST and independently of whether
    //    we saw the open tag in this buffer slice (we may have already
    //    consumed the open in a previous tryDecide call and trimmed
    //    visibleBuffer down to the post-open suffix).
    const closeIdx = visibleBuffer.indexOf('</think>');
    if (closeIdx >= 0) {
      const tail = visibleBuffer.slice(closeIdx + '</think>'.length).replace(/^\s+/, '');
      setThinking('narration');
      visibleBuffer = '';
      if (tail && onDelta) onDelta(tail);
      return;
    }

    // 2. `<think>` open without close yet — drop everything up to it,
    //    flag thinking, wait for more content.
    const openIdx = visibleBuffer.indexOf('<think>');
    if (openIdx >= 0) {
      setThinking('thinking');
      visibleBuffer = visibleBuffer.slice(openIdx + '<think>'.length);
      return;
    }

    if (st.value === 'init') {
      // Need ~80 chars (or a paragraph break, or stream end) before deciding.
      // Two heuristics, in order of confidence:
      //   1. Opener regex (anchored at start) — fast match on known
      //      meta-reasoning phrases ("Let me", "The user wants", etc.).
      //   2. Language mismatch — if the campaign is non-English and the
      //      first chunk reads as English (≥3 EN stopwords, 0 expected-
      //      lang stopwords), it's CoT regardless of which opener the
      //      model picked. This is the scalable backstop that doesn't
      //      depend on enumerating every English template.
      if (visibleBuffer.length < 80 && !visibleBuffer.includes('\n\n')) return;
      const isReasoningOpener = MARKERLESS_THINKING_OPENERS.test(visibleBuffer);
      const isForeignLang = looksLikeForeignLanguageCoT(visibleBuffer, campaignLanguage);
      if (isReasoningOpener || isForeignLang) {
        setThinking('thinking');
        // fall through to thinking-mode handling below
      } else {
        setThinking('narration');
        if (onDelta && visibleBuffer) onDelta(visibleBuffer);
        visibleBuffer = '';
        return;
      }
    }

    if (st.value === 'thinking') {
      // Look for paragraph breaks. If we find one, evaluate the paragraph
      // AFTER the break with BOTH heuristics (regex + language mismatch).
      // The language check is what catches the long-tail of openers the
      // regex doesn't know about — keeps qwen3:4b runaway CoT bounded
      // without needing to enumerate every "Now I should..." variant.
      const lastBreak = visibleBuffer.lastIndexOf('\n\n');
      if (lastBreak === -1) return; // wait for more
      const after = visibleBuffer.slice(lastBreak + 2);
      if (after.length < 30) return; // wait for enough to evaluate
      const stillReasoning =
        REASONING_PARAGRAPH_RE.test(after) ||
        looksLikeForeignLanguageCoT(after, campaignLanguage);
      if (stillReasoning) {
        // Drop everything up to (and including) the break; keep evaluating.
        visibleBuffer = after;
        return;
      }
      // Narration found. Drop the reasoning prefix, emit the tail.
      setThinking('narration');
      visibleBuffer = '';
      if (onDelta) onDelta(after);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let chunk: Partial<OllamaChatResponse> & { message?: OllamaResponseMessage };
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      const deltaContent = chunk.message?.content ?? '';
      const deltaThinking = (chunk.message as { thinking?: string } | undefined)?.thinking ?? '';
      if (deltaContent) {
        accumContent += deltaContent;
        // Streaming filter path: in narration state we forward directly,
        // otherwise we accumulate in visibleBuffer and let tryDecide()
        // gate the flush.
        if (st.value === 'narration') {
          if (onDelta) onDelta(deltaContent);
        } else {
          visibleBuffer += deltaContent;
          tryDecide();
        }
      }
      if (deltaThinking) {
        // The model used the dedicated `thinking` field — never emit.
        if (st.value !== 'thinking') setThinking('thinking');
        accumThinking += deltaThinking;
      }
      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) toolCalls.push(tc);
      }
      if (chunk.done) {
        // Stream ended. If we're still holding a pending buffer in init
        // or thinking state, take one final decision now: if the buffer
        // looks like narration (didn't match any reasoning opener),
        // flush it; otherwise drop it (reasoning-strip will clean the
        // saved DB record). This is the common path for short responses
        // where the buffer never reached the 80-char decision threshold.
        if (st.value !== 'narration' && visibleBuffer.trim().length > 0) {
          const looksReasoning =
            MARKERLESS_THINKING_OPENERS.test(visibleBuffer) ||
            REASONING_PARAGRAPH_RE.test(visibleBuffer) ||
            looksLikeForeignLanguageCoT(visibleBuffer, campaignLanguage);
          if (looksReasoning) {
            // Pure thinking, no narration tail. Fire 'end' if we ever
            // started so the UI dismisses the placeholder.
            if (st.value === 'thinking') onThinking?.('end');
          } else {
            // Treat as narration — last chance to surface it.
            setThinking('narration');
            if (onDelta) onDelta(visibleBuffer);
          }
          visibleBuffer = '';
        } else if (st.value === 'thinking') {
          onThinking?.('end');
        }
        final = {
          message: {
            role: 'assistant',
            content: accumContent,
            ...(accumThinking ? { thinking: accumThinking } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          } as OllamaResponseMessage,
          done_reason: chunk.done_reason,
          prompt_eval_count: chunk.prompt_eval_count,
          prompt_eval_duration: chunk.prompt_eval_duration,
          eval_count: chunk.eval_count,
          eval_duration: chunk.eval_duration,
          load_duration: chunk.load_duration,
        };
      }
    }
  }
  if (!final) {
    if (st.value === 'thinking') onThinking?.('end');
    final = {
      message: {
        role: 'assistant',
        content: accumContent,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as OllamaResponseMessage,
      done_reason: 'stop',
    };
  }
  return final;
}

export class LocalProvider implements MasterProvider {
  readonly name = 'local' as const;

  async completeMessage(input: CompleteMessageInput): Promise<CompleteMessageOutput> {
    // Plan D (baked models) — Ollama OVERRIDES the Modelfile's SYSTEM
    // directive when the chat request includes a `role: 'system'` message
    // in its `messages` array. Empirically verified: with SYSTEM=DM in
    // the Modelfile and a "you are a pirate" system in the request, the
    // model behaves as a pirate.
    //
    // To preserve the baked content (role description, tool contract,
    // handbook, SRD, ...) we must NOT pass a system role when calling a
    // baked variant. The runtime dynamic content (guidance, langHint,
    // snapshot tail, ...) is injected INTO the latest user message
    // instead of as a separate user-role preamble at the start. This
    // matters for KV-cache: the dynamic content varies per turn
    // (snapshot HP/scene change), so if it sits at the start of the
    // messages array the cache breaks immediately after SYSTEM+tools.
    // By moving it onto the last user message, the entire history
    // before that message stays byte-identical across turns — Ollama
    // hits the cache up to the second-to-last message, dropping
    // prompt-eval time from ~45s to ~10s on warm turns.
    const baked = isBakedModel(input.model ?? '');
    // Anti-thinking nudge for thinking-capable models (qwen3, gpt-oss,
    // deepseek-r1). The baked SYSTEM already forbids chain-of-thought,
    // but these models routinely IGNORE that and dump reasoning in
    // `content` anyway. Wrapping the user message with an explicit "no
    // reasoning in output" reminder is the strongest signal we can
    // give without re-baking the model. Skipped for non-thinking models
    // (no value, just noise + cache invalidation).
    const noReasoning = isThinkingModel(input.model)
      ? '[NO REASONING IN OUTPUT — emit ONLY tool calls (structured API) and the in-character narration in the campaign language. Decide silently. Do not write "First,", "Let me", "The user wants", "I need to", "Wait,", "Okay,", "So the tool calls would be...", or any meta-analysis. Skip step-by-step planning. Go straight to the action.]\n\n'
      : '';
    let messages: OllamaMessage[];
    if (baked) {
      const dynamicContent = input.systemBlocks.map((b) => b.text).join('\n\n');
      const history = anthropicMessagesToOllama(input.messages);
      // Splice the dynamic state into the LAST user message in history.
      // For the synthetic isBegin turn there's only one user message and
      // it carries BEGIN_INSTRUCTION — wrap with state header. For
      // regular turns we wrap the player's input. We splice (not mutate)
      // so the original history array stays a stable reference for
      // anyone else holding it.
      const withState = history.map((m, idx) => {
        if (idx === history.length - 1 && m.role === 'user') {
          return {
            ...m,
            content: `${noReasoning}[CURRENT STATE — per-turn campaign settings + snapshot. Treat as authoritative for THIS turn alongside your baked role/handbook/SRD.]\n\n${dynamicContent}\n\n[END CURRENT STATE]\n\n${m.content}`,
          };
        }
        return m;
      });
      messages = prependNoThinkIfQwen3(withState, input.model);
    } else {
      const systemMsg = anthropicSystemToOllamaMessage(input.systemBlocks);
      // Mirror the anti-thinking nudge for non-baked thinking models too.
      const history = anthropicMessagesToOllama(input.messages);
      const withState = noReasoning
        ? history.map((m, idx) =>
            idx === history.length - 1 && m.role === 'user'
              ? { ...m, content: `${noReasoning}${m.content}` }
              : m,
          )
        : history;
      messages = prependNoThinkIfQwen3([
        ...(systemMsg ? [systemMsg] : []),
        ...withState,
      ], input.model);
    }
    // Stream tokens via NDJSON when the caller passed an onDelta callback.
    // Falls back to the single-shot JSON response otherwise. The streaming
    // path lets the UI surface narrative tokens live (TTFT ~1s instead of
    // wait-for-full-response), while still returning the same assembled
    // OllamaChatResponse shape so downstream tool dispatch / usage logging
    // is unchanged.
    const useStream = typeof input.onDelta === 'function';
    const campaignLanguage = input.campaignLanguage;
    // num_predict cap. Three tiers:
    //
    //  - Small models (3-4B llama/qwen): 2048. They run away with
    //    chain-of-thought when asked to plan + tool-call + narrate; at
    //    4096 they hit the limit mid-thought and the stripped content
    //    comes back empty ("Master non ha prodotto risposta").
    //
    //  - Thinking-ON models (Max 3 = qwen3:30b-a3b currently): 1500.
    //    With MASTER_BRIEF_THINKING_RULE capping <think> at 200 tokens
    //    and a typical narration of 300-500 tokens, 1500 leaves 2-3x
    //    headroom for combat turns with multiple tool calls. Going
    //    higher (4096) just lets the model spend 60-90s of decode on
    //    needless verbosity. The reduction is the single biggest
    //    perceived-latency win on Max 3.
    //
    //  - Capable non-thinking (qwen3-instruct, gpt-oss, mistral):
    //    keep 4096 — they don't dump CoT, and combat-heavy turns with
    //    long multi-tool narrations occasionally need the headroom.
    //
    // Cap can be overridden per-call via `input.maxTokens` (e.g. small
    // utility calls like language detection set 8).
    const isSmallModel = /(?:llama3\.2.*3b|qwen3.*[34]b|gemma2?.*2b|dnd-master-(?:lite|balance))/i.test(input.model ?? '');
    const isThinkingOn = thinkingFlagFor(input.model) === true;
    const defaultMaxTokens = isSmallModel ? 2048 : (isThinkingOn ? 1500 : 4096);
    const json = await chat(
      {
        model: input.model,
        messages,
        tools: input.tools.map(anthropicToolToOllama),
        stream: useStream,
        keep_alive: KEEP_ALIVE,
        think: thinkingFlagFor(input.model),
        options: { num_predict: input.maxTokens ?? defaultMaxTokens, num_ctx: NUM_CTX },
      },
      input.onDelta,
      input.onThinking,
      campaignLanguage,
    );
    const contentBlocks = ollamaResponseToContentBlocks(json.message);
    const hasToolCalls = contentBlocks.some((b) => b.type === 'tool_use');
    return {
      contentBlocks,
      stopReason: ollamaDoneReasonToStopReason(json.done_reason, hasToolCalls),
      usage: normalizeOllamaUsage({
        prompt_eval_count: json.prompt_eval_count,
        eval_count: json.eval_count,
        load_duration: json.load_duration,
        prompt_eval_duration: json.prompt_eval_duration,
        eval_duration: json.eval_duration,
      }),
    };
  }

  async detectLanguage(input: DetectLanguageInput): Promise<string | null> {
    if (isTrivial(input.text)) return null;
    try {
      const langModel = process.env.OLLAMA_LANGUAGE_MODEL ?? process.env.OLLAMA_MASTER_MODEL;
      const json = await chat({
        model: langModel,
        messages: [
          { role: 'system', content: 'You are a language detector. Reply with ONLY the ISO 639-1 lowercase 2-letter language code of the user message (e.g. "en", "it", "es"). No prose, no punctuation.' },
          { role: 'user', content: input.text },
        ],
        stream: false,
        keep_alive: KEEP_ALIVE,
        think: thinkingFlagFor(langModel),
        options: { num_predict: 8, num_ctx: NUM_CTX },
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
            load_duration: json.load_duration,
            prompt_eval_duration: json.prompt_eval_duration,
            eval_duration: json.eval_duration,
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
      messages: prependNoThinkIfQwen3([
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userMessage },
      ], input.model),
      tools: [anthropicToolToOllama(input.toolDefinition)],
      stream: false,
      keep_alive: KEEP_ALIVE,
      think: thinkingFlagFor(input.model),
      options: { num_predict: 1024, num_ctx: NUM_CTX },
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
          load_duration: json.load_duration,
          prompt_eval_duration: json.prompt_eval_duration,
          eval_duration: json.eval_duration,
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
            load_duration: json.load_duration,
            prompt_eval_duration: json.prompt_eval_duration,
            eval_duration: json.eval_duration,
          }),
        };
      }
    }
    throw new Error(`AI did not call ${input.toolDefinition.name}`);
  }
}
