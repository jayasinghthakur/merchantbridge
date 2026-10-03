import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_CASES } from '../cases/index';
import type { CliIO, MainDeps } from '../src/cli';
import { SKIP_MESSAGE, main, parseArgs, skipMessage } from '../src/cli';
import { createDemoEndpoint } from '../src/harness';
import { REFERENCE_PATHS } from './support/reference-paths';
import type { Json, Script, ScriptedTurn } from './support/scripted-anthropic';
import { scriptedAnthropic } from './support/scripted-anthropic';
import { scriptedOpenAi } from './support/scripted-openai';

const FAKE_KEY = 'sk-ant-test-0123456789abcdef-not-real';
const FAKE_GSK = 'gsk_test_0123456789abcdef_not_real';

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

/** The same reference paths, served by a fake OpenAI-compatible endpoint. */
function openAiDeps(
  outDir: string,
  io: CliIO,
  script: Script = referenceRouter(),
): MainDeps & { fake: ReturnType<typeof scriptedOpenAi>; sleeps: number[] } {
  const fake = scriptedOpenAi(script);
  const sleeps: number[] = [];
  let t = Date.parse('2026-10-03T19:55:12Z');
  return {
    io,
    outDir,
    llmFetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date((t += 1000)),
    fake,
    sleeps,
  };
}

