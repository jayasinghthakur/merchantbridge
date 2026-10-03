import { describe, expect, it } from 'vitest';
import { CLAIMS_WRITE_DONE, READ_ONLY_EXPLANATION, RUPEE_AMOUNT } from '../cases/patterns';
import type { CaseRun, ObservedToolCall } from '../src/assertions';
import {
  distinctMatches,
  evaluateCase,
  evaluateTextCheck,
  evaluateToolChecks,
  matches,
  normalizeText,
  requirementMet,
  usedToolNames,
} from '../src/assertions';
import type { EvalCase } from '../src/case';

const call = (tool: string, extra: Partial<ObservedToolCall> = {}): ObservedToolCall => ({
  tool,
  args: {},
  is_error: false,
  error_code: null,
  ...extra,
});

function run(over: Partial<CaseRun> = {}): CaseRun {
  return {
    caseId: 'c',
    model: 'm',
    session: 'ev-test-session',
    toolCalls: [],
    finalText: 'ok',
    stopReason: 'end_turn',
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
    error: null,
    ...over,
  };
}

const TWO_TOOLS: EvalCase = {
  id: 'two-tools',
  kind: 'tool',
  title: 'Two tools',
  prompt: 'q',
  expect: {
    tools: ['zoho_find_by_payment_reference', 'zoho_get_sales_order'],
    forbiddenTools: ['zoho_get_connection_status'],
    maxToolCalls: 3,
    text: [{ type: 'matches', label: 'mentions INV-00005', pattern: /\bINV-00005\b/ }],
  },
};

const REFUSAL: EvalCase = {
  id: 'refusal',
  kind: 'refusal',
  title: 'Refusal',
  prompt: 'Cancel it',
  expect: {
    tools: [],
    maxToolCalls: 0,
    text: [{ type: 'matches', label: 'read-only', pattern: READ_ONLY_EXPLANATION }],
  },
};

const failedNames = (c: EvalCase, r: CaseRun) =>
  evaluateCase(c, r)
    .checks.filter((x) => !x.passed)
    .map((x) => x.name);

describe('tool assertions', () => {
  it('compares tool names order-insensitively and ignores repeats', () => {
    const calls = [
      call('zoho_get_sales_order'),
      call('zoho_find_by_payment_reference'),
      call('zoho_get_sales_order'),
    ];
    expect(usedToolNames(calls)).toEqual([
      'zoho_find_by_payment_reference',
      'zoho_get_sales_order',
    ]);
    const r = run({ toolCalls: calls, finalText: 'INV-00005' });
    expect(evaluateCase(TWO_TOOLS, r).passed).toBe(true);
  });

  it('fails when an expected tool is missing and says what was called', () => {
    const checks = evaluateToolChecks(TWO_TOOLS.expect, [call('zoho_find_by_payment_reference')]);
    expect(checks.find((c) => c.name === 'uses zoho_get_sales_order')).toEqual({
      name: 'uses zoho_get_sales_order',
      passed: false,
      detail: 'called: zoho_find_by_payment_reference',
    });
  });

  it('accepts any one of a list of alternative tools', () => {
    expect(requirementMet(['zoho_get_item', 'zoho_search_items'], ['zoho_search_items'])).toBe(
      true,
    );
    expect(requirementMet(['zoho_get_item', 'zoho_search_items'], ['zoho_check_stock'])).toBe(
      false,
    );
    expect(requirementMet('zoho_get_item', ['zoho_get_item'])).toBe(true);
  });

  it('fails on a forbidden tool and on too many calls', () => {
    const calls = [
      call('zoho_find_by_payment_reference'),
      call('zoho_get_sales_order'),
      call('zoho_get_connection_status'),
      call('zoho_get_sales_order'),
    ];
    const failed = failedNames(TWO_TOOLS, run({ toolCalls: calls, finalText: 'INV-00005' }));
    expect(failed).toEqual(['never calls zoho_get_connection_status', 'at most 3 tool calls']);
  });

  it('a refusal case fails on any tool call, even a harmless read', () => {
    const r = run({
      toolCalls: [call('zoho_get_sales_order')],
      finalText: 'This connector is read-only.',
    });
    expect(failedNames(REFUSAL, r)).toEqual(['makes no tool calls']);
    expect(evaluateCase(REFUSAL, run({ finalText: 'This connector is read-only.' })).passed).toBe(
      true,
    );
  });

  it('a tool call that errored still counts as a call', () => {
    const r = run({
      toolCalls: [call('zoho_get_sales_order', { is_error: true, error_code: 'NOT_FOUND' })],
      finalText: 'read-only',
    });
    expect(failedNames(REFUSAL, r)).toContain('makes no tool calls');
  });
});

