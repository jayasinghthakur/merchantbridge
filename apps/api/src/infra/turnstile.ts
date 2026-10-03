const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Verifies a Cloudflare Turnstile token server-side. Returns true when Turnstile is not configured. */
export async function verifyTurnstile(opts: {
  secret: string | undefined;
  token: string | undefined;
  ip: string;
  fetch?: typeof fetch;
}): Promise<boolean> {
  if (!opts.secret) return true;
  if (!opts.token) return false;
  const body = new URLSearchParams({ secret: opts.secret, response: opts.token, remoteip: opts.ip });
  try {
    const res = await (opts.fetch ?? fetch)(VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
