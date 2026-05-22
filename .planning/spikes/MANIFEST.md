# Spike Manifest

## Idea

Validate the feasibility of migrating `dnd-ai-master` from RAG (Postgres + pgvector + Ollama embedder) and Postgres dynamic state to a **filesystem-only markdown vault** navigated directly by the LLM via tool calls. Static knowledge (handbook, spells, monsters, rules) uses path-deterministic access; dynamic state (campaigns, characters, sessions) uses wiki-link traversal with frontmatter+body files. Tool contract is lazy-loaded from `/tools/`. Target production hardware: **Mac Mini M4** (32GB RAM, 120 GB/s bandwidth, 256GB SSD).

Companion design docs:
- [docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md](../../docs/superpowers/specs/2026-05-22-vault-llm-wiki-design.md)
- [docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md](../../docs/superpowers/specs/2026-05-22-vault-llm-wiki-risks.md)

## Requirements

Design decisions locked during `/gsd-explore`, non-negotiable for the real build unless explicitly revised:

- **Vault = filesystem-only.** Obsidian-app optional. Knowledge layer holds no DB.
- **Static retrieval = path-deterministic.** `/handbook/<category>/<id>.md`.
- **Dynamic retrieval = wiki-link traversal.** Entry from `/campaigns/<id>/index.md`.
- **Mutability = frontmatter + body per file.** Atomic `rename(2)` write for patches; `events.md` append-only log as source-of-truth for replay.
- **Tool contract = lazy-loaded via index** (revised by spike 002): LLM reads `/tools/index.md` once at session start, then may use any listed tool directly. Per-tool `/tools/<name>.md` lookups are optional/preferred but not enforced. Strict per-tool lookup proved impractical on local models; index-based discovery achieves the same end (no inline tool contract) while matching observed model behavior.
- **Primary local model = gpt-oss:20b** (revised by spike 002). qwen3:30b-a3b retained as quality-fallback. llama3.2:3b eliminated (unable to follow tool protocol).
- **Server accepts both turn terminators:** `end_turn` tool call AND `no_tool_calls + content` are both valid completions.
- **Target hardware = Mac Mini M4.** All G1 wall-clock measurements must be validated on M4 before commit.

## Decision Gates (from risk register)

| Gate | Condition | Spike |
|---|---|---|
| **G1** | ≥40% wall-clock improvement on M4 (warm operation) | ✓ GREEN on M5 Pro (-63.1% warm); M4 measurement pending |
| **G2** | Lenient tool discovery compliance ≥90% (read `/tools/index.md` once, then use tools) | ✓ GREEN (002: gpt-oss:20b 100%, qwen3:30b 100%) |
| G3-G5 | Migration / DR gates | Out of scope for this spike round |

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | vault-harness-bootstrap | standard | Node script with Ollama client + 3 stub tools completes a happy-path D&D turn | ✓ VALIDATED — but lazy-tools protocol violated by best local model on 1st run | foundation, ollama |
| 002 | tool-discovery-compliance | standard | LLM reads `/tools/<name>.md` before invoking tool — ≥90% across cold turns, multiple models | ⚠ PARTIAL — strict 0%, lenient 100% on gpt-oss/qwen3; llama3.2:3b unsuitable | g2, compliance, ollama, model-selection |
| 003 | prefill-walltime-savings | standard | Vault path achieves ≥40% wall-clock improvement vs baked baseline | ✓ VALIDATED — warm -63.1% on M5 Pro; cold ~tie; quality preserved or better | g1, benchmark, ollama |

Spike 004 (frontmatter atomicity) and 005 (events.md replay) are queued for a follow-up round, contingent on 001-003 passing.
