import type { CaseExpectations, EvalCase, TextCheck, ToolRequirement } from './case';

/** What one agent run produced, as far as the assertions are concerned. */
export interface ObservedToolCall {
  tool: string;
  args: Record<string, unknown>;
  is_error: boolean;
  error_code: string | null;
}

export interface CaseRunError {
  /** Error class name, e.g. RateLimitError. */
  name: string;
  status: number | null;
  message: string;
}

export interface CaseRun {
  caseId: string;
  model: string;
  session: string;
  toolCalls: ObservedToolCall[];
  finalText: string;
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Set when the run threw (Anthropic API error, abort, …); the case then fails. */
  error: CaseRunError | null;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CaseVerdict {
  caseId: string;
  passed: boolean;
  checks: CheckResult[];
}

export interface EvaluateOptions {
  /**
   * Values that must never appear in an answer (e.g. the Anthropic key used for the run). Only a pass/fail is
   * recorded; the value itself is never copied into a check detail.
   */
  secrets?: readonly string[];
}

// ---------- text helpers ----------

/**
 * Models often emit typographic variants (U+2011 non-breaking hyphens in order numbers, curly apostrophes in
 * "can't", narrow/no-break spaces). Normalize them so the patterns stay simple and deterministic.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
}

/** Copy without g/y so `.test` is stateless even if a caller passes a global pattern. */
function stateless(re: RegExp): RegExp {
  return re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re;
}

export function matches(re: RegExp, text: string): boolean {
  return stateless(re).test(text);
}

/** Distinct matched strings (case-folded when the pattern is case-insensitive). */
export function distinctMatches(re: RegExp, text: string): string[] {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const found = new Set<string>();
  for (const m of text.matchAll(new RegExp(re.source, flags.replace('y', '')))) {
    found.add(re.flags.includes('i') ? m[0].toLowerCase() : m[0]);
  }
  return [...found];
}

function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function evaluateTextCheck(check: TextCheck, text: string): CheckResult {
  switch (check.type) {
    case 'matches': {
      const ok = matches(check.pattern, text);
      return {
        name: check.label,
        passed: ok,
        detail: ok ? `matched ${String(check.pattern)}` : `no match for ${String(check.pattern)}`,
      };
    }
    case 'not_matches': {
      const m = stateless(check.pattern).exec(text);
      return {
        name: check.label,
        passed: m === null,
        detail:
          m === null
            ? `absent: ${String(check.pattern)}`
            : `found "${excerpt(m[0])}" (${String(check.pattern)})`,
      };
    }
    case 'mentions_at_least': {
      const hit = check.patterns.filter((p) => matches(p, text));
      return {
        name: check.label,
        passed: hit.length >= check.min,
        detail: `${hit.length}/${check.patterns.length} matched (need ${check.min})${
          hit.length < check.patterns.length
            ? `; missing ${check.patterns
                .filter((p) => !hit.includes(p))
                .map(String)
                .join(', ')}`
            : ''
        }`,
      };
    }
    case 'distinct_matches_at_least': {
      const found = distinctMatches(check.pattern, text);
      return {
        name: check.label,
        passed: found.length >= check.min,
        detail: `${found.length} distinct (need ${check.min})${
          found.length ? `: ${found.slice(0, 10).join(', ')}` : ''
        }`,
      };
    }
  }
}

// ---------- tool helpers ----------

/** Tool names used in a run: de-duplicated, sorted (order-insensitive comparison). */
export function usedToolNames(calls: readonly ObservedToolCall[]): string[] {
  return [...new Set(calls.map((c) => c.tool))].sort();
}

export function requirementMet(req: ToolRequirement, used: readonly string[]): boolean {
  return typeof req === 'string' ? used.includes(req) : req.some((t) => used.includes(t));
}

export function describeRequirement(req: ToolRequirement): string {
  return typeof req === 'string' ? req : `one of ${req.join(' | ')}`;
}

export function evaluateToolChecks(
  expect: CaseExpectations,
  calls: readonly ObservedToolCall[],
): CheckResult[] {
  const used = usedToolNames(calls);
  const calledDetail = `called: ${used.length ? used.join(', ') : '(none)'}`;
  const out: CheckResult[] = expect.tools.map((req) => ({
    name: `uses ${describeRequirement(req)}`,
    passed: requirementMet(req, used),
    detail: calledDetail,
  }));
  const forbidden = expect.forbiddenTools ?? [];
  if (forbidden.length > 0) {
    const bad = forbidden.filter((t) => used.includes(t));
    out.push({
      name: `never calls ${forbidden.join(', ')}`,
      passed: bad.length === 0,
      detail: bad.length === 0 ? calledDetail : `called forbidden: ${bad.join(', ')}`,
    });
  }
  out.push({
    name:
      expect.maxToolCalls === 0
        ? 'makes no tool calls'
        : `at most ${expect.maxToolCalls} tool calls`,
    passed: calls.length <= expect.maxToolCalls,
    detail: `${calls.length} call(s)${calls.length ? `: ${calls.map((c) => c.tool).join(', ')}` : ''}`,
  });
  return out;
}

// ---------- the verdict ----------

/**
 * Scores one run against its case. Every check is deterministic; the case passes only if all checks pass.
 * Global checks: the run finished normally (`end_turn`, no API error, not a safety `refusal`, not cut off by
 * max_tokens or the iteration cap) and produced a non-empty answer.
 */
export function evaluateCase(c: EvalCase, run: CaseRun, opts: EvaluateOptions = {}): CaseVerdict {
  const text = normalizeText(run.finalText);
  const checks: CheckResult[] = [];

  checks.push(
    run.error
      ? {
          name: 'run completes',
          passed: false,
          detail: `${run.error.name}${run.error.status === null ? '' : ` ${run.error.status}`}: ${excerpt(
            run.error.message,
            160,
          )}`,
        }
      : {
          name: 'run completes',
          passed: run.stopReason === 'end_turn',
          detail: `stop_reason ${run.stopReason ?? '(none)'}`,
        },
  );
  checks.push({
    name: 'gives an answer',
    passed: text.trim().length > 0,
    detail: text.trim().length > 0 ? `${text.trim().length} chars` : 'empty final text',
  });
  checks.push(...evaluateToolChecks(c.expect, run.toolCalls));
  for (const t of c.expect.text) checks.push(evaluateTextCheck(t, text));

  const secrets = (opts.secrets ?? []).filter((s) => s.length >= 8);
  if (secrets.length > 0) {
    const leaked = secrets.some((s) => run.finalText.includes(s) || text.includes(s));
    checks.push({
      name: 'leaks no configured secret',
      passed: !leaked,
      detail: leaked ? 'a configured secret appeared in the answer (value withheld)' : 'none found',
    });
  }

  return { caseId: c.id, passed: checks.every((x) => x.passed), checks };
}
