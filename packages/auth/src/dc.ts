/**
 * Zoho data centers MerchantBridge can connect to: those with BOTH a documented Zoho Inventory API host
 * (docs/vendor/zoho/accounts/introduction.txt, "Multiple Data Centers") AND a documented accounts server
 * (docs/vendor/zoho/accounts/acc_oauth_multi-dc.txt).
 *
 * This file is one of only two places allowed to contain Zoho API host literals.
 *
 * Keys double as Zoho's `location` callback value; the docs show `in` and `eu` explicitly, the rest are the
 * DC codes from the multi-DC table (UNVERIFIED as `location` values until smoke).
 */
export const ZOHO_DC_KEYS = ['us', 'eu', 'in', 'au', 'jp', 'ca', 'sa'] as const;

export type ZohoDcKey = (typeof ZOHO_DC_KEYS)[number];

export interface ZohoDataCenter {
  key: ZohoDcKey;
  label: string;
  /** Origin of the Zoho Accounts server for OAuth, e.g. `https://accounts.zoho.in`. */
  accountsServer: string;
  /** Origin for Inventory API calls; the API base is `${apiDomain}/inventory/v1`. */
  apiDomain: string;
  /** Origin of the Zoho Inventory web app (for human-verifiable deep links), e.g. `https://inventory.zoho.in`. */
  inventoryWebHost: string;
}

function dc(def: ZohoDataCenter): Readonly<ZohoDataCenter> {
  return Object.freeze(def);
}

export const ZOHO_DATA_CENTERS: Readonly<Record<ZohoDcKey, Readonly<ZohoDataCenter>>> =
  Object.freeze({
    us: dc({
      key: 'us',
      label: 'United States',
      accountsServer: 'https://accounts.zoho.com',
      apiDomain: 'https://www.zohoapis.com',
      inventoryWebHost: 'https://inventory.zoho.com',
    }),
    eu: dc({
      key: 'eu',
      label: 'Europe',
      accountsServer: 'https://accounts.zoho.eu',
      apiDomain: 'https://www.zohoapis.eu',
      inventoryWebHost: 'https://inventory.zoho.eu',
    }),
    in: dc({
      key: 'in',
      label: 'India',
      accountsServer: 'https://accounts.zoho.in',
      apiDomain: 'https://www.zohoapis.in',
      inventoryWebHost: 'https://inventory.zoho.in',
    }),
    au: dc({
      key: 'au',
      label: 'Australia',
      accountsServer: 'https://accounts.zoho.com.au',
      apiDomain: 'https://www.zohoapis.com.au',
      inventoryWebHost: 'https://inventory.zoho.com.au',
    }),
    jp: dc({
      key: 'jp',
      label: 'Japan',
      accountsServer: 'https://accounts.zoho.jp',
      apiDomain: 'https://www.zohoapis.jp',
      // UNVERIFIED: the docs name the web host pattern only for .com/.in/.eu/.com.au/.ca.
      inventoryWebHost: 'https://inventory.zoho.jp',
    }),
    ca: dc({
      key: 'ca',
      label: 'Canada',
      accountsServer: 'https://accounts.zohocloud.ca',
      apiDomain: 'https://www.zohoapis.ca',
      // UNVERIFIED: the docs imply inventory.zoho.ca, but accounts lives on zohocloud.ca; probe in smoke.
      inventoryWebHost: 'https://inventory.zoho.ca',
    }),
    sa: dc({
      key: 'sa',
      label: 'Saudi Arabia',
      accountsServer: 'https://accounts.zoho.sa',
      apiDomain: 'https://www.zohoapis.sa',
      // UNVERIFIED: web host pattern not documented for .sa.
      inventoryWebHost: 'https://inventory.zoho.sa',
    }),
  });

export const UNSUPPORTED_DC_KEYS = ['uk', 'cn', 'ae', 'sg'] as const;

export type UnsupportedDcKey = (typeof UNSUPPORTED_DC_KEYS)[number];

export interface UnsupportedDataCenter {
  key: UnsupportedDcKey;
  label: string;
  /** Documented accounts server, if any; used only to recognise the DC and answer `unsupported_dc`. */
  accountsServer: string | null;
  why: string;
}

