import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateMcpToolsJson } from '../src/tools-doc';

describe('docs/mcp-tools.json', () => {
  it('matches a fresh tools/list (run `pnpm gen:tools` if this fails)', async () => {
    const committed = readFileSync(
      new URL('../../../docs/mcp-tools.json', import.meta.url),
      'utf8',
    );
    const fresh = await generateMcpToolsJson();
    expect(committed === fresh, 'docs/mcp-tools.json is stale: run `pnpm gen:tools`').toBe(true);
  });
});
