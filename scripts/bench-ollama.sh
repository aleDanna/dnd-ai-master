#!/usr/bin/env bash
# Benchmark di un modello Ollama sul caso d'uso "narrazione master D&D".
# Misura: tempo di caricamento, prompt eval rate, generation rate, durata totale.
#
# Uso:
#   scripts/bench-ollama.sh <modello>        # es. qwen3:30b-a3b, gpt-oss:20b
#   scripts/bench-ollama.sh --all            # itera su tutti i modelli installati
#
# Output JSON tabellare in stdout per confronto rapido.

set -euo pipefail

OLLAMA_HOST="${OLLAMA_HOST:-http://localhost:11434}"

SYSTEM_PROMPT='Sei il Dungeon Master di una sessione D&D 5e per un singolo giocatore.
Narra le scene in seconda persona, in italiano, in modo vivido ma conciso (2-6 frasi).
Dai voce agli NPC. Non tirare dadi e non inventare statistiche: il sistema gestisce la meccanica.
Termina con un invito all'azione del giocatore.'

USER_PROMPT='Il mio personaggio, un guerriero nano di nome Thorin, entra cautamente nella taverna "Il Grifone Stanco" a Greenest. È sera tardi. Mi guardo intorno per vedere chi c'\''è e cerco di capire l'\''atmosfera. Cosa noto?'

bench_model() {
    local model="$1"
    echo ""
    echo "═══ $model ═══"

    local response
    response=$(curl -s "$OLLAMA_HOST/api/chat" \
        -H 'Content-Type: application/json' \
        -d "$(cat <<EOF
{
  "model": "$model",
  "messages": [
    {"role": "system", "content": $(jq -Rs . <<<"$SYSTEM_PROMPT")},
    {"role": "user",   "content": $(jq -Rs . <<<"$USER_PROMPT")}
  ],
  "stream": false,
  "options": { "temperature": 0.8, "num_predict": 400 }
}
EOF
)")

    if [[ -z "$response" ]] || ! jq -e . >/dev/null 2>&1 <<<"$response"; then
        echo "ERROR: risposta non valida"
        echo "$response" | head -5
        return 1
    fi

    jq -r '
      def ms(ns): (ns / 1000000 | floor);
      def tps(count; ns): if ns == 0 then 0 else (count * 1000000000 / ns | floor) end;
      "model:           " + .model,
      "total_ms:        " + (ms(.total_duration) | tostring),
      "load_ms:         " + (ms(.load_duration) | tostring),
      "prompt_tokens:   " + (.prompt_eval_count | tostring) + " (" + (tps(.prompt_eval_count; .prompt_eval_duration) | tostring) + " tok/s)",
      "output_tokens:   " + (.eval_count | tostring) + " (" + (tps(.eval_count; .eval_duration) | tostring) + " tok/s)",
      "── output ──",
      .message.content
    ' <<<"$response"
}

if [[ "${1:-}" == "--all" ]]; then
    for m in $(ollama list | awk 'NR>1 && $2 ~ /^[a-f0-9]+$/ {print $1}'); do
        bench_model "$m"
    done
elif [[ -n "${1:-}" ]]; then
    bench_model "$1"
else
    echo "Uso: $0 <modello> | --all" >&2
    exit 1
fi
