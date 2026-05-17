#!/usr/bin/env zsh
# dnd-ai-master — Ollama daemon env setup
#
# launchctl setenv values do NOT persist across Mac reboots, so without
# this script, every reboot reverts OLLAMA_MAX_LOADED_MODELS to its
# default (1) and the RAG embedder competes with the master LLM for the
# only slot — embedder times out, rag_chunk_count silently drops to 0.
#
# Run this once after each reboot, OR call from your shell startup
# (.zshrc). Idempotent: re-running when Ollama is already correctly
# configured is a no-op (no restart).

setopt err_exit

# Target values — keep in sync with README "Critical for unified-memory
# Macs" section.
typeset -A WANTED
WANTED=(
  OLLAMA_MAX_LOADED_MODELS 2
  OLLAMA_NUM_PARALLEL      2
  OLLAMA_NUM_CTX           32768
  OLLAMA_FLASH_ATTENTION   1
)

# 1. Set launchctl env (affects future processes launched by launchd,
#    including GUI apps).
for var val in "${(@kv)WANTED}"; do
  launchctl setenv "$var" "$val"
done

# 2. Check whether the running Ollama daemon has the right env.
#    If yes, we're done. If no, restart Ollama so it picks up the new
#    values from launchd.
local needs_restart=false
local ollama_line
ollama_line=$(ps -E -ax 2>/dev/null | grep "ollama serve" | grep -v grep | head -1)

if [[ -z "$ollama_line" ]]; then
  needs_restart=true
else
  for var val in "${(@kv)WANTED}"; do
    if ! echo "$ollama_line" | tr ' ' '\n' | grep -qx "${var}=${val}"; then
      needs_restart=true
      break
    fi
  done
fi

if $needs_restart; then
  echo "[dnd-ai-master] restarting Ollama with:"
  for var val in "${(@kv)WANTED}"; do
    echo "                    $var=$val"
  done
  killall Ollama 2>/dev/null || true
  sleep 2
  open -a Ollama
  echo "[dnd-ai-master] Ollama restarted. Give it ~5s to warm up."
else
  echo "[dnd-ai-master] Ollama already running with correct env. ✓"
fi
