import { z } from 'zod';
import type { Scenario } from '@mb/core';
import { SCENARIOS } from '@mb/core';

/**
 * One eval case: a user message sent through the playground agent loop (`runAgent`) against the in-process demo
 * MCP endpoint, plus deterministic expectations on what the agent did and said. No LLM-as-judge.
 */

export const CASE_KINDS = ['scenario', 'refusal', 'injection', 'tool'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** A tool name that must be called, or a list of alternatives of which at least one must be called. */
export type ToolRequirement = string | readonly string[];

/** Deterministic checks on the agent's final answer (after `normalizeText`). Patterns must not use /g or /y. */
export type TextCheck =
  | { type: 'matches'; label: string; pattern: RegExp }
  | { type: 'not_matches'; label: string; pattern: RegExp }
  /** At least `min` of `patterns` match (e.g. "names 3 of these 4 items"). */
  | { type: 'mentions_at_least'; label: string; min: number; patterns: readonly RegExp[] }
  /** At least `min` distinct strings match `pattern` (e.g. "lists 2 different invoice numbers"). */
  | { type: 'distinct_matches_at_least'; label: string; min: number; pattern: RegExp };

export interface CaseExpectations {
  /** Order-insensitive; every requirement must be met. Empty exactly when maxToolCalls is 0 (refusals). */
  tools: readonly ToolRequirement[];
  /** Tools that must never be called in this case. */
  forbiddenTools?: readonly string[];
  /** Upper bound on tool calls (0 for refusals). */
  maxToolCalls: number;
  text: readonly TextCheck[];
}

export interface EvalCase {
  id: string;
  kind: CaseKind;
  title: string;
  /** The user message, exactly as a playground user would type it (≤ 500 chars, the playground cap). */
  prompt: string;
  /** For `scenario` cases: the @mb/core SCENARIOS id the case is derived from. */
  scenarioId?: string;
  expect: CaseExpectations;
}

// ---------- schema (validated by the runner before any model call, and in CI) ----------

const TOOL_NAME_RE = /^zoho_[a-z][a-z0-9_]{2,60}$/;
const toolName = z.string().regex(TOOL_NAME_RE, 'tool names look like zoho_<verb>_<noun>');

const pattern = z
  .instanceof(RegExp)
  .refine((re) => !re.global && !re.sticky, 'patterns must not use the g or y flag (stateful)');

const label = z.string().trim().min(3).max(120);

const textCheckSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('matches'), label, pattern }),
  z.strictObject({ type: z.literal('not_matches'), label, pattern }),
  z.strictObject({
    type: z.literal('mentions_at_least'),
    label,
    min: z.number().int().min(1),
    patterns: z.array(pattern).min(1),
  }),
  z.strictObject({
    type: z.literal('distinct_matches_at_least'),
    label,
    min: z.number().int().min(1),
    pattern,
  }),
]);

const toolRequirementSchema = z.union([toolName, z.array(toolName).min(2)]);

export const evalCaseSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case id')
      .max(40),
    kind: z.enum(CASE_KINDS),
    title: z.string().trim().min(3).max(100),
    prompt: z.string().trim().min(1).max(500),
    scenarioId: z.string().min(1).optional(),
    expect: z.strictObject({
      tools: z.array(toolRequirementSchema),
      forbiddenTools: z.array(toolName).optional(),
      maxToolCalls: z.number().int().min(0).max(20),
      text: z.array(textCheckSchema).min(1),
    }),
  })
  .superRefine((c, ctx) => {
    const e = c.expect;
    if (c.kind === 'refusal' && e.maxToolCalls !== 0) {
      ctx.addIssue({ code: 'custom', message: 'refusal cases must cap tool calls at 0' });
    }
    if ((e.tools.length === 0) !== (e.maxToolCalls === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'a case expects no tools exactly when it caps tool calls at 0 (refusals)',
      });
    }
    if (e.maxToolCalls < e.tools.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'maxToolCalls is below the number of required tools',
      });
    }
    if ((c.kind === 'scenario') !== (c.scenarioId !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'scenarioId is required on (and only on) scenario cases',
      });
    }
    const required = new Set(e.tools.flatMap((t) => (typeof t === 'string' ? [t] : [...t])));
    for (const f of e.forbiddenTools ?? []) {
      if (required.has(f)) {
        ctx.addIssue({ code: 'custom', message: `tool ${f} is both required and forbidden` });
      }
    }
  });

/** Validates a list of cases (schema + unique ids). Throws with every problem listed. */
export function validateCases(cases: readonly EvalCase[]): EvalCase[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, c] of cases.entries()) {
    const parsed = evalCaseSchema.safeParse(c);
    const name = typeof c.id === 'string' ? c.id : `#${i}`;
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${name}: ${issue.path.join('.') || '(case)'}: ${issue.message}`);
      }
    }
    if (seen.has(c.id)) problems.push(`${name}: duplicate case id`);
    seen.add(c.id);
  }
  if (problems.length > 0) throw new Error(`Invalid eval cases:\n  - ${problems.join('\n  - ')}`);
  return [...cases];
}

/** Every tool name a case refers to (required, alternatives and forbidden). */
export function toolNamesIn(c: EvalCase): string[] {
  const names = c.expect.tools.flatMap((t) => (typeof t === 'string' ? [t] : [...t]));
  return [...new Set([...names, ...(c.expect.forbiddenTools ?? [])])];
}

// ---------- helpers for authoring cases ----------

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown @mb/core scenario: ${id}`);
  return s;
}

/**
 * A case derived from a playground scenario card: prompt and expected tools come from @mb/core SCENARIOS (the
 * single source of truth); the case adds the answer checks and a tool-call bound.
 */
export function scenarioCase(
  scenarioId: string,
  extra: { maxToolCalls: number; text: readonly TextCheck[]; forbiddenTools?: readonly string[] },
): EvalCase {
  const s = scenarioById(scenarioId);
  return {
    id: s.id,
    kind: 'scenario',
    title: `${s.agent}: ${s.title}`,
    prompt: s.prompt,
    scenarioId: s.id,
    expect: {
      tools: [...s.expectedTools],
      maxToolCalls: s.refusal ? 0 : extra.maxToolCalls,
      text: extra.text,
      ...(extra.forbiddenTools ? { forbiddenTools: extra.forbiddenTools } : {}),
    },
  };
}
