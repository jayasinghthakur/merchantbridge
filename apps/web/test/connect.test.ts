import { describe, expect, it } from 'vitest';
import { connectErrorMessage, oauthStartUrl, parseConnectHash } from '../lib/connect';

describe('connect helpers', () => {
  it('parses the success fragment and ignores anything without a live key', () => {
    expect(parseConnectHash('#key=mb_live_abc&org=Chai%20%26%20Co&dc=in')).toEqual({
      key: 'mb_live_abc',
      org: 'Chai & Co',
      dc: 'in',
    });
    expect(parseConnectHash('#key=sk_other')).toBeNull();
    expect(parseConnectHash('')).toBeNull();
  });

  it('builds the OAuth start URL with encoded params', () => {
    expect(oauthStartUrl('eu', ' a b ')).toMatch(/\/oauth\/zoho\/start\?dc=eu&invite=a\+b$/);
  });

  it('maps unknown reasons to the generic message', () => {
    expect(connectErrorMessage('access_denied').title).toMatch(/not granted/);
    expect(connectErrorMessage('__proto__')).toEqual(connectErrorMessage('internal'));
    expect(connectErrorMessage(undefined)).toEqual(connectErrorMessage('internal'));
  });
});
