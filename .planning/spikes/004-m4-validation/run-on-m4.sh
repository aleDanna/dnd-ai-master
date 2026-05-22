#!/usr/bin/env bash
# Spike 004: m4-validation
# Re-runs spike 002 (compliance) and spike 003 (wall-clock) on Mac Mini M4 hardware.
# G1 and G2 measured on M5 Pro dev are informative only; this script produces
# decision-grade measurements on the production target hardware.

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

OUT_DIR=".planning/spikes/004-m4-validation/results"
mkdir -p "$OUT_DIR"

echo "▶ Step 1/2: re-run spike 002 (compliance) on this hardware..."
SPIKE_REPETITIONS=2 pnpm exec tsx .planning/spikes/002-tool-discovery-compliance/run-compliance.ts 2>&1 | tee "$OUT_DIR/compliance-m4.log"

echo ""
echo "▶ Step 2/2: re-run spike 003 (wall-clock) on this hardware..."
pnpm exec tsx .planning/spikes/003-prefill-walltime-savings/run-walltime.ts 2>&1 | tee "$OUT_DIR/walltime-m4.log"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Spike 004: Results saved to $OUT_DIR/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Now update .planning/spikes/004-m4-validation/README.md with:"
echo "  - M4 compliance rates (compare to M5 Pro figures in spike 002)"
echo "  - M4 wall-clock deltas (compare to M5 Pro figures in spike 003)"
echo "  - Final G1 / G2 decision-grade verdict"
