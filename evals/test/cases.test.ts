import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '@mb/core';
import { ALL_CASES, injectionCases, refusalCases, scenarioCases, toolCases } from '../cases/index';
import type { EvalCase } from '../src/case';
import { evalCaseSchema, validateCases } from '../src/case';

const base: EvalCase = {
  id: 'ok-case',
  kind: 'tool',
  title: 'A case',
  prompt: 'Which items are low?',
  expect: {
    tools: ['zoho_search_items'],
    maxToolCalls: 2,
    text: [{ type: 'matches', label: 'mentions SKU', pattern: /SKU/ }],
  },
};

function problems(c: unknown): string[] {
  const r = evalCaseSchema.safeParse(c);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('the 15 eval cases', () => {
  it('has the M5 mix: 5 scenario cards, 3 write attempts, 1 injection, 6 tool-specific', () => {
    expect(ALL_CASES).toHaveLength(15);
    const count = (k: string) => ALL_CASES.filter((c) => c.kind === k).length;
    expect([count('scenario'), count('refusal'), count('injection'), count('tool')]).toEqual([
      5, 3, 1, 6,
    ]);
    expect([scenarioCases, refusalCases, injectionCases, toolCases].map((l) => l.length)).toEqual([
      5, 3, 1, 6,
    ]);
  });

  it('every case passes the schema', () => {
    for (const c of ALL_CASES) expect(problems(c), c.id).toEqual([]);
  });

  it('scenario cases mirror @mb/core SCENARIOS (prompt and expected tools)', () => {
    expect(scenarioCases.map((c) => c.scenarioId)).toEqual(SCENARIOS.map((s) => s.id));
    for (const s of SCENARIOS) {
      const c = scenarioCases.find((x) => x.scenarioId === s.id);
      expect(c?.prompt).toBe(s.prompt);
      expect(c?.expect.tools).toEqual(s.expectedTools);
      expect(c?.expect.maxToolCalls === 0).toBe(s.refusal);
    }
  });

  it('write attempts and the refusal card allow zero tool calls', () => {
    const refusals = ALL_CASES.filter((c) => c.kind === 'refusal' || c.id === 'refuse-write');
    expect(refusals).toHaveLength(4);
    for (const c of refusals) expect(c.expect).toMatchObject({ tools: [], maxToolCalls: 0 });
  });

  it('tool-specific cases each target a different tool', () => {
    const targets = toolCases.map((c) => c.expect.tools[0]);
    expect(new Set(targets).size).toBe(6);
  });
});

describe('case schema', () => {
  it('accepts a well-formed case', () => {
    expect(problems(base)).toEqual([]);
  });

  it.each([
    [
      'refusal with a tool',
      { ...base, kind: 'refusal', expect: { ...base.expect, maxToolCalls: 0 } },
    ],
    ['no tools but calls allowed', { ...base, expect: { ...base.expect, tools: [] } }],
    ['scenario without scenarioId', { ...base, kind: 'scenario' }],
    ['scenarioId on a tool case', { ...base, scenarioId: 'cod-stock' }],
    ['bad tool name', { ...base, expect: { ...base.expect, tools: ['getItem'] } }],
    [
      'global regex',
      {
        ...base,
        expect: { ...base.expect, text: [{ type: 'matches', label: 'g flag', pattern: /x/g }] },
      },
    ],
    ['no text checks', { ...base, expect: { ...base.expect, text: [] } }],
    ['prompt over the playground cap', { ...base, prompt: 'x'.repeat(501) }],
    [
      'required and forbidden',
      { ...base, expect: { ...base.expect, forbiddenTools: ['zoho_search_items'] } },
    ],
    [
      'cap below required tools',
      {
        ...base,
        expect: { ...base.expect, tools: ['zoho_get_item', 'zoho_search_items'], maxToolCalls: 1 },
      },
    ],
    ['unknown key', { ...base, extra: true }],
  ])('rejects %s', (_name, c) => {
    expect(problems(c).length).toBeGreaterThan(0);
  });

  it('validateCases reports duplicates and every problem at once', () => {
    expect(() => validateCases([base, base, { ...base, id: 'Bad Id' }])).toThrow(
      /ok-case: duplicate case id[\s\S]*Bad Id: id: kebab-case id/,
    );
  });
});
