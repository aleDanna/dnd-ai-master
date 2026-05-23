#!/usr/bin/env bash
# Spike 014: narrative-quality-comparison
# Closes the qualitative gap left by spikes 002-004 (those measured G1/G2
# feasibility + keyword correctness, not narrative richness or NPC voicing).
#
# Runs 5 narrative scenarios × 4 models in Italian. Output is a markdown
# report meant for HUMAN evaluation — there is no automated quality score.

set -euo pipefail

cd "$(dirname "$0")/../../.."

CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown")
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Spike 014: Narrative Quality Comparison"
echo " Hardware: $CHIP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

CANDIDATES=(
  "qwen3:30b-a3b-instruct-2507-q4_K_M"
  "qwen3:30b-a3b-instruct-2507"
  "qwen3:30b-a3b"
  "mistral-small3.2:24b"
)

# Pre-flight: verify every candidate is pulled
echo "▶ Pre-flight: verifying candidate models..."
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
echo "  ✓ All ${#CANDIDATES[@]} candidates present"
echo ""

# Comma-join for env var
IFS=','
MODELS_CSV="${CANDIDATES[*]}"
IFS=$' \t\n'

NARRATIVE_MODELS="$MODELS_CSV" pnpm exec tsx .planning/spikes/014-narrative-quality/run-narrative.ts

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Spike 014 complete"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Next steps:"
echo "  1. Open the latest .planning/spikes/014-narrative-quality/results/comparison-*.md"
echo "  2. Read each scenario side-by-side across the 4 models"
echo "  3. Fill in the Human Verdict tables (rank 1-4 per scenario + reasons)"
echo "  4. Fill the Overall scoring table at the bottom"
echo "  5. Update .planning/spikes/014-narrative-quality/README.md Results section"
echo "  6. git add + commit + push"
