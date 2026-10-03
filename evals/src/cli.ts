import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type { LlmConnection, LlmProviderName } from '@mb/api';
import { DEFAULT_LLM_BASE_URL, LLM_PROVIDERS } from '@mb/api';
import { ALL_CASES } from '../cases/index';
import type { CaseRun } from './assertions';
import { evaluateCase } from './assertions';
import type { EvalCase } from './case';
import { toolNamesIn } from './case';
import type { DemoEndpoint } from './harness';
import { ENGINE_DEFAULTS, createDemoEndpoint, runCase } from './harness';
import type { CaseResult, EngineInfo, ModelReport } from './report';
import {
  DEFAULT_MODELS,
  PRIMARY_GATE,
  buildModelReport,
  caseResult,
  gateExitCode,
  pct,
  renderScoreTable,
  runStamp,
  writeLatestMarkdown,
  writeModelReport,
} from './report';

export const DEFAULT_REPORTS_DIR = fileURLToPath(new URL('../reports/', import.meta.url));

/**
 * Pause between cases. The OpenAI-compatible default (Groq's free tier, ~30 requests/min and a per-minute token
 * window) needs more room than Anthropic; a case makes 1-6 model requests.
 */
export const DEFAULT_DELAY_MS: Readonly<Record<LlmProviderName, number>> = {
  openai: 2_500,
  anthropic: 1_000,
};

