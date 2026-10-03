import { ZOHO_DATA_CENTERS } from '@mb/auth';
import { createDemoDataset, createFakeZoho } from '@mb/zoho-inventory';

export const GOOD_CODE = '1000.authcode-SECRET-abc123';
export const REFRESH_TOKEN = '1000.refresh-SECRET-xyz789';

export interface UpstreamCall {
  host: string;
  path: string;
  grantType?: string | null;
}

/**
 * Outbound fetch for live-mode tests: a fake Zoho Accounts token endpoint on the IN accounts host plus a
 * wire-compatible FakeZoho behind the IN API domain. Access tokens are issued by FakeZoho itself so it accepts
 * them. Any other host fails the test.
 */
export function createLiveUpstream() {
  const fake = createFakeZoho({ dataset: createDemoDataset({ now: Date.now() }) });
  const calls: UpstreamCall[] = [];
  const accounts = new URL(ZOHO_DATA_CENTERS.in.accountsServer).host;
  const api = new URL(ZOHO_DATA_CENTERS.in.apiDomain).host;
  const state = { refreshFails: false, exchangeFails: false };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === accounts && url.pathname === '/oauth/v2/token') {
      const params = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      const grantType = params.get('grant_type');
      calls.push({ host: url.host, path: url.pathname, grantType });
      if (grantType === 'authorization_code') {
        if (state.exchangeFails || params.get('code') !== GOOD_CODE)
          return json(200, { error: 'invalid_code' });
        return json(200, {
          access_token: await fake.tokens.get(),
          refresh_token: REFRESH_TOKEN,
          api_domain: ZOHO_DATA_CENTERS.in.apiDomain,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (grantType === 'refresh_token') {
        if (state.refreshFails || params.get('refresh_token') !== REFRESH_TOKEN) {
          return json(200, { error: 'invalid_code' });
        }
        const current = await fake.tokens.get();
        const next = await fake.tokens.refreshAfterUnauthorized(current);
        return json(200, {
          access_token: next,
          api_domain: ZOHO_DATA_CENTERS.in.apiDomain,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (url.host === api) {
      calls.push({ host: url.host, path: url.pathname });
      return fake.fetch(input, init);
    }
    throw new Error(`unexpected outbound fetch in test: ${url.origin}`);
  };

  return {
    fetch: fetchImpl,
    fake,
    calls,
    state,
    tokenCalls: (grant: string) => calls.filter((c) => c.grantType === grant).length,
    apiCalls: () => calls.filter((c) => c.host === api).length,
  };
}
