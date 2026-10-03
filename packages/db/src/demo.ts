import type { TenantRecord } from '@mb/core';
import { DEMO_IDS } from '@mb/core';
import type { MbStores } from './shared';

/** Fixed id of the public demo tenant (FakeZoho only). Public routes bind to it and never to a live tenant. */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-00000000de30';
export const DEMO_TENANT_NAME = DEMO_IDS.orgName;

/** Creates the demo tenant if missing; safe to call on every boot. */
export async function ensureDemoTenant(stores: Pick<MbStores, 'tenants'>): Promise<TenantRecord> {
  const tenant = await stores.tenants.ensure({
    id: DEMO_TENANT_ID,
    name: DEMO_TENANT_NAME,
    kind: 'demo',
  });
  // A live tenant under the demo id would expose real credentials on public routes; refuse to boot.
  if (tenant.kind !== 'demo') {
    throw new Error(`Tenant ${DEMO_TENANT_ID} exists but is not a demo tenant.`);
  }
  return tenant;
}
