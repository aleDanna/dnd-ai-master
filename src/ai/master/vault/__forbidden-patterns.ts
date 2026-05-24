/**
 * REQ-022 lint patterns — forbidden in `prompt-builder.ts` source.
 *
 * Isolated in its own module so the lint scan (which inspects
 * `prompt-builder.ts` source via `readFileSync`) does NOT match the
 * pattern strings themselves. Spike 012 documented this self-match
 * false-positive; option 1 of the fix is to move FORBIDDEN_PATTERNS
 * to a sibling file (this one).
 */
export const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Date.now',       re: /Date\.now\(/ },
  { name: 'new Date(',      re: /new\s+Date\(/ },
  { name: 'Math.random',    re: /Math\.random\(/ },
  { name: 'process.hrtime', re: /process\.hrtime/ },
  { name: 'randomUUID',     re: /randomUUID\(/ },
  { name: 'process.env',    re: /process\.env\./ },
  { name: 'hostname',       re: /\.hostname\(/ },
];