/** Env var holding each provider's key. */
export const KEY_VARS: Readonly<Record<LlmProviderName, string>> = {
  openai: 'MB_LLM_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Engine retries for the OpenAI-compatible provider: ride out per-minute free-tier windows (Retry-After ≤ 65 s). */
export const OPENAI_EVAL_RETRY = {
  maxRetries: 4,
  maxRetryDelayMs: 65_000,
  timeoutMs: 120_000,
} as const;

/** What `pnpm evals` prints (exit 0) when the selected provider has no key. */
export function skipMessage(provider: LlmProviderName | null): string {
  const why =
    provider === null
      ? 'no LLM key is set (MB_LLM_API_KEY or ANTHROPIC_API_KEY)'
      : `${KEY_VARS[provider]} is not set (provider: ${provider})`;
  return [
    `evals: ${why}, so no evals were run (no model calls were made, no reports written).`,
    `       Free: export MB_LLM_API_KEY=<a Groq key, gsk_...> then \`pnpm evals\` (provider openai, default model`,
    `       ${DEFAULT_MODELS.openai.join(',')}; --base-url for Gemini/OpenRouter/Ollama). Or export ANTHROPIC_API_KEY`,
    `       and run \`pnpm evals -- --provider anthropic\`. The offline harness tests run with \`pnpm --filter @mb/evals test\`.`,
  ].join('\n');
}

export const SKIP_MESSAGE = skipMessage(null);

export const USAGE = `Usage: pnpm evals [-- options]

Runs the ${ALL_CASES.length} MerchantBridge evals through the playground agent loop against the in-process demo MCP
endpoint, once per model, sequentially. Needs MB_LLM_API_KEY (openai provider, free tiers work) or
ANTHROPIC_API_KEY (anthropic provider) in the environment.

Options:
  --provider <p>     openai | anthropic (default: MB_LLM_PROVIDER, else openai when MB_LLM_API_KEY is set,
                     else anthropic when ANTHROPIC_API_KEY is set)
  --base-url <url>   OpenAI-compatible base URL (default: MB_LLM_BASE_URL, else ${DEFAULT_LLM_BASE_URL})
  --models <a,b>     Models to run; the first is gated at ${pct(PRIMARY_GATE)} (default: openai ${DEFAULT_MODELS.openai.join(
    ',',
  )}; anthropic ${DEFAULT_MODELS.anthropic.join(',')})
  --cases <a,b>      Only these case ids (default: all)
  --delay-ms <n>     Pause between cases in ms (default: openai ${DEFAULT_DELAY_MS.openai}, anthropic ${DEFAULT_DELAY_MS.anthropic})
  --max-tokens <n>   max_tokens per model request (default: ${ENGINE_DEFAULTS.maxTokens})
  --out <dir>        Reports directory (default: evals/reports)
  -h, --help         Show this help

Exit codes: 0 ok (or skipped: no key) · 1 the first model scored below ${pct(PRIMARY_GATE)} or the API key was
rejected · 2 bad arguments · 130 interrupted.`;

export interface CliOptions {
  /** Null = from the environment (see USAGE). */
  provider: LlmProviderName | null;
  /** Null = MB_LLM_BASE_URL or the Groq default. */
  baseUrl: string | null;
  /** Null = the provider's DEFAULT_MODELS. */
  models: string[] | null;
  caseIds: string[] | null;
  /** Null = the provider's DEFAULT_DELAY_MS. */
  delayMs: number | null;
  maxTokens: number;
  outDir: string;
  help: boolean;
}

export type ParseResult = { ok: true; options: CliOptions } | { ok: false; error: string };

/** Anthropic, Groq, Gemini, OpenRouter (`vendor/model:free`) and Ollama (`model:tag`) ids. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;

function list(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

function isProvider(v: string): v is LlmProviderName {
  return (LLM_PROVIDERS as readonly string[]).includes(v);
}

function validUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseArgs(argv: readonly string[], outDir = DEFAULT_REPORTS_DIR): ParseResult {
  const options: CliOptions = {
    provider: null,
    baseUrl: null,
    models: null,
    caseIds: null,
    delayMs: null,
    maxTokens: ENGINE_DEFAULTS.maxTokens,
    outDir,
    help: false,
  };
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const takeValue = (): string | null => {
      if (eq !== -1) return arg.slice(eq + 1);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) return null;
      i += 1;
      return next;
    };
    switch (flag) {
      case '--provider': {
        const v = takeValue()?.trim().toLowerCase() ?? '';
        if (!isProvider(v)) return { ok: false, error: '--provider must be openai or anthropic' };
        options.provider = v;
        break;
      }
      case '--base-url': {
        const v = takeValue()?.trim() ?? '';
        if (!validUrl(v)) return { ok: false, error: '--base-url needs an http(s) URL' };
        options.baseUrl = v.replace(/\/+$/, '');
        break;
      }
      case '--models': {
        const v = takeValue();
        const models = v === null ? [] : list(v);
        if (models.length === 0)
          return { ok: false, error: '--models needs a comma-separated list' };
        const bad = models.find((m) => !MODEL_RE.test(m));
        if (bad) return { ok: false, error: `--models: "${bad}" does not look like a model id` };
        options.models = models;
        break;
      }
      case '--cases': {
        const v = takeValue();
        const ids = v === null ? [] : list(v);
        if (ids.length === 0)
          return { ok: false, error: '--cases needs a comma-separated list of case ids' };
        options.caseIds = ids;
        break;
      }
      case '--delay-ms':
      case '--max-tokens': {
        const v = takeValue();
        const n = v === null ? Number.NaN : Number(v);
        const min = flag === '--delay-ms' ? 0 : 256;
        if (!Number.isInteger(n) || n < min || n > 600_000) {
          return { ok: false, error: `${flag} needs an integer ≥ ${min}` };
        }
        if (flag === '--delay-ms') options.delayMs = n;
        else options.maxTokens = n;
        break;
      }
      case '--out': {
        const v = takeValue();
        if (v === null || v.trim() === '') return { ok: false, error: '--out needs a directory' };
        options.outDir = v;
        break;
      }
      default:
        return { ok: false, error: `unknown argument: ${arg}` };
    }
  }
  if (options.baseUrl !== null && options.provider === 'anthropic') {
    return { ok: false, error: '--base-url only applies to --provider openai' };
  }
  return { ok: true, options };
}

/**
 * Provider from the environment, as the API picks it: MB_LLM_PROVIDER, else openai when MB_LLM_API_KEY is set,
 * else anthropic when ANTHROPIC_API_KEY is set, else none.
 */
export function providerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): LlmProviderName | null | { error: string } {
  const explicit = env.MB_LLM_PROVIDER?.trim().toLowerCase() ?? '';
  if (explicit !== '') {
    return isProvider(explicit)
      ? explicit
      : { error: `MB_LLM_PROVIDER must be openai or anthropic (got "${explicit.slice(0, 20)}")` };
  }
  if (env.MB_LLM_API_KEY?.trim()) return 'openai';
  if (env.ANTHROPIC_API_KEY?.trim()) return 'anthropic';
  return null;
}

export interface CliIO {
  log(line: string): void;
  error(line: string): void;
}

export interface MainDeps {
  io?: CliIO;
  cases?: readonly EvalCase[];
  createAnthropic?: (apiKey: string) => Anthropic;
  /** Transport for the OpenAI-compatible provider (tests pass a scripted fake). */
  llmFetch?: typeof fetch;
  createEndpoint?: () => Promise<DemoEndpoint>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Aborting stops after the current case; partial reports are still written. */
  signal?: AbortSignal;
  /** Default reports directory (tests point this at a temp dir). */
  outDir?: string;
}

