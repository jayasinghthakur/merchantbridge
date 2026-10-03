import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_CASES } from '../cases/index';
import type { CliIO, MainDeps } from '../src/cli';
import { DEFAULT_DELAY_MS, SKIP_MESSAGE, main, parseArgs } from '../src/cli';
import { createDemoEndpoint } from '../src/harness';
import { REFERENCE_PATHS } from './support/reference-paths';
import type { Json, Script, ScriptedTurn } from './support/scripted-anthropic';
import { scriptedAnthropic } from './support/scripted-anthropic';

const FAKE_KEY = 'sk-ant-test-0123456789abcdef-not-real';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mb-evals-'));
  dirs.push(d);
  return d;
}

function captureIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { log: (l) => out.push(l), error: (l) => err.push(l) };
  return { io, out, err, all: () => [...out, ...err].join('\n') };
}

/** One fake client for a whole run: each conversation gets its case's reference path, chosen by the prompt. */
function referenceRouter(): Script {
  return (first: string) => {
    const c = ALL_CASES.find((x) => x.prompt === first);
    return c ? (REFERENCE_PATHS[c.id]?.turns ?? []) : [];
  };
}

function deps(
  outDir: string,
  io: CliIO,
  script: Script = referenceRouter(),
): MainDeps & { requests: Json[] } {
  const fake = scriptedAnthropic(script);
  let t = Date.parse('2026-10-03T19:55:12Z');
  return {
    io,
    outDir,
    createAnthropic: () => fake.client,
    sleep: async () => undefined,
    now: () => new Date((t += 1000)),
    requests: fake.requests,
  };
}

describe('parseArgs', () => {
  it('defaults to Sonnet 5.5 and Haiku 4.5, all cases', () => {
    const r = parseArgs([], '/out');
    expect(r).toEqual({
      ok: true,
      options: {
        models: ['claude-sonnet-5-5', 'claude-haiku-4-5'],
        caseIds: null,
        delayMs: DEFAULT_DELAY_MS,
        maxTokens: 4096,
        outDir: '/out',
        help: false,
      },
    });
  });

  it('reads flags in both spellings and ignores a bare --', () => {
    const r = parseArgs([
      '--',
      '--models=claude-haiku-4-5',
      '--cases',
      'cod-stock,refuse-write',
      '--delay-ms',
      '0',
      '--max-tokens=2048',
      '--out',
      'x',
    ]);
    expect(r).toMatchObject({
      ok: true,
      options: {
        models: ['claude-haiku-4-5'],
        caseIds: ['cod-stock', 'refuse-write'],
        delayMs: 0,
        maxTokens: 2048,
        outDir: 'x',
      },
    });
  });

  it.each([
    [['--bogus']],
    [['--models']],
    [['--models', '']],
    [['--models', 'not a model']],
    [['--delay-ms', '-1']],
    [['--max-tokens', '10']],
    [['--cases', '--models', 'x']],
  ])('rejects %j', (argv) => {
    expect(parseArgs(argv).ok).toBe(false);
  });
});

