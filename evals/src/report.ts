import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CaseRun,
  CaseRunError,
  CaseVerdict,
  CheckResult,
  ObservedToolCall,
} from './assertions';
import type { LlmProviderName } from '@mb/api';
import type { CaseKind, EvalCase } from './case';
import { CASE_KINDS } from './case';

/**
 * Release gate (PLAN §6 M5): the primary model (the first one in --models) must pass ≥ 90%; the others are
 * published as-is.
 */
export const PRIMARY_GATE = 0.9;

/** Models per provider when --models is not given; the first is the gated primary. */
export const DEFAULT_MODELS: Readonly<Record<LlmProviderName, readonly string[]>> = {
  openai: ['llama-3.3-70b-versatile'],
  anthropic: ['claude-sonnet-5-5', 'claude-haiku-4-5'],
};

export interface EngineInfo {
  /** runAgent = Anthropic toolRunner; runAgentOpenAI = OpenAI-compatible Chat Completions loop. */
  name: 'runAgent' | 'runAgentOpenAI';
  provider: LlmProviderName;
  /** OpenAI-compatible base URL (origin + path, never credentials); only for the openai provider. */
  base_url?: string;
  endpoint: string;
  max_tokens: number;
  max_iterations: number;
  tool_choice: 'auto';
}

export interface CaseResult {
  id: string;
  kind: CaseKind;
  title: string;
  passed: boolean;
  failed_checks: string[];
  checks: CheckResult[];
  tool_calls: ObservedToolCall[];
  stop_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  session: string;
  final_text: string;
  error: CaseRunError | null;
}

export interface ModelReport {
  schema: 'merchantbridge-evals/v1';
  run_id: string;
  model: string;
  started_at: string;
  finished_at: string;
  engine: EngineInfo;
  summary: {
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
    by_kind: Record<CaseKind, { total: number; passed: number }>;
    input_tokens: number;
    output_tokens: number;
    duration_ms: number;
  };
  gate: { min_pass_rate: number; passed: boolean } | null;
  results: CaseResult[];
}

export function caseResult(c: EvalCase, run: CaseRun, verdict: CaseVerdict): CaseResult {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    passed: verdict.passed,
    failed_checks: verdict.checks.filter((x) => !x.passed).map((x) => x.name),
    checks: verdict.checks,
    tool_calls: run.toolCalls,
    stop_reason: run.stopReason,
    input_tokens: run.inputTokens,
    output_tokens: run.outputTokens,
    duration_ms: run.durationMs,
    session: run.session,
    final_text: run.finalText,
    error: run.error,
  };
}

export function buildModelReport(input: {
  runId: string;
  model: string;
  startedAt: Date;
  finishedAt: Date;
  engine: EngineInfo;
  results: CaseResult[];
  /** Gate for this model (PRIMARY_GATE for the first model of a run); null/omitted = published as-is. */
  minPassRate?: number | null;
}): ModelReport {
  const { results } = input;
  const passed = results.filter((r) => r.passed).length;
  const passRate = results.length === 0 ? 0 : passed / results.length;
  const byKind = Object.fromEntries(CASE_KINDS.map((k) => [k, { total: 0, passed: 0 }])) as Record<
    CaseKind,
    { total: number; passed: number }
  >;
  for (const r of results) {
    byKind[r.kind].total += 1;
    if (r.passed) byKind[r.kind].passed += 1;
  }
  const min = input.minPassRate ?? null;
  return {
    schema: 'merchantbridge-evals/v1',
    run_id: input.runId,
    model: input.model,
    started_at: input.startedAt.toISOString(),
    finished_at: input.finishedAt.toISOString(),
    engine: input.engine,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      pass_rate: passRate,
      by_kind: byKind,
      input_tokens: results.reduce((s, r) => s + r.input_tokens, 0),
      output_tokens: results.reduce((s, r) => s + r.output_tokens, 0),
      duration_ms: results.reduce((s, r) => s + r.duration_ms, 0),
    },
    gate: min === null ? null : { min_pass_rate: min, passed: passRate >= min },
    results,
  };
}

/** `2026-10-03T19:55:12.345Z` → `2026-10-03T19-55-12Z` (safe in file names on every OS). */
export function runStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

