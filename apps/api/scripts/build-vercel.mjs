// Bundles apps/api into one Vercel Function using the Build Output API v3 (.vercel/output). One bundle (workspace
// TypeScript packages + npm deps) sidesteps extensionless ESM imports and pnpm's strict node_modules at runtime.
// Run from apps/api: `pnpm build:vercel` (Vercel's Build Command; Root Directory = apps/api).
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel', 'output');
const fn = join(out, 'functions', 'index.func');
const runtime = process.env.MB_VERCEL_RUNTIME ?? 'nodejs22.x';

await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  // Dev-only modules that production never loads: PGlite (local DB fallback) and pino's pretty printer.
  external: ['@electric-sql/pglite', 'pino-pretty'],
  // CommonJS dependencies inside an ESM bundle need require/__dirname.
  banner: {
    js: [
      "import { createRequire as __mbCreateRequire } from 'node:module';",
      "import { fileURLToPath as __mbFileURLToPath } from 'node:url';",
      "import { dirname as __mbDirname } from 'node:path';",
      'const require = __mbCreateRequire(import.meta.url);',
      'const __filename = __mbFileURLToPath(import.meta.url);',
      'const __dirname = __mbDirname(__filename);',
    ].join('\n'),
  },
});

await writeFile(
  join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime,
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      maxDuration: 300,
    },
    null,
    2,
  ),
);
await writeFile(join(fn, 'package.json'), JSON.stringify({ type: 'module' }));
await writeFile(
  join(out, 'config.json'),
  JSON.stringify({ version: 3, routes: [{ src: '/(.*)', dest: '/index' }] }, null, 2),
);
console.log(`built ${join('.vercel', 'output')} (runtime ${runtime})`);