describe('main (pnpm evals)', () => {
  it('without ANTHROPIC_API_KEY prints the skip message, builds nothing and exits 0', async () => {
    const out = await tempDir();
    const { io, out: lines, err } = captureIO();
    let built = false;
    const code = await main(
      [],
      { ANTHROPIC_API_KEY: '  ' },
      {
        io,
        outDir: out,
        createEndpoint: async () => {
          built = true;
          return createDemoEndpoint();
        },
      },
    );
    expect(code).toBe(0);
    expect(lines).toEqual([SKIP_MESSAGE]);
    expect(err).toEqual([]);
    expect(built).toBe(false);
    expect(await readdir(out)).toEqual([]);
  });

  it('prints help and rejects bad arguments without a key', async () => {
    const h = captureIO();
    expect(await main(['--help'], {}, { io: h.io })).toBe(0);
    expect(h.out[0]).toContain('Usage: pnpm evals');
    const b = captureIO();
    expect(await main(['--nope'], {}, { io: b.io })).toBe(2);
    expect(b.err[0]).toContain('unknown argument: --nope');
  });

  it('runs all 15 cases on both models through runAgent, scores them and writes the reports', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const d = deps(out, cap.io);
    const code = await main([], { ANTHROPIC_API_KEY: FAKE_KEY }, d);
    expect(code, cap.all()).toBe(0);

    const files = (await readdir(out)).sort();
    expect(files).toEqual([
      '2026-10-03T19-55-13Z-claude-haiku-4-5.json',
      '2026-10-03T19-55-13Z-claude-sonnet-5-5.json',
      'latest.md',
    ]);
    const sonnet = JSON.parse(await readFile(join(out, files[1]!), 'utf8'));
    expect(sonnet).toMatchObject({
      schema: 'merchantbridge-evals/v1',
      model: 'claude-sonnet-5-5',
      summary: { total: 15, passed: 15, pass_rate: 1 },
      gate: { min_pass_rate: 0.9, passed: true },
      engine: { name: 'runAgent', tool_choice: 'auto', max_tokens: 4096 },
    });
    expect(sonnet.results.map((r: Json) => r.id)).toEqual(ALL_CASES.map((c) => c.id));
    const md = await readFile(join(out, 'latest.md'), 'utf8');
    expect(md).toContain('| claude-sonnet-5-5 | 15/15 | 100.0% | PASS (needs ≥ 90.0%) |');
    expect(md).toContain('| claude-haiku-4-5 | 15/15 | 100.0% | published as-is |');

    // Every model request went to the model under test.
    expect(new Set(d.requests.map((r) => r.model))).toEqual(
      new Set(['claude-sonnet-5-5', 'claude-haiku-4-5']),
    );
    expect(cap.out.join('\n')).toMatch(/^score\s+15\/15 100\.0%\s+15\/15 100\.0%$/m);
    expect(
      cap.out.filter((l) => /^\[claude-(sonnet-5-5|haiku-4-5)\] +\d+\/15 \S+: PASS/.test(l)),
    ).toHaveLength(30);
    expect(cap.all()).toContain('ANTHROPIC_API_KEY: set');
    expect(cap.all()).not.toContain(FAKE_KEY);
    expect(md + JSON.stringify(sonnet)).not.toContain(FAKE_KEY);
  }, 60_000);

  it('exits 1 when Sonnet scores below 90% (Haiku has no gate)', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const code = await main(
      ['--cases', 'cod-stock,refuse-write'],
      { ANTHROPIC_API_KEY: FAKE_KEY },
      deps(out, cap.io, [{ kind: 'text', text: 'No idea.' }]),
    );
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toMatch(/claude-sonnet-5-5 scored 0\.0%, below its 90\.0% gate/);
    // A subset run writes its JSON reports but never replaces the published latest.md.
    const files = await readdir(out);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2);
    expect(files).not.toContain('latest.md');
    expect(cap.out.join('\n')).toContain('latest.md not updated');
  }, 30_000);

  it('stops at once with exit 1 when the API key is rejected, without printing it', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const d = deps(out, cap.io, [
      {
        kind: 'error',
        status: 401,
        body: {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        },
      },
    ]);
    const code = await main([], { ANTHROPIC_API_KEY: FAKE_KEY }, d);
    expect(code).toBe(1);
    expect(d.requests).toHaveLength(1);
    expect(cap.err.join('\n')).toContain('Anthropic rejected the API key (HTTP 401)');
    expect(cap.all()).not.toContain(FAKE_KEY);
    expect(await readdir(out)).not.toContain('latest.md');
  }, 30_000);

  it('skips the rest of a model that 404s and still runs the next model', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const route = referenceRouter();
    const notFound: ScriptedTurn = {
      kind: 'error',
      status: 404,
      body: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-nope-1' } },
    };
    const d = deps(out, cap.io, (first, model) =>
      model === 'claude-nope-1'
        ? [notFound]
        : typeof route === 'function'
          ? route(first, model)
          : route,
    );
    const code = await main(
      ['--models', 'claude-nope-1,claude-haiku-4-5', '--cases', 'cod-stock,refuse-write'],
      { ANTHROPIC_API_KEY: FAKE_KEY },
      d,
    );
    expect(code).toBe(0);
    // One request for the unknown model, then its remaining case is skipped without calling the API.
    expect(d.requests.filter((r) => r.model === 'claude-nope-1')).toHaveLength(1);
    const files = (await readdir(out)).filter((f) => f.endsWith('.json')).sort();
    const nope = JSON.parse(
      await readFile(
        join(
          out,
          files.find((f) => f.includes('nope'))!,
        ),
        'utf8',
      ),
    );
    const haiku = JSON.parse(
      await readFile(
        join(
          out,
          files.find((f) => f.includes('haiku'))!,
        ),
        'utf8',
      ),
    );
    expect(nope.results.map((r: Json) => r.error?.name)).toEqual(['NotFoundError', 'Skipped']);
    expect(haiku.summary).toMatchObject({ total: 2, passed: 2 });
    expect(cap.err.join('\n')).toContain('returned HTTP 404');
  }, 30_000);

  it('rejects unknown case ids', async () => {
    const cap = captureIO();
    const code = await main(['--cases', 'nope'], { ANTHROPIC_API_KEY: FAKE_KEY }, { io: cap.io });
    expect(code).toBe(2);
    expect(cap.err[0]).toContain('unknown case id(s): nope');
  });
});
