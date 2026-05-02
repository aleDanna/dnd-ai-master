const MULT: Record<string, number> = {
  cp: 1,
  sp: 10,
  ep: 50,
  gp: 100,
  pp: 1000,
};

export function parseCostToCp(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '—' || trimmed === '-') return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(cp|sp|ep|gp|pp)$/i.exec(trimmed);
  if (!m) {
    throw new Error(`parseCostToCp: cannot parse "${raw}"`);
  }
  const amount = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  const mult = MULT[unit];
  if (mult === undefined) {
    throw new Error(`parseCostToCp: unknown unit "${unit}"`);
  }
  return Math.round(amount * mult);
}
