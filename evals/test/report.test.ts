import { describe, expect, it } from 'vitest';
import type { CaseResult, EngineInfo } from '../src/report';
import {
  PRIMARY_GATE,
  buildModelReport,
  gateExitCode,
  renderMarkdown,
  renderScoreTable,
  reportFileName,
  runStamp,
} from '../src/report';

const engine: EngineInfo = {
  name: 'runAgent',
  provider: 'anthropic',
  endpoint: 'in-process /mcp/demo',
  max_tokens: 4096,
  max_iterations: 6,
  tool_choice: 'auto',
};

function result(id: string, passed: boolean, over: Partial<CaseResult> = {}): CaseResult {
  return {
    id,
    kind: 'tool',
    title: `Title | ${id}`,
    passed,
    failed_checks: passed ? [] : ['uses zoho_get_item'],
    checks: passed
      ? [{ name: 'uses zoho_get_item', passed: true, detail: 'called: zoho_get_item' }]
      : [{ name: 'uses zoho_get_item', passed: false, detail: 'called: (none)' }],
    tool_calls: [],
    stop_reason: 'end_turn',
    input_tokens: 10,
    output_tokens: 5,
    duration_ms: 100,
    session: 's',
    final_text: passed ? 'fine' : 'line 1\nline | 2',
    error: null,
    ...over,
  };
}

/** `primary` = the first model of a run, which carries the 90% release gate. */
function report(model: string, passedCount: number, total = 15, primary = false) {
  const results = Array.from({ length: total }, (_, i) => result(`case-${i + 1}`, i < passedCount));
  return buildModelReport({
    runId: '2026-10-03T19-55-12Z',
    model,
    startedAt: new Date('2026-10-03T19:55:12Z'),
    finishedAt: new Date('2026-10-03T19:58:00Z'),
    engine,
    results,
    minPassRate: primary ? PRIMARY_GATE : null,
  });
}

describe('model report', () => {
  it('summarizes pass rate, kinds and tokens', () => {
    const r = report('claude-haiku-4-5', 12);
    expect(r.summary).toMatchObject({
      total: 15,
      passed: 12,
      failed: 3,
      input_tokens: 150,
      output_tokens: 75,
    });
    expect(r.summary.pass_rate).toBeCloseTo(0.8);
    expect(r.summary.by_kind.tool).toEqual({ total: 15, passed: 12 });
    expect(r.summary.by_kind.refusal).toEqual({ total: 0, passed: 0 });
    expect(r.gate).toBeNull();
  });

  it('gates the primary model at 90%: 14/15 passes, 13/15 fails; the others are published as-is', () => {
    expect(PRIMARY_GATE).toBe(0.9);
    expect(report('openai/gpt-oss-120b', 14, 15, true).gate).toEqual({
      min_pass_rate: 0.9,
      passed: true,
    });
    expect(report('claude-sonnet-5-5', 13, 15, true).gate).toEqual({
      min_pass_rate: 0.9,
      passed: false,
    });
    expect(report('claude-sonnet-5-5', 0).gate).toBeNull();
    expect(
      gateExitCode([report('claude-sonnet-5-5', 14, 15, true), report('claude-haiku-4-5', 0)]),
    ).toBe(0);
    expect(
      gateExitCode([report('claude-sonnet-5-5', 13, 15, true), report('claude-haiku-4-5', 15)]),
    ).toBe(1);
  });

  it('names files by run stamp and model', () => {
    expect(runStamp(new Date('2026-10-03T19:55:12.345Z'))).toBe('2026-10-03T19-55-12Z');
    expect(reportFileName('2026-10-03T19-55-12Z', 'claude-sonnet-5-5')).toBe(
      '2026-10-03T19-55-12Z-claude-sonnet-5-5.json',
    );
    expect(reportFileName('x', 'weird/model id')).toBe('x-weird-model-id.json');
  });
});

describe('rendering', () => {
  it('prints a score table with one column per model', () => {
    const table = renderScoreTable([
      report('claude-sonnet-5-5', 15, 15, true),
      report('claude-haiku-4-5', 14),
    ]);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^case\s+kind\s+claude-sonnet-5-5\s+claude-haiku-4-5$/);
    expect(table).toContain('case-15');
    expect(lines.find((l) => l.startsWith('case-15'))).toMatch(/PASS\s+FAIL\s*$/);
    expect(table).toMatch(/score\s+15\/15 100\.0%\s+14\/15 93\.3%/);
    expect(table).toContain('claude-sonnet-5-5: PASS (needs ≥ 90.0%)');
    expect(table).toContain('claude-haiku-4-5: published as-is');
  });

  it('marks errored runs as ERROR', () => {
    const r = buildModelReport({
      runId: 'r',
      model: 'm',
      startedAt: new Date(0),
      finishedAt: new Date(0),
      engine,
      results: [
        result('a', false, { error: { name: 'RateLimitError', status: 429, message: 'x' } }),
      ],
    });
    expect(renderScoreTable([r])).toMatch(/\ba\s+tool\s+ERROR/);
  });

  it('writes a markdown summary with escaped cells and every failure', () => {
    const md = renderMarkdown([report('claude-sonnet-5-5', 14, 15, true)], {
      'claude-sonnet-5-5': '2026-10-03T19-55-12Z-claude-sonnet-5-5.json',
    });
    expect(md).toContain('| claude-sonnet-5-5 | 14/15 | 93.3% | PASS (needs ≥ 90.0%) | 150 / 75 |');
    expect(md).toContain('provider anthropic · engine `runAgent`');
    expect(md).toContain('`2026-10-03T19-55-12Z-claude-sonnet-5-5.json`');
    expect(md).toContain('Title \\| case-1');
    expect(md).toContain('### claude-sonnet-5-5 · `case-15`');
    expect(md).toContain('- **uses zoho_get_item**: called: (none)');
    expect(md).toContain('> line 1\n> line | 2');
  });

  it('says so when nothing failed', () => {
    expect(renderMarkdown([report('m', 3, 3)])).toContain('## Failures\n\nNone.');
    expect(renderMarkdown([])).toContain('_No models were run._');
  });
});