export function reportFileName(runId: string, model: string): string {
  return `${runId}-${model.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
}

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function gateLabel(r: ModelReport): string {
  if (!r.gate) return 'published as-is';
  return `${r.gate.passed ? 'PASS' : 'FAIL'} (needs ≥ ${pct(r.gate.min_pass_rate)})`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Plain-text score table for the terminal: one row per case, one column per model. */
export function renderScoreTable(reports: readonly ModelReport[]): string {
  const ids = [...new Set(reports.flatMap((r) => r.results.map((x) => x.id)))];
  const kindOf = new Map(reports.flatMap((r) => r.results.map((x) => [x.id, x.kind] as const)));
  const idW = Math.max(4, ...ids.map((i) => i.length));
  const kindW = Math.max(4, ...[...kindOf.values()].map((k) => k.length));
  const colW = reports.map((r) => Math.max(r.model.length, 10));
  const lines: string[] = [];
  lines.push(
    [
      pad('case', idW),
      pad('kind', kindW),
      ...reports.map((r, i) => pad(r.model, colW[i] ?? 10)),
    ].join('  '),
  );
  lines.push([idW, kindW, ...colW].map((w) => '-'.repeat(w)).join('  '));
  for (const id of ids) {
    const cells = reports.map((r, i) => {
      const res = r.results.find((x) => x.id === id);
      const cell = res === undefined ? '-' : res.passed ? 'PASS' : res.error ? 'ERROR' : 'FAIL';
      return pad(cell, colW[i] ?? 10);
    });
    lines.push([pad(id, idW), pad(kindOf.get(id) ?? '', kindW), ...cells].join('  '));
  }
  lines.push([idW, kindW, ...colW].map((w) => '-'.repeat(w)).join('  '));
  lines.push(
    [
      pad('score', idW),
      pad('', kindW),
      ...reports.map((r, i) =>
        pad(`${r.summary.passed}/${r.summary.total} ${pct(r.summary.pass_rate)}`, colW[i] ?? 10),
      ),
    ].join('  '),
  );
  for (const r of reports) lines.push(`${r.model}: ${gateLabel(r)}`);
  return lines.map((l) => l.trimEnd()).join('\n');
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function quote(text: string, max = 600): string {
  const t = text.trim();
  if (t === '') return '> _(empty)_';
  const cut = t.length > max ? `${t.slice(0, max)}…` : t;
  return cut
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Markdown summary (evals/reports/latest.md): scores, the case matrix and every failure with its evidence. */
export function renderMarkdown(
  reports: readonly ModelReport[],
  files: Readonly<Record<string, string>> = {},
): string {
  const first = reports[0];
  const out: string[] = ['# MerchantBridge evals: latest run', ''];
  if (!first) return [...out, '_No models were run._', ''].join('\n');
  out.push(
    `Run \`${first.run_id}\` · provider ${first.engine.provider}${
      first.engine.base_url ? ` (\`${cell(first.engine.base_url)}\`)` : ''
    } · engine \`${first.engine.name}\` (the playground loop, \`tool_choice: auto\`, ` +
      `max_tokens ${first.engine.max_tokens}, max ${first.engine.max_iterations} iterations) · endpoint: ` +
      `${first.engine.endpoint} · deterministic checks only (no LLM judge).`,
    '',
    '| Model | Passed | Pass rate | Gate | Tokens in / out | Report |',
    '|---|---|---|---|---|---|',
  );
  for (const r of reports) {
    const file = files[r.model];
    out.push(
      `| ${cell(r.model)} | ${r.summary.passed}/${r.summary.total} | ${pct(r.summary.pass_rate)} | ${cell(
        gateLabel(r),
      )} | ${r.summary.input_tokens} / ${r.summary.output_tokens} | ${file ? `\`${cell(file)}\`` : '-'} |`,
    );
  }

  out.push('', '## Results by case', '');
  out.push(`| Case | Kind | ${reports.map((r) => cell(r.model)).join(' | ')} |`);
  out.push(`|---|---|${reports.map(() => '---').join('|')}|`);
  const ids = [...new Set(reports.flatMap((r) => r.results.map((x) => x.id)))];
  for (const id of ids) {
    const any = reports.flatMap((r) => r.results).find((x) => x.id === id);
    const cells = reports.map((r) => {
      const res = r.results.find((x) => x.id === id);
      if (!res) return '-';
      const tools = res.tool_calls.length;
      return `${res.passed ? 'pass' : res.error ? '**error**' : '**fail**'} (${tools} tool${tools === 1 ? '' : 's'})`;
    });
    out.push(`| \`${id}\` ${cell(any?.title ?? '')} | ${any?.kind ?? ''} | ${cells.join(' | ')} |`);
  }

  const failures = reports.flatMap((r) =>
    r.results.filter((x) => !x.passed).map((x) => ({ r, x })),
  );
  out.push('', '## Failures', '');
  if (failures.length === 0) out.push('None.');
  for (const { r, x } of failures) {
    out.push(`### ${cell(r.model)} · \`${x.id}\``, '');
    for (const c of x.checks.filter((k) => !k.passed))
      out.push(`- **${cell(c.name)}**: ${cell(c.detail)}`);
    const calls = x.tool_calls.map(
      (t) => `${t.tool}${t.is_error ? ` (error ${t.error_code ?? '?'})` : ''}`,
    );
    out.push(
      `- tool calls: ${calls.length ? calls.join(', ') : '(none)'}; stop_reason: ${x.stop_reason ?? '(none)'}`,
    );
    out.push('', quote(x.final_text), '');
  }
  return `${out.join('\n')}\n`;
}

/** Writes `<run>-<model>.json` into `dir`; returns the file name. */
export async function writeModelReport(dir: string, report: ModelReport): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = reportFileName(report.run_id, report.model);
  await writeFile(join(dir, name), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return name;
}

export async function writeLatestMarkdown(
  dir: string,
  reports: readonly ModelReport[],
  files: Readonly<Record<string, string>>,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'latest.md');
  await writeFile(path, renderMarkdown(reports, files), 'utf8');
  return path;
}

/** Exit code for a finished run: 1 when any gated model is below its threshold. */
export function gateExitCode(reports: readonly ModelReport[]): 0 | 1 {
  return reports.some((r) => r.gate !== null && !r.gate.passed) ? 1 : 0;
}
