import { sql } from 'drizzle-orm';
import type { DbHandle } from '../src/index';
import { createDbStores, createMemoryStores, createPgliteDb } from '../src/index';
import { runStoreContract } from './contract';

runStoreContract('memory', {
  setup: () => Promise.resolve(),
  fresh: (clock) => Promise.resolve(createMemoryStores({ clock })),
  teardown: () => Promise.resolve(),
});

// One PGlite per suite (boot + migrate takes ~2 s); tables are truncated before every test.
let pg: DbHandle | undefined;
runStoreContract('postgres (PGlite)', {
  setup: async () => {
    pg = await createPgliteDb();
  },
  fresh: async (clock) => {
    if (!pg) throw new Error('PGlite not started');
    await pg.db.execute(
      sql`truncate table usage_events, api_keys, connections, tenants restart identity cascade`,
    );
    return createDbStores(pg.db, { clock });
  },
  teardown: async () => {
    await pg?.close();
  },
});