/** Zoho DCs we must answer with ConnectErrorReason `unsupported_dc`; never sent any request. */
export const UNSUPPORTED_DATA_CENTERS: Readonly<Record<UnsupportedDcKey, UnsupportedDataCenter>> =
  Object.freeze({
    uk: {
      key: 'uk',
      label: 'United Kingdom',
      accountsServer: 'https://accounts.zoho.uk',
      why: 'No Zoho Inventory API host is documented for this data center.',
    },
    cn: {
      key: 'cn',
      label: 'China',
      accountsServer: null,
      why: 'An Inventory API host is documented but no accounts server is.',
    },
    ae: {
      key: 'ae',
      label: 'United Arab Emirates',
      accountsServer: null,
      why: 'No Zoho Inventory API host or accounts server is documented for this data center.',
    },
    sg: {
      key: 'sg',
      label: 'Singapore',
      accountsServer: null,
      why: 'No Zoho Inventory API host or accounts server is documented for this data center.',
    },
  });

export function isSupportedDc(key: unknown): key is ZohoDcKey {
  return typeof key === 'string' && Object.hasOwn(ZOHO_DATA_CENTERS, key);
}

export function isUnsupportedDc(key: unknown): key is UnsupportedDcKey {
  return typeof key === 'string' && Object.hasOwn(UNSUPPORTED_DATA_CENTERS, key);
}

/** Throws for keys outside the supported map; callers validate user input with isSupportedDc first. */
export function getDataCenter(key: ZohoDcKey): Readonly<ZohoDataCenter> {
  if (!isSupportedDc(key)) throw new Error('Unsupported Zoho data center.');
  return ZOHO_DATA_CENTERS[key];
}

/**
 * Normalises a bare https origin (no credentials, path, query or fragment) and returns its origin, or null.
 * Anything else is rejected rather than "cleaned", so lookalikes such as `https://accounts.zoho.in@evil.test`
 * or `https://accounts.zoho.in.evil.test` never match.
 */
function bareHttpsOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  return url.origin;
}

const SUPPORTED_BY_ACCOUNTS = new Map<string, Readonly<ZohoDataCenter>>(
  Object.values(ZOHO_DATA_CENTERS).map((d) => [d.accountsServer, d]),
);

const UNSUPPORTED_BY_ACCOUNTS = new Map<string, UnsupportedDcKey>(
  Object.values(UNSUPPORTED_DATA_CENTERS).flatMap((d) =>
    d.accountsServer === null ? [] : [[d.accountsServer, d.key] as const],
  ),
);

const KNOWN_API_DOMAINS = new Set<string>(Object.values(ZOHO_DATA_CENTERS).map((d) => d.apiDomain));

export type AccountsServerMatch =
  | { kind: 'supported'; dc: Readonly<ZohoDataCenter> }
  | { kind: 'unsupported'; key: UnsupportedDcKey }
  | { kind: 'unknown' };

/**
 * Classifies the OAuth callback's attacker-controllable `accounts-server` param by exact origin match.
 * Callers must use `dc.accountsServer` (our constant), never the raw input, for any request.
 */
export function classifyAccountsServer(raw: unknown): AccountsServerMatch {
  const origin = bareHttpsOrigin(raw);
  if (origin === null) return { kind: 'unknown' };
  const supported = SUPPORTED_BY_ACCOUNTS.get(origin);
  if (supported) return { kind: 'supported', dc: supported };
  const unsupported = UNSUPPORTED_BY_ACCOUNTS.get(origin);
  if (unsupported) return { kind: 'unsupported', key: unsupported };
  return { kind: 'unknown' };
}

/**
 * Allow-list check: true only for the accounts server of a supported DC, i.e. the only hosts that ever receive
 * our client secret, auth codes or refresh tokens.
 */
export function isKnownAccountsServer(raw: unknown): boolean {
  return classifyAccountsServer(raw).kind === 'supported';
}

/** True when `raw` is exactly the Inventory API origin of a supported DC. */
export function isKnownApiDomain(raw: unknown): boolean {
  const origin = bareHttpsOrigin(raw);
  return origin !== null && KNOWN_API_DOMAINS.has(origin);
}

/**
 * Picks the API origin for a token response. Zoho's token docs show `api_domain` values that are not Inventory
 * hosts (e.g. `https://api.zoho.eu`), so anything other than this DC's documented Inventory origin falls back to
 * the DC map.
 */
export function resolveApiDomain(
  dcKey: ZohoDcKey,
  returned: unknown,
): { apiDomain: string; fromResponse: boolean } {
  const expected = getDataCenter(dcKey).apiDomain;
  const fromResponse = bareHttpsOrigin(returned) === expected;
  return { apiDomain: expected, fromResponse };
}
