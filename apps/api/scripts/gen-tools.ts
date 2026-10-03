import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateMcpToolsJson } from '../src/tools-doc';

/** pnpm gen:tools: writes docs/mcp-tools.json from a real in-process tools/list against /mcp/demo. */
const target = fileURLToPath(new URL('../../../docs/mcp-tools.json', import.meta.url));
const json = await generateMcpToolsJson();
writeFileSync(target, json, 'utf8');
const count = (JSON.parse(json) as { tools: unknown[] }).tools.length;
process.stdout.write(`wrote ${target} (${count} tools)\n`);
