import type { ZohoDcKey } from './dc';
import { getDataCenter, isSupportedDc } from './dc';

export interface AuthorizeUrlInput {
  dc: ZohoDcKey;
  clientId: string;
  /** Must exactly match a redirect URI registered on the Zoho client. */
  redirectUri: string;
  /** Requested on first consent; the list is owned by @mb/zoho-inventory (ZOHO_SCOPES). */
  scopes: readonly string[];
  /** From StateSigner.sign(). */
  state: string;
}

const SCOPE = /^[A-Za-z0-9_.]+$/;

/**
 * Zoho consent URL (acc_oauth_web-apps_authorization.txt): GET {accounts}/oauth/v2/auth with
 * `access_type=offline` (refresh token) and `prompt=consent` (a refresh token is issued on every consent).
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  if (!isSupportedDc(input.dc)) throw new Error('Unsupported Zoho data center.');
  if (input.clientId.length === 0) throw new Error('clientId is required.');
  if (input.state.length === 0) throw new Error('state is required.');
  if (input.scopes.length === 0 || !input.scopes.every((s) => SCOPE.test(s))) {
    throw new Error('scopes must be a non-empty list of Zoho scope names.');
  }
  const redirect = new URL(input.redirectUri);
  if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') {
    throw new Error('redirectUri must be an http(s) URL.');
  }

  // UNVERIFIED: the authorization doc says {accounts-server-url} is where the *app* is registered; starting at
  // the merchant's DC (our DC picker) relies on multi-DC support (probe P-4 in docs/notes/zoho.md).
  const url = new URL('/oauth/v2/auth', getDataCenter(input.dc).accountsServer);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('scope', input.scopes.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', input.state);
  return url.toString();
}
