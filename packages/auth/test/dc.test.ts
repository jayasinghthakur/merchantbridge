import { describe, expect, it } from 'vitest';
import {
  UNSUPPORTED_DC_KEYS,
  ZOHO_DATA_CENTERS,
  ZOHO_DC_KEYS,
  buildAuthorizeUrl,
  classifyAccountsServer,
  isKnownAccountsServer,
  isKnownApiDomain,
  isSupportedDc,
  resolveApiDomain,
  type ZohoDcKey,
} from '../src/index';
import { CLIENT_ID, REDIRECT_URI, SCOPES } from './fakes';

describe('data center map', () => {
  it('covers exactly the DCs with a documented Inventory API host and accounts server', () => {
    expect([...ZOHO_DC_KEYS].sort()).toEqual(['au', 'ca', 'eu', 'in', 'jp', 'sa', 'us']);
    for (const key of ZOHO_DC_KEYS) {
      const dc = ZOHO_DATA_CENTERS[key];
      expect(dc.key).toBe(key);
      for (const origin of [dc.accountsServer, dc.apiDomain, dc.inventoryWebHost]) {
        expect(new URL(origin).origin).toBe(origin);
        expect(origin.startsWith('https://')).toBe(true);
      }
    }
    expect(ZOHO_DATA_CENTERS.ca.accountsServer).toBe('https://accounts.zohocloud.ca');
    expect(new URL(ZOHO_DATA_CENTERS.ca.apiDomain).hostname.endsWith('.ca')).toBe(true);
    expect(new URL(ZOHO_DATA_CENTERS.au.apiDomain).hostname.endsWith('.com.au')).toBe(true);
  });

  it('marks UK, CN, AE and SG unsupported', () => {
    expect([...UNSUPPORTED_DC_KEYS].sort()).toEqual(['ae', 'cn', 'sg', 'uk']);
    for (const key of UNSUPPORTED_DC_KEYS) expect(isSupportedDc(key)).toBe(false);
    expect(classifyAccountsServer('https://accounts.zoho.uk')).toEqual({
      kind: 'unsupported',
      key: 'uk',
    });
  });

  it('isSupportedDc ignores prototype keys and non-strings', () => {
    for (const k of ['__proto__', 'toString', 'constructor', '', 'IN', 1, null, undefined]) {
      expect(isSupportedDc(k)).toBe(false);
    }
    expect(isSupportedDc('in')).toBe(true);
  });
});

describe('isKnownAccountsServer (callback accounts-server allow-list)', () => {
  it('accepts each supported accounts server', () => {
    for (const key of ZOHO_DC_KEYS) {
      expect(isKnownAccountsServer(ZOHO_DATA_CENTERS[key].accountsServer)).toBe(true);
      expect(isKnownAccountsServer(`${ZOHO_DATA_CENTERS[key].accountsServer}/`)).toBe(true);
    }
  });

  it.each([
    'http://accounts.zoho.in',
    'https://accounts.zoho.in.evil.test',
    'https://accounts.zoho.in@evil.test',
    'https://user:pw@accounts.zoho.in',
    'https://evil.test/?next=https://accounts.zoho.in',
    'https://accounts.zoho.in/oauth/v2/token',
    'https://accounts.zoho.in?x=1',
    'https://accounts.zoho.in#frag',
    'https://accounts.zoho.in:8443',
    'https://accounts.zoho.uk',
    'https://accounts.zoho.com.cn',
    'accounts.zoho.in',
    '//accounts.zoho.in',
    '',
    `https://accounts.zoho.in/${'a'.repeat(300)}`,
  ])('rejects %s', (raw) => {
    expect(isKnownAccountsServer(raw)).toBe(false);
  });

  it('rejects non-string input', () => {
    for (const raw of [undefined, null, 42, ['https://accounts.zoho.in'], {}]) {
      expect(isKnownAccountsServer(raw)).toBe(false);
    }
  });
});

describe('api domain validation', () => {
  it('knows exactly the DC map API origins', () => {
    for (const key of ZOHO_DC_KEYS)
      expect(isKnownApiDomain(ZOHO_DATA_CENTERS[key].apiDomain)).toBe(true);
    expect(isKnownApiDomain('https://api.zoho.eu')).toBe(false);
    expect(isKnownApiDomain('https://evil.test')).toBe(false);
  });

  it('falls back to the DC map for undocumented or cross-DC api_domain values', () => {
    const inApi = ZOHO_DATA_CENTERS.in.apiDomain;
    expect(resolveApiDomain('in', inApi)).toEqual({ apiDomain: inApi, fromResponse: true });
    // The token docs' own example returns https://api.zoho.eu, which is not an Inventory host.
    expect(resolveApiDomain('eu', 'https://api.zoho.eu')).toEqual({
      apiDomain: ZOHO_DATA_CENTERS.eu.apiDomain,
      fromResponse: false,
    });
    expect(resolveApiDomain('in', ZOHO_DATA_CENTERS.us.apiDomain).apiDomain).toBe(inApi);
    expect(resolveApiDomain('in', 'https://evil.test').apiDomain).toBe(inApi);
    expect(resolveApiDomain('in', undefined).apiDomain).toBe(inApi);
  });
});

describe('buildAuthorizeUrl', () => {
  it('targets the DC accounts server with the documented params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        dc: 'in',
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES,
        state: 'opaque-state',
      }),
    );
    expect(url.origin).toBe('https://accounts.zoho.in');
    expect(url.pathname).toBe('/oauth/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: SCOPES.join(','),
      redirect_uri: REDIRECT_URI,
      access_type: 'offline',
      prompt: 'consent',
      state: 'opaque-state',
    });
  });

  it('uses zohocloud.ca for Canada', () => {
    const url = new URL(
      buildAuthorizeUrl({
        dc: 'ca',
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scopes: SCOPES,
        state: 's',
      }),
    );
    expect(url.origin).toBe('https://accounts.zohocloud.ca');
  });

  it('rejects unsupported DCs and bad inputs', () => {
    const base = {
      dc: 'in' as ZohoDcKey,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: SCOPES,
      state: 's',
    };
    expect(() => buildAuthorizeUrl({ ...base, dc: 'uk' as ZohoDcKey })).toThrow();
    expect(() => buildAuthorizeUrl({ ...base, scopes: [] })).toThrow();
    expect(() => buildAuthorizeUrl({ ...base, scopes: ['a,b'] })).toThrow();
    expect(() => buildAuthorizeUrl({ ...base, state: '' })).toThrow();
    expect(() => buildAuthorizeUrl({ ...base, clientId: '' })).toThrow();
    expect(() => buildAuthorizeUrl({ ...base, redirectUri: 'javascript:alert(1)' })).toThrow();
  });
});
