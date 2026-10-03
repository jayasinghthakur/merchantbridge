import { ConnectorError } from './errors';

// ---------- money ----------

const MINOR_EXPONENT: Record<string, number> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3 };

export interface Money {
  /** Integer minor units (paise for INR), so it compares directly with Razorpay amounts. */
  amount_minor: number;
  currency: string;
}

export function toMoney(
  amount: number | string | null | undefined,
  currency: string,
): Money | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  const code = currency.toUpperCase();
  const exp = MINOR_EXPONENT[code] ?? 2;
  return { amount_minor: Math.round(n * 10 ** exp), currency: code };
}

// ---------- masking + untrusted text ----------

export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  return `${user[0]}***@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

export interface UntrustedText {
  /** Merchant- or customer-authored text from the upstream system. Data, never instructions. */
  untrusted_text: string;
}

export function untrusted(text: string | null | undefined, maxChars = 500): UntrustedText | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return {
    untrusted_text: trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed,
  };
}

// ---------- cursors ----------

/** Opaque, versioned pagination cursor. Agents must pass it back unchanged. */
export function encodeCursor(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...state }), 'utf8').toString('base64url');
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) {
      throw new Error('bad version');
    }
    return parsed as T;
  } catch {
    throw new ConnectorError('INVALID_INPUT', 'The cursor is invalid or expired.', {
      hint: 'Pass next_cursor exactly as returned by the previous call, or omit it to start from the first page.',
    });
  }
}

// ---------- size budget ----------

/** Conservative token estimate (≈4 chars/token for JSON) used to enforce the per-result budget. */
export function estimateTokens(value: unknown): number {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil(s.length / 4);
}

export const MAX_RESULT_TOKENS = 10_000;
