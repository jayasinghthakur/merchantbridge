import { ConnectorError } from '@mb/core';

/**
 * Agent-visible errors raised by @mb/auth. Messages are static on purpose: nothing from Zoho responses, tokens,
 * codes or client credentials can reach them.
 */

/** Zoho documents a 10-minute block once token creation is throttled; retrying sooner extends nothing useful. */
export const TOKEN_THROTTLE_RETRY_AFTER_S = 60;

export function reconnectRequiredError(): ConnectorError {
  return new ConnectorError(
    'RECONNECT_REQUIRED',
    'The Zoho connection needs to be re-authorized by the merchant.',
    { hint: 'Ask the merchant to reconnect Zoho Inventory at /connect.' },
  );
}

export function tokenThrottledError(retryAfterS = TOKEN_THROTTLE_RETRY_AFTER_S): ConnectorError {
  return new ConnectorError('UPSTREAM_ERROR', 'Zoho is temporarily limiting token requests.', {
    retryable: true,
    retryAfterS,
    hint: 'Wait before retrying; Zoho allows only a few token requests every 10 minutes.',
  });
}

export function accountsUnavailableError(): ConnectorError {
  return new ConnectorError('UPSTREAM_ERROR', 'Zoho Accounts is temporarily unavailable.', {
    retryable: true,
  });
}

export function oauthClientMisconfiguredError(): ConnectorError {
  return new ConnectorError(
    'UPSTREAM_ERROR',
    'The connector could not authenticate with Zoho Accounts.',
    {
      retryable: false,
      hint: 'This is a connector configuration problem; retrying will not help.',
    },
  );
}

export function unknownAccountsServerError(): ConnectorError {
  return new ConnectorError(
    'UPSTREAM_ERROR',
    'The Zoho connection points at an unknown accounts server.',
    {
      retryable: false,
      hint: 'Ask the merchant to reconnect Zoho Inventory at /connect.',
    },
  );
}