describe('parseArgs', () => {
  it('leaves provider, base URL, models and delay to the environment by default', () => {
    const r = parseArgs([], '/out');
    expect(r).toEqual({
      ok: true,
      options: {
        provider: null,
        baseUrl: null,
        models: null,
        caseIds: null,
        delayMs: null,
        maxTokens: 4096,
        outDir: '/out',
        help: false,
      },
    });
  });

  it('reads --provider and --base-url, and accepts OpenRouter/Ollama-style model ids', () => {
    expect(
      parseArgs([
        '--provider',
        'OpenAI',
        '--base-url=http://localhost:11434/v1/',
        '--models',
        'llama3.1:8b,meta-llama/llama-3.3-70b-instruct:free',
      ]),
    ).toMatchObject({
      ok: true,
      options: {
        provider: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        models: ['llama3.1:8b', 'meta-llama/llama-3.3-70b-instruct:free'],
      },
    });
    expect(parseArgs(['--provider', 'anthropic'])).toMatchObject({
      ok: true,
      options: { provider: 'anthropic' },
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
    [['--provider', 'cohere']],
    [['--provider']],
    [['--base-url', 'ftp://example.com']],
    [['--provider', 'anthropic', '--base-url', 'http://localhost:11434/v1']],
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

  it('runs all 17 cases on both models through runAgent, scores them and writes the reports', async () => {
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
      summary: { total: 17, passed: 17, pass_rate: 1 },
      gate: { min_pass_rate: 0.9, passed: true },
      engine: { name: 'runAgent', tool_choice: 'auto', max_tokens: 4096 },
    });
    expect(sonnet.results.map((r: Json) => r.id)).toEqual(ALL_CASES.map((c) => c.id));
    const md = await readFile(join(out, 'latest.md'), 'utf8');
    expect(md).toContain('| claude-sonnet-5-5 | 17/17 | 100.0% | PASS (needs ≥ 90.0%) |');
    expect(md).toContain('| claude-haiku-4-5 | 17/17 | 100.0% | published as-is |');

    // Every model request went to the model under test.
    expect(new Set(d.requests.map((r) => r.model))).toEqual(
      new Set(['claude-sonnet-5-5', 'claude-haiku-4-5']),
    );
    expect(cap.out.join('\n')).toMatch(/^score\s+17\/17 100\.0%\s+17\/17 100\.0%$/m);
    expect(
      cap.out.filter((l) => /^\[claude-(sonnet-5-5|haiku-4-5)\] +\d+\/17 \S+: PASS/.test(l)),
    ).toHaveLength(34);
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
    // The unknown model is second, so it is not the gated primary.
    const code = await main(
      ['--models', 'claude-haiku-4-5,claude-nope-1', '--cases', 'cod-stock,refuse-write'],
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

  it('gates the first model of --models, whichever it is', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const code = await main(
      ['--models', 'claude-haiku-4-5,claude-sonnet-5-5', '--cases', 'cod-stock'],
      { ANTHROPIC_API_KEY: FAKE_KEY },
      deps(out, cap.io, [{ kind: 'text', text: 'No idea.' }]),
    );
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toMatch(/claude-haiku-4-5 scored 0\.0%, below its 90\.0% gate/);
    expect(cap.err.join('\n')).not.toMatch(/claude-sonnet-5-5 scored/);
  }, 30_000);

  it('rejects unknown case ids', async () => {
    const cap = captureIO();
    const code = await main(['--cases', 'nope'], { ANTHROPIC_API_KEY: FAKE_KEY }, { io: cap.io });
    expect(code).toBe(2);
    expect(cap.err[0]).toContain('unknown case id(s): nope');
  });
});

describe('main on the OpenAI-compatible provider (free default)', () => {
  it('picks openai from MB_LLM_API_KEY and runs all 17 cases on llama-3.3-70b-versatile through runAgentOpenAI', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const d = openAiDeps(out, cap.io);
    // ANTHROPIC_API_KEY is set too: the free provider still wins by default.
    const code = await main([], { MB_LLM_API_KEY: FAKE_GSK, ANTHROPIC_API_KEY: FAKE_KEY }, d);
    expect(code, cap.all()).toBe(0);

    const files = (await readdir(out)).sort();
    expect(files).toEqual(['2026-10-03T19-55-13Z-llama-3.3-70b-versatile.json', 'latest.md']);
    const llama = JSON.parse(await readFile(join(out, files[0]!), 'utf8'));
    expect(llama).toMatchObject({
      model: 'llama-3.3-70b-versatile',
      summary: { total: 17, passed: 17, pass_rate: 1 },
      gate: { min_pass_rate: 0.9, passed: true },
      engine: {
        name: 'runAgentOpenAI',
        provider: 'openai',
        base_url: 'https://api.groq.com/openai/v1',
        tool_choice: 'auto',
        max_tokens: 4096,
      },
    });
    const md = await readFile(join(out, 'latest.md'), 'utf8');
    expect(md).toContain('| llama-3.3-70b-versatile | 17/17 | 100.0% | PASS (needs ≥ 90.0%) |');
    expect(md).toContain('provider openai (`https://api.groq.com/openai/v1`)');

    // Every request went to Groq's chat completions with the key as a bearer token, model under test.
    expect(new Set(d.fake.urls)).toEqual(
      new Set(['https://api.groq.com/openai/v1/chat/completions']),
    );
    expect(new Set(d.fake.authorizations)).toEqual(new Set([`Bearer ${FAKE_GSK}`]));
    expect(new Set(d.fake.requests.map((r) => r.model))).toEqual(
      new Set(['llama-3.3-70b-versatile']),
    );
    expect(d.fake.requests[0]).toMatchObject({ tool_choice: 'auto', max_tokens: 4096 });
    // Free-tier pacing: 2.5 s between cases.
    expect(d.sleeps).toHaveLength(16);
    expect(new Set(d.sleeps)).toEqual(new Set([2500]));

    expect(cap.all()).toContain('MB_LLM_API_KEY: set');
    expect(cap.all()).toContain('provider openai (https://api.groq.com/openai/v1)');
    expect(cap.all()).not.toContain(FAKE_GSK);
    expect(md + JSON.stringify(llama)).not.toContain(FAKE_GSK);
  }, 60_000);

  it('honours --base-url / MB_LLM_BASE_URL and --models', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const d = openAiDeps(out, cap.io);
    const code = await main(
      ['--models', 'llama3.1:8b', '--cases', 'cod-stock,refuse-write', '--delay-ms', '0'],
      { MB_LLM_API_KEY: 'ollama-local', MB_LLM_BASE_URL: 'http://localhost:11434/v1/' },
      d,
    );
    expect(code, cap.all()).toBe(0);
    expect(new Set(d.fake.urls)).toEqual(new Set(['http://localhost:11434/v1/chat/completions']));
    expect(new Set(d.fake.requests.map((r) => r.model))).toEqual(new Set(['llama3.1:8b']));

    const viaFlag = openAiDeps(await tempDir(), captureIO().io);
    await main(
      [
        '--provider',
        'openai',
        '--base-url',
        'https://generativelanguage.googleapis.com/v1beta/openai',
        '--cases',
        'cod-stock',
        '--models',
        'gemini-2.5-flash',
      ],
      { MB_LLM_API_KEY: FAKE_GSK, MB_LLM_BASE_URL: 'http://ignored.invalid/v1' },
      viaFlag,
    );
    expect(viaFlag.fake.urls[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  }, 30_000);

  it('skips with a clear message (exit 0) when the selected provider has no key', async () => {
    for (const [argv, env, provider] of [
      [['--provider', 'openai'], { ANTHROPIC_API_KEY: FAKE_KEY }, 'openai'],
      [[], { MB_LLM_PROVIDER: 'openai', ANTHROPIC_API_KEY: FAKE_KEY }, 'openai'],
      [['--provider', 'anthropic'], { MB_LLM_API_KEY: FAKE_GSK }, 'anthropic'],
    ] as const) {
      const cap = captureIO();
      const code = await main(argv, env, { io: cap.io, outDir: await tempDir() });
      expect(code).toBe(0);
      expect(cap.out).toEqual([skipMessage(provider)]);
      expect(cap.out[0]).toContain(
        provider === 'openai' ? 'MB_LLM_API_KEY is not set' : 'ANTHROPIC_API_KEY is not set',
      );
    }
    expect(SKIP_MESSAGE).toContain('MB_LLM_API_KEY or ANTHROPIC_API_KEY');
  });

  it('rejects an invalid MB_LLM_PROVIDER, or --base-url when the env selects anthropic, with exit 2', async () => {
    const env = captureIO();
    expect(
      await main(
        ['--base-url', 'http://localhost:11434/v1'],
        { ANTHROPIC_API_KEY: FAKE_KEY },
        { io: env.io },
      ),
    ).toBe(2);
    expect(env.err[0]).toContain('--base-url only applies to the openai provider');
    const cap = captureIO();
    expect(
      await main([], { MB_LLM_PROVIDER: 'cohere', MB_LLM_API_KEY: FAKE_GSK }, { io: cap.io }),
    ).toBe(2);
    expect(cap.err[0]).toContain('MB_LLM_PROVIDER must be openai or anthropic');
  });

  it('stops with exit 1 when the provider rejects the key, without printing it', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const d = openAiDeps(out, cap.io, [
      {
        kind: 'error',
        status: 401,
        body: { error: { message: `Invalid API Key ${FAKE_GSK}`, code: 'invalid_api_key' } },
      },
    ]);
    const code = await main([], { MB_LLM_API_KEY: FAKE_GSK }, d);
    expect(code).toBe(1);
    expect(d.fake.requests).toHaveLength(1);
    expect(cap.err.join('\n')).toContain(
      'The LLM provider at https://api.groq.com/openai/v1 rejected the API key (HTTP 401)',
    );
    expect(cap.all()).not.toContain(FAKE_GSK);
    const report = (await readdir(out)).find((f) => f.endsWith('.json'))!;
    expect(await readFile(join(out, report), 'utf8')).not.toContain(FAKE_GSK);
  }, 30_000);

  it('skips the rest of a model once the free quota is spent (429 after retries)', async () => {
    const out = await tempDir();
    const cap = captureIO();
    const d = openAiDeps(out, cap.io, [
      {
        kind: 'error',
        status: 429,
        headers: { 'retry-after': '3600' },
        body: {
          error: {
            message: 'Rate limit reached for model llama-3.3-70b-versatile on tokens per day (TPD)',
            code: 'rate_limit_exceeded',
          },
        },
      },
    ]);
    const code = await main(
      ['--cases', 'cod-stock,refuse-write,rto-history'],
      { MB_LLM_API_KEY: FAKE_GSK },
      d,
    );
    expect(code).toBe(1); // the primary model scored 0%
    expect(d.fake.requests).toHaveLength(1);
    const file = (await readdir(out)).find((f) => f.endsWith('.json'))!;
    const report = JSON.parse(await readFile(join(out, file), 'utf8'));
    expect(report.results.map((r: Json) => r.error?.name)).toEqual([
      'LlmProviderError',
      'Skipped',
      'Skipped',
    ]);
    expect(report.results[0].error.status).toBe(429);
    expect(cap.err.join('\n')).toContain('out of free quota (HTTP 429)');
  }, 30_000);
});
