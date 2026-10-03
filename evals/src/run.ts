/**
 * `pnpm evals`: runs every eval case through the playground engine on each model and writes
 * evals/reports/<run>-<model>.json + evals/reports/latest.md. Skips (exit 0) when the selected provider's key
 * (MB_LLM_API_KEY for the free OpenAI-compatible default, ANTHROPIC_API_KEY for anthropic) is unset.
 */
import { main } from './cli';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

main(process.argv.slice(2), process.env, { signal: controller.signal })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    // Never echo request details: the LLM client config holds the key.
    const name = e instanceof Error ? e.constructor.name : typeof e;
    let safe = e instanceof Error ? e.message : String(e);
    for (const key of [process.env.ANTHROPIC_API_KEY, process.env.MB_LLM_API_KEY]) {
      if (key && key.length >= 8) safe = safe.split(key).join('[redacted]');
    }
    process.stderr.write(`evals: crashed: ${name}: ${safe.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