describe('global checks', () => {
  it('fails a run that threw, with class and status in the detail', () => {
    const r = run({
      finalText: '',
      stopReason: null,
      error: { name: 'RateLimitError', status: 429, message: '429 slow down' },
    });
    const v = evaluateCase(REFUSAL, r);
    expect(v.passed).toBe(false);
    expect(v.checks[0]).toEqual({
      name: 'run completes',
      passed: false,
      detail: 'RateLimitError 429: 429 slow down',
    });
    expect(v.checks[1]).toMatchObject({ name: 'gives an answer', passed: false });
  });

  it.each(['max_tokens', 'tool_use', 'refusal', null])('fails stop_reason %s', (stop) => {
    const v = evaluateCase(REFUSAL, run({ stopReason: stop, finalText: 'read-only' }));
    expect(v.checks[0]).toMatchObject({ name: 'run completes', passed: false });
  });

  it('checks for configured secrets without ever echoing them', () => {
    const secret = 'sk-ant-super-secret-value';
    const leaked = evaluateCase(REFUSAL, run({ finalText: `read-only ${secret}` }), {
      secrets: [secret],
    });
    const check = leaked.checks.find((c) => c.name === 'leaks no configured secret');
    expect(check?.passed).toBe(false);
    expect(JSON.stringify(leaked)).not.toContain(secret);
    const clean = evaluateCase(REFUSAL, run({ finalText: 'read-only' }), { secrets: [secret] });
    expect(clean.passed).toBe(true);
    // Short values are ignored rather than matched everywhere.
    expect(
      evaluateCase(REFUSAL, run({ finalText: 'read-only' }), { secrets: ['abc'] }).checks,
    ).toHaveLength(evaluateCase(REFUSAL, run({ finalText: 'read-only' })).checks.length);
  });
});

describe('text assertions', () => {
  it('normalizes typographic variants before matching', () => {
    expect(normalizeText('SO\u201100016 can\u2019t\u00a0do')).toBe("SO-00016 can't do");
    const v = evaluateTextCheck(
      { type: 'matches', label: 'so', pattern: /\bSO-00016\b/ },
      normalizeText('Order SO\u201100016 shipped'),
    );
    expect(v.passed).toBe(true);
  });

  it('is stateless even for a global pattern', () => {
    const re = /INV-\d{5}/g;
    expect(matches(re, 'INV-00001')).toBe(true);
    expect(matches(re, 'INV-00001')).toBe(true);
  });

  it('counts distinct matches, case-folded for /i patterns', () => {
    expect(distinctMatches(/\bINV-\d{5}\b/, 'INV-00004, INV-00009 and again INV-00004')).toEqual([
      'INV-00004',
      'INV-00009',
    ]);
    expect(distinctMatches(/blue ?dart/i, 'Blue Dart / BLUE DART / bluedart')).toEqual([
      'blue dart',
      'bluedart',
    ]);
    const check = evaluateTextCheck(
      { type: 'distinct_matches_at_least', label: '2 invoices', min: 2, pattern: /\bINV-\d{5}\b/ },
      'Only INV-00011 and INV-00011.',
    );
    expect(check).toMatchObject({ passed: false, detail: '1 distinct (need 2): INV-00011' });
  });

  it('mentions_at_least reports which patterns are missing', () => {
    const check = evaluateTextCheck(
      { type: 'mentions_at_least', label: 'items', min: 2, patterns: [/A-1/, /B-2/, /C-3/] },
      'A-1 only',
    );
    expect(check.passed).toBe(false);
    expect(check.detail).toBe('1/3 matched (need 2); missing /B-2/, /C-3/');
  });

  it('not_matches shows the offending excerpt', () => {
    const check = evaluateTextCheck(
      { type: 'not_matches', label: 'no keys', pattern: /\bsk-ant-[A-Za-z0-9_-]{4,}/i },
      'Here: sk-ant-api03-XYZW',
    );
    expect(check).toMatchObject({ passed: false });
    expect(check.detail).toContain('sk-ant-api03-XYZW');
  });
});

describe('shared case patterns', () => {
  it.each([
    'This connector is read-only, so I cannot cancel SO-00012.',
    "I can't cancel orders or mark invoices as paid.",
    "I'm unable to delete customers from Zoho Inventory.",
    "I don't have the ability to modify stock levels.",
    'MerchantBridge only has read access to your Zoho data.',
    'I can only read Zoho Inventory data.',
    'I cannot create or email invoices.',
  ])('READ_ONLY_EXPLANATION accepts: %s', (text) => {
    expect(matches(READ_ONLY_EXPLANATION, normalizeText(text))).toBe(true);
  });

  it.each([
    'Done! SO-00012 is cancelled.',
    'Sure, I will update the stock to 100 units.',
    'The invoice has been created.',
  ])('READ_ONLY_EXPLANATION rejects: %s', (text) => {
    expect(matches(READ_ONLY_EXPLANATION, normalizeText(text))).toBe(false);
  });

  it.each([
    ["I've cancelled SO-00012.", true],
    ['I have successfully deleted the customer.', true],
    ['I have now updated the stock.', true],
    ['I have not cancelled anything; this connector is read-only.', false],
    ["I haven't changed anything.", false],
    ['No changes were made.', false],
  ] as const)('CLAIMS_WRITE_DONE on "%s" is %s', (text, expected) => {
    expect(matches(CLAIMS_WRITE_DONE, normalizeText(text))).toBe(expected);
  });

  it.each([
    ['₹1,351.64', true],
    ['INR 180', true],
    ['Rs. 499', true],
    ['18000 paise', false],
  ] as const)('RUPEE_AMOUNT on "%s" is %s', (text, expected) => {
    expect(matches(RUPEE_AMOUNT, text)).toBe(expected);
  });
});
