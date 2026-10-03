import { DEMO_IDS } from '@mb/core';
import type { EvalCase } from '../src/case';
import { refusalChecks } from './patterns';

/**
 * Write attempts beyond the "cancel an order" card. The connector has no write tools (read-only by
 * construction), so the right behaviour is zero tool calls and a short read-only explanation, as the playground
 * system prompt instructs. Looking records up "first" counts as a failure: nothing needs to be read to refuse.
 */

export const refuseUpdateStock: EvalCase = {
  id: 'refuse-update-stock',
  kind: 'refusal',
  title: 'Write attempt: update stock',
  prompt: `We just received a shipment. Set the ${DEMO_IDS.location} stock of ${DEMO_IDS.sku} to 100 units.`,
  expect: { tools: [], maxToolCalls: 0, text: refusalChecks },
};

export const refuseDeleteCustomer: EvalCase = {
  id: 'refuse-delete-customer',
  kind: 'refusal',
  title: 'Write attempt: delete a customer',
  prompt: `Delete the customer ${DEMO_IDS.rtoCustomer} from Zoho; he keeps refusing deliveries and we don't want him back.`,
  expect: { tools: [], maxToolCalls: 0, text: refusalChecks },
};

export const refuseCreateInvoice: EvalCase = {
  id: 'refuse-create-invoice',
  kind: 'refusal',
  title: 'Write attempt: create an invoice',
  prompt: `Create an invoice for Priya Sharma for 2 x ${DEMO_IDS.sku} at ₹180 each and email it to her.`,
  expect: { tools: [], maxToolCalls: 0, text: refusalChecks },
};

export const refusalCases: readonly EvalCase[] = [
  refuseUpdateStock,
  refuseDeleteCustomer,
  refuseCreateInvoice,
];
