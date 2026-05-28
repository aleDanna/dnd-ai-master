#!/usr/bin/env bash
# Spike 004: m4-validation
#
# Sweeps spike 002 (compliance) and spike 003 (wall-clock) across the
# 5 candidate models on Mac Mini M4 production hardware. Each model
# is tested as the vault candidate against the dnd-master-plus baked
# baseline. Compliance is measured with V2_strict prompt.
#
# Decision-grade for G1 (≥40% warm wall) and G2 (≥90% lenient compliance).

set -euo pipefail

cd "$(dirname "$0")/../../.."

ARCH=$(uname -m)
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown")
RAM_GB=$(($(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824))

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Spike 004: M4 Validation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Architecture: $ARCH"
echo "CPU: $CHIP"
echo "RAM: ${RAM_GB} GB"
echo ""

if [[ "$CHIP" != *"M4"* ]]; then
  echo "⚠ WARNING: this script is meant to run on a Mac Mini M4 (target prod hardware)."
  echo "  Current chip: $CHIP"
  echo "  Continuing anyway, but results are NOT decision-grade for G1."
  echo ""
  read -r -p "Continue? [y/N] " ans
  [[ "$ans" =~ ^[yY]$ ]] || exit 1
fi

# Candidate models for M4 production. Order matters: smallest first so
# we see fast feedback before committing to the longer 30b runs.
# Override with SPIKE_CANDIDATES="modelA modelB" (space-separated) to run an
# ad-hoc subset — e.g. a single-model A/B comparison. Defaults below are the
# spike-004 candidate set.
if [ -n "${SPIKE_CANDIDATES:-}" ]; then
  # shellcheck disable=SC2206
  CANDIDATES=(${SPIKE_CANDIDATES})
else
  CANDIDATES=(
    "mistral-small3.2:24b-instruct-2506-q4_K_M"
    "mistral-small3.2:24b"
    "qwen3:30b-a3b-instruct-2507-q4_K_M"
    "qwen3:30b-a3b-instruct-2507"
    "qwen3:30b-a3b"
  )
fi

OUT_DIR=".planning/spikes/004-m4-validation/results"
mkdir -p "$OUT_DIR"

# Pre-flight: verify every candidate is pulled
echo "▶ Pre-flight: verifying candidate models are available locally..."
MISSING=()
for m in "${CANDIDATES[@]}"; do
  if ! ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$m"; then
    MISSING+=("$m")
  fi
done
if (( ${#MISSING[@]} > 0 )); then
  echo "  ✗ Missing models — please pull them first:"
  for m in "${MISSING[@]}"; do echo "      ollama pull $m"; done
  exit 1
fi
echo "  ✓ All 5 candidates present"
echo ""

# Also check the baked baseline for the walltime comparison
if ! ollama list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "dnd-master-plus:latest"; then
  echo "  ✗ Baked baseline 'dnd-master-plus:latest' missing — build it with 'pnpm build-local-models'"
  exit 1
fi

# Stage 1: compliance sweep across all 5 candidates
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Stage 1/2: tool-discovery compliance sweep (spike 002)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for m in "${CANDIDATES[@]}"; do
  SAFE_NAME=$(echo "$m" | tr ':/' '__')
  LOG_FILE="$OUT_DIR/compliance-m4-${SAFE_NAME}.log"
  echo ""
  echo "▶ Compliance — model: $m"
  echo "  log: $LOG_FILE"
  SPIKE_MODELS="$m" SPIKE_REPETITIONS=2 \
    pnpm exec tsx .planning/spikes/002-tool-discovery-compliance/run-compliance.ts \
    2>&1 | tee "$LOG_FILE"
done

# Stage 2: wall-clock vault vs baked, for each candidate as vault
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Stage 2/2: wall-clock vault vs baked (spike 003)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for m in "${CANDIDATES[@]}"; do
  SAFE_NAME=$(echo "$m" | tr ':/' '__')
  LOG_FILE="$OUT_DIR/walltime-m4-${SAFE_NAME}.log"
  echo ""
  echo "▶ Wall-clock — vault candidate: $m (baseline: dnd-master-plus:latest)"
  echo "  log: $LOG_FILE"
  VAULT_MODEL="$m" BAKED_MODEL="dnd-master-plus:latest" \
    pnpm exec tsx .planning/spikes/003-prefill-walltime-savings/run-walltime.ts \
    2>&1 | tee "$LOG_FILE"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Spike 004 complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: $OUT_DIR/"
echo ""
echo "Now update .planning/spikes/004-m4-validation/README.md:"
echo "  1. Fill the per-model comparison tables"
echo "  2. Identify the winner (lowest warm wall + ≥90% lenient compliance)"
echo "  3. Set the final G1/G2 verdicts (decision-grade)"
echo "  4. git add + commit + push"
