import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Golden rule 2: every Zoho call goes ZohoClient → Governor. Only the client (and the auth package's DC map)
 * may even name the Zoho API host; a stray literal elsewhere is how a bypass starts.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LITERAL = ['zoho', 'apis'].join('');
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'coverage',
  'test',
  'tests',
  '__tests__',
  'e2e',
  'vendor',
]);
const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const ALLOWED = [/^packages\/zoho-inventory\/src\/client\.ts$/, /^packages\/auth\/src\//];

/** Hostnames are case-insensitive, so `ZohoAPIs.in` is the same host and must be caught too. */
function mentionsHost(text: string): boolean {
  return text.toLowerCase().includes(LITERAL);
}

function walk(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (SOURCE.test(e.name) && !/\.(test|spec)\.[a-z]+$/.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

describe(`the "${LITERAL}" literal`, () => {
  it('appears only in ZohoClient and the auth DC map', () => {
    const files = [...walk(join(ROOT, 'packages'), []), ...walk(join(ROOT, 'apps'), [])];
    expect(files.length).toBeGreaterThan(10);
    const offenders = files
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((rel) => !ALLOWED.some((re) => re.test(rel)))
      .filter((rel) => {
        return mentionsHost(readFileSync(join(ROOT, rel), 'utf8'));
      });
    expect(offenders).toEqual([]);
  });

  it('matches the host in any letter case', () => {
    expect(mentionsHost(`https://www.ZOHO${'APIS'}.in/inventory/v1`)).toBe(true);
    expect(mentionsHost(`www.Zoho${'Apis'}.com`)).toBe(true);
    expect(mentionsHost('inventory.zoho.in')).toBe(false);
  });

  it('is present in the client (the allow-list is not stale)', () => {
    const client = readFileSync(join(ROOT, 'packages/zoho-inventory/src/client.ts'), 'utf8');
    expect(client).toContain(LITERAL);
  });
});
