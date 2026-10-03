/**
 * The switch for local "fake live" mode (see ./fake-live.ts). Parsed here, with no imports, so server.ts can refuse a
 * production misconfiguration and production never loads the fake upstream module.
 */
export const FAKE_LIVE_ENV = 'MB_DEV_FAKE_ZOHO';

/** Same spelling rules as the boolean variables in config.ts: true/1 on, false/0/empty off, anything else an error. */
export function fakeLiveRequested(env: NodeJS.ProcessEnv): boolean {
  const raw = (env[FAKE_LIVE_ENV] ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === '' || raw === 'false' || raw === '0') return false;
  throw new Error(`${FAKE_LIVE_ENV} must be true or false.`);
}

/**
 * Fake-live mode seeds a working `mb_live_` key over fake data and fills ephemeral secrets: it must never run in
 * production. Throws (server.ts exits non-zero) when the flag is on and NODE_ENV=production.
 */
export function assertFakeLiveAllowed(env: NodeJS.ProcessEnv): void {
  if (fakeLiveRequested(env) && env.NODE_ENV === 'production') {
    throw new Error(
      `${FAKE_LIVE_ENV}=true is a local development mode and is refused when NODE_ENV=production. Unset ${FAKE_LIVE_ENV}.`,
    );
  }
}