const defaultIO: CliIO = {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function skippedRun(c: EvalCase, model: string, reason: string): CaseRun {
  return {
    caseId: c.id,
    model,
    session: '',
    toolCalls: [],
    finalText: '',
    stopReason: null,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    error: { name: 'Skipped', status: null, message: reason },
  };
}

function progressLine(model: string, i: number, n: number, r: CaseResult): string {
  const head = `[${model}] ${String(i + 1).padStart(2)}/${n} ${r.id}`;
  const stats = `${r.tool_calls.length} tool call(s), ${(r.duration_ms / 1000).toFixed(1)}s`;
  if (r.passed) return `${head}: PASS (${stats})`;
  return `${head}: ${r.error ? 'ERROR' : 'FAIL'} (${stats}) - ${r.failed_checks.join('; ')}`;
}

/** The `pnpm evals` program. Returns the process exit code; never prints the API key. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: MainDeps = {},
): Promise<number> {
  const io = deps.io ?? defaultIO;
  const parsed = parseArgs(argv, deps.outDir);
  if (!parsed.ok) {
    io.error(`evals: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const opts = parsed.options;
  if (opts.help) {
    io.log(USAGE);
    return 0;
  }

  const fromEnv = opts.provider ?? providerFromEnv(env);
  if (fromEnv !== null && typeof fromEnv === 'object') {
    io.error(`evals: ${fromEnv.error}\n\n${USAGE}`);
    return 2;
  }
  const provider = fromEnv;
  if (provider === null) {
    io.log(SKIP_MESSAGE);
    return 0;
  }
  if (provider === 'anthropic' && opts.baseUrl !== null) {
    io.error(
      `evals: --base-url only applies to the openai provider (selected: anthropic)\n\n${USAGE}`,
    );
    return 2;
  }
  const keyVar = KEY_VARS[provider];
  const apiKey = env[keyVar]?.trim() ?? '';
  if (apiKey === '') {
    io.log(skipMessage(provider));
    return 0;
  }
  const envBaseUrl = env.MB_LLM_BASE_URL?.trim() ?? '';
  if (opts.baseUrl === null && envBaseUrl !== '' && !validUrl(envBaseUrl)) {
    io.error('evals: MB_LLM_BASE_URL is not an http(s) URL');
    return 2;
  }
  const baseUrl = (opts.baseUrl ?? (envBaseUrl || DEFAULT_LLM_BASE_URL)).replace(/\/+$/, '');
  const models = opts.models ?? [...DEFAULT_MODELS[provider]];
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS[provider];

  const allCases = deps.cases ?? ALL_CASES;
  let cases: readonly EvalCase[] = allCases;
  if (opts.caseIds) {
    const unknown = opts.caseIds.filter((id) => !allCases.some((c) => c.id === id));
    if (unknown.length > 0) {
      io.error(
        `evals: unknown case id(s): ${unknown.join(', ')}\nknown: ${allCases.map((c) => c.id).join(', ')}`,
      );
      return 2;
    }
    const wanted = new Set(opts.caseIds);
    cases = allCases.filter((c) => wanted.has(c.id));
  }

  const endpoint = await (deps.createEndpoint ?? createDemoEndpoint)();
  try {
    const missing = [...new Set(cases.flatMap(toolNamesIn))].filter(
      (t) => !endpoint.toolNames.includes(t),
    );
    if (missing.length > 0) {
      io.error(
        `evals: cases refer to tools the demo endpoint does not serve: ${missing.join(', ')}`,
      );
      return 2;
    }

    const llm: LlmConnection =
      provider === 'anthropic'
        ? {
            provider,
            anthropic:
              deps.createAnthropic?.(apiKey) ??
              new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 }),
          }
        : {
            provider,
            baseUrl,
            apiKey,
            ...OPENAI_EVAL_RETRY,
            ...(deps.llmFetch ? { fetch: deps.llmFetch } : {}),
          };
    const safeBaseUrl = (() => {
      const u = new URL(baseUrl);
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    })();
    const now = deps.now ?? (() => new Date());
    const sleep = deps.sleep ?? ((ms: number) => sleepMs(ms, deps.signal));
    const runId = runStamp(now());
    const engine: EngineInfo = {
      name: provider === 'openai' ? 'runAgentOpenAI' : 'runAgent',
      provider,
      ...(provider === 'openai' ? { base_url: safeBaseUrl } : {}),
      endpoint: 'in-process /mcp/demo (demo tenant, FakeZoho demo dataset)',
      max_tokens: opts.maxTokens,
      max_iterations: ENGINE_DEFAULTS.maxIterations,
      tool_choice: 'auto',
    };
    io.log(
      `evals: run ${runId} · provider ${provider}${provider === 'openai' ? ` (${safeBaseUrl})` : ''} · ` +
        `${cases.length} case(s) × ${models.length} model(s) · ${keyVar}: set`,
    );

    const reports: ModelReport[] = [];
    const files: Record<string, string> = {};
    let fatal: string | null = null;
    let interrupted = false;

    for (const [modelIndex, model] of models.entries()) {
      if (fatal !== null || interrupted) break;
      const startedAt = now();
      const results: CaseResult[] = [];
      let skipReason: string | null = null;
      for (const [i, c] of cases.entries()) {
        if (deps.signal?.aborted) {
          interrupted = true;
          break;
        }
        const run: CaseRun =
          skipReason === null
            ? await runCase(c, {
                model,
                llm,
                endpoint,
                maxTokens: opts.maxTokens,
                secrets: [apiKey],
                ...(deps.signal ? { signal: deps.signal } : {}),
              })
            : skippedRun(c, model, skipReason);
        const result = caseResult(c, run, evaluateCase(c, run, { secrets: [apiKey] }));
        results.push(result);
        io.log(progressLine(model, i, cases.length, result));

        const status: number | null = run.error?.status ?? null;
        if (status === 401 || status === 403) {
          fatal =
            provider === 'anthropic'
              ? `Anthropic rejected the API key (HTTP ${status}); stopping. Check ANTHROPIC_API_KEY and its workspace.`
              : `The LLM provider at ${safeBaseUrl} rejected the API key (HTTP ${status}); stopping. Check MB_LLM_API_KEY (and --base-url).`;
          break;
        }
        if (status === 404 && skipReason === null) {
          skipReason = `skipped: ${model} returned HTTP 404 on an earlier case (unknown model id?)`;
          io.error(`evals: ${skipReason}`);
        }
        // Free tiers: a 429 that outlived the engine's Retry-After retries (or 402 = no credits) means the
        // per-day quota is spent; hammering on would only fail every remaining case the same way.
        if (provider === 'openai' && (status === 429 || status === 402) && skipReason === null) {
          skipReason = `skipped: ${model} is still rate-limited or out of free quota (HTTP ${status}) after retries; try later, or fewer --cases / a larger --delay-ms`;
          io.error(`evals: ${skipReason}`);
        }
        if (deps.signal?.aborted) {
          interrupted = true;
          break;
        }
        if (skipReason === null && i < cases.length - 1) await sleep(delayMs);
      }
      const report = buildModelReport({
        runId,
        model,
        startedAt,
        finishedAt: now(),
        engine,
        results,
        // The primary (first) model carries the release gate; the rest are published as-is.
        minPassRate: modelIndex === 0 ? PRIMARY_GATE : null,
      });
      reports.push(report);
      files[model] = await writeModelReport(opts.outDir, report);
    }

    io.log('');
    io.log(renderScoreTable(reports));
    io.log('');
    for (const r of reports) io.log(`report: ${join(opts.outDir, files[r.model] ?? '')}`);
    // latest.md is the published summary: only a complete run over every case may replace it.
    if (fatal === null && !interrupted && cases.length === allCases.length) {
      io.log(`summary: ${await writeLatestMarkdown(opts.outDir, reports, files)}`);
    } else {
      io.log(
        'summary: latest.md not updated (partial run: subset of cases, interrupted or aborted)',
      );
    }

    if (fatal !== null) {
      io.error(`evals: ${fatal}`);
      return 1;
    }
    if (interrupted) {
      io.error('evals: interrupted; partial reports written.');
      return 130;
    }
    const code = gateExitCode(reports);
    if (code !== 0) {
      for (const r of reports.filter((x) => x.gate && !x.gate.passed)) {
        io.error(
          `evals: ${r.model} scored ${pct(r.summary.pass_rate)}, below its ${pct(r.gate?.min_pass_rate ?? 0)} gate.`,
        );
      }
    }
    return code;
  } finally {
    await endpoint.close();
  }
}
