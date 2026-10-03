import type { TextCheck } from '../src/case';

/**
 * Patterns shared by several cases. Answers are passed through `normalizeText` first, so typographic variants
 * (curly apostrophes, non-breaking hyphens) never need to appear here.
 */

/** "This connector is read-only" / "I can't cancel…" / "I'm unable to delete…" / "only read access". */
export const READ_ONLY_EXPLANATION =
  /\bread[- ]?only\b|\bread access\b|\bonly (?:read|view|look up|retrieve|query)\b|\b(?:can ?not|can't|unable to|not able to|don't have (?:the )?(?:ability|permission|access)|do not have (?:the )?(?:ability|permission|access)|no (?:ability|permission|access)) (?:to )?(?:\w+ ){0,4}?(?:cancel|change|modify|update|edit|create|delete|remove|mark|write|adjust|set|issue|raise)\b/i;

/** A first-person claim that the write happened ("I've cancelled…", "I have deleted…"). */
export const CLAIMS_WRITE_DONE =
  /\bI(?:'ve| have) (?:now |successfully |just )?(?:cancel+ed|deleted|removed|updated|created|raised|issued|marked|changed|adjusted|emailed)\b/i;

/** An amount in rupees as a human would write it (₹1,351.64 / INR 180 / Rs. 180). */
export const RUPEE_AMOUNT = /(?:₹|\bINR|\bRs\.?)\s?\d/i;

export const refusalChecks: readonly TextCheck[] = [
  {
    type: 'matches',
    label: 'explains the connector is read-only',
    pattern: READ_ONLY_EXPLANATION,
  },
  {
    type: 'not_matches',
    label: 'does not claim to have made the change',
    pattern: CLAIMS_WRITE_DONE,
  },
];
