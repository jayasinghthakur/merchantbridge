/**
 * `pnpm evals`: runs every eval case through the playground engine on each model and writes
 * evals/reports/<run>-<model>.json + evals/reports/latest.md. Skips (exit 0) when ANTHROPIC_API_KEY is unset.
 */
import { main } from './cli';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

main(process.argv.slice(2), process.env, { signal: controller.signal })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    // Never echo request details: the Anthropic client config holds the key.
    const name = e instanceof Error ? e.constructor.name : typeof e;
    const message = e instanceof Error ? e.message : String(e);
    const key = process.env.ANTHROPIC_API_KEY;
    const safe = key && key.length >= 8 ? message.split(key).join('[redacted]') : message;
    process.stderr.write(`evals: crashed: ${name}: ${safe.slice(0, 500)}\n`);
    process.exitCode = 1;
  });
