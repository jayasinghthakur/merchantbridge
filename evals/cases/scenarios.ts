import { DEMO_IDS } from '@mb/core';
import type { EvalCase } from '../src/case';
import { scenarioCase } from '../src/case';
import { RUPEE_AMOUNT, refusalChecks } from './patterns';

/**
 * The 5 playground scenario cards (@mb/core SCENARIOS). Prompts and expected tools come from the card; the
 * answer checks below are grounded in the FakeZoho demo dataset (packages/zoho-inventory/src/fake/dataset.ts):
 *
 * - pay_DEMO8xK2 paid INV-00005 for SO-00007, shipped by Delhivery, tracking 1490811234567, delivered.
 * - CHAI-250 in Bengaluru: 42 on hand, 4 reserved, 38 available; selling price ₹180.
 * - Rohan Mehta voided SO-00003, SO-00008 (RTO) and SO-00015; SO-00012 is still open.
 * - Unpaid invoices due within 7 days: INV-00010, INV-00011 (order_DEMO6Hy2), INV-00012, INV-00013.
 *
 * The CI test (test/scripted-paths.test.ts) replays a reference path for every case against the real demo
 * endpoint and checks these facts appear in the tool results, so a dataset change cannot silently break a case.
 */

export const disputeEvidence: EvalCase = scenarioCase('dispute-evidence', {
  maxToolCalls: 5,
  text: [
    { type: 'matches', label: 'names the invoice INV-00005', pattern: /\bINV-00005\b/ },
    { type: 'matches', label: 'names the sales order SO-00007', pattern: /\bSO-00007\b/ },
    {
      type: 'matches',
      label: 'gives the tracking number 1490811234567',
      pattern: /\b1490811234567\b/,
    },
    { type: 'matches', label: "says it was 'delivered'", pattern: /\bdelivered\b/i },
  ],
});

export const codStock: EvalCase = scenarioCase('cod-stock', {
  maxToolCalls: 3,
  text: [
    {
      type: 'matches',
      label: `gives the ${DEMO_IDS.sku} price (180)`,
      pattern: /\b180(?:\.00)?\b/,
    },
    {
      type: 'matches',
      label: `gives a ${DEMO_IDS.location} stock count (38 available / 42 on hand)`,
      pattern: /\b(?:38|42)\b/,
    },
  ],
});

export const rtoHistory: EvalCase = scenarioCase('rto-history', {
  maxToolCalls: 6,
  text: [
    {
      type: 'matches',
      label: 'reports void / cancelled orders',
      pattern: /\b(?:void(?:ed)?|cancel+ed|cancel+ations?)\b/i,
    },
    {
      type: 'mentions_at_least',
      label: 'cites at least one voided order number',
      min: 1,
      patterns: [/\bSO-00003\b/, /\bSO-00008\b/, /\bSO-00015\b/],
    },
  ],
});

export const settlementUnpaid: EvalCase = scenarioCase('settlement-unpaid', {
  maxToolCalls: 4,
  text: [
    {
      type: 'distinct_matches_at_least',
      label: 'lists at least 2 invoices',
      min: 2,
      pattern: /\bINV-\d{5}\b/,
    },
    { type: 'matches', label: 'gives amounts in rupees', pattern: RUPEE_AMOUNT },
  ],
});

export const refuseWrite: EvalCase = scenarioCase('refuse-write', {
  maxToolCalls: 0,
  text: refusalChecks,
});

export const scenarioCases: readonly EvalCase[] = [
  disputeEvidence,
  codStock,
  rtoHistory,
  settlementUnpaid,
  refuseWrite,
];
