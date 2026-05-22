import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type EventType =
  | "turn_start"
  | "ollama_request"
  | "ollama_response"
  | "tool_call"
  | "tool_result"
  | "end_turn"
  | "error"
  | "summary";

export interface LogEvent {
  ts: string;
  type: EventType;
  [key: string]: unknown;
}

export class ForensicLog {
  private path: string;
  private events: LogEvent[] = [];

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  emit(type: EventType, payload: Record<string, unknown> = {}): void {
    const event: LogEvent = { ts: new Date().toISOString(), type, ...payload };
    this.events.push(event);
    appendFileSync(this.path, JSON.stringify(event) + "\n");
  }

  summary(): {
    duration_ms: number;
    event_counts: Record<string, number>;
    tool_calls: { name: string; ok: boolean }[];
    total_prompt_eval_ms: number;
    total_eval_ms: number;
    total_prompt_tokens: number;
    total_eval_tokens: number;
  } {
    const counts: Record<string, number> = {};
    for (const e of this.events) counts[e.type] = (counts[e.type] || 0) + 1;

    const tool_calls = this.events
      .filter((e) => e.type === "tool_call")
      .map((e) => ({ name: e.name as string, ok: e.ok !== false }));

    let total_prompt_eval_ms = 0;
    let total_eval_ms = 0;
    let total_prompt_tokens = 0;
    let total_eval_tokens = 0;
    for (const e of this.events) {
      if (e.type !== "ollama_response") continue;
      total_prompt_eval_ms += (e.prompt_eval_duration_ms as number) || 0;
      total_eval_ms += (e.eval_duration_ms as number) || 0;
      total_prompt_tokens += (e.prompt_eval_count as number) || 0;
      total_eval_tokens += (e.eval_count as number) || 0;
    }

    const start = new Date(this.events[0]?.ts ?? Date.now()).getTime();
    const end = new Date(this.events.at(-1)?.ts ?? Date.now()).getTime();
    return {
      duration_ms: end - start,
      event_counts: counts,
      tool_calls,
      total_prompt_eval_ms,
      total_eval_ms,
      total_prompt_tokens,
      total_eval_tokens,
    };
  }
}
