/**
 * Minimum-necessary PHI/PII scrubbing applied to transcript text before it is
 * sent to the AI reviewer. Covers the identifiers that routinely appear in
 * Medicare calls: MBI, SSN, card numbers, phone numbers, emails, dates of birth.
 * Names and addresses are NOT removed (they are needed for coaching context and
 * are hard to detect reliably) — use a BAA-covered AI provider for production PHI.
 */
const RULES: Array<[RegExp, string]> = [
  // Medicare Beneficiary Identifier: 11 chars, e.g. 1EG4-TE5-MK73
  [/\b[1-9][AC-HJKMNP-RT-Yac-hjkmnp-rt-y][AC-HJKMNP-RT-Yac-hjkmnp-rt-y0-9]\d-?[AC-HJKMNP-RT-Yac-hjkmnp-rt-y][AC-HJKMNP-RT-Yac-hjkmnp-rt-y0-9]\d-?[AC-HJKMNP-RT-Yac-hjkmnp-rt-y]{2}\d{2}\b/g, "[MBI]"],
  [/\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/g, "[SSN]"],
  [/\b(?:\d[ -]?){13,16}\b/g, "[CARD]"],
  [/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, "[PHONE]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
  [/\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)?\d{2}\b/g, "[DATE]"],
];

// Toll-free numbers the agent is required to read (1-800-MEDICARE, 1-800-633-4227) must survive.
const KEEP = /\b1[ .-]?800[ .-]?(?:medicare|633[ .-]?4227)\b/gi;

export function redactPHI(text: string): string {
  const kept: string[] = [];
  let out = text.replace(KEEP, (m) => {
    kept.push(m);
    return `\u0000${kept.length - 1}\u0000`;
  });
  for (const [re, label] of RULES) out = out.replace(re, label);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? "");
}
