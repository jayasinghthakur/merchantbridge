import { z } from 'zod';
import type { GovernorDecision } from './governor';

export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface Page {
  next_cursor: string | null;
  has_more: boolean;
}

export interface Meta {
  organization_id: string;
  as_of: string;
  cached: boolean;
  /** Deep link to the record in the upstream web app, so a human can verify the agent's claim. */
  zoho_url: string | null;
  budget_remaining_today: number | null;
  demo: boolean;
}

export interface Envelope<T> {
  data: T;
  page?: Page;
  meta: Meta;
}

export const pageSchema = z.object({
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const metaSchema = z.object({
  organization_id: z.string(),
  as_of: z.string(),
  cached: z.boolean(),
  zoho_url: z.string().nullable(),
  budget_remaining_today: z.number().nullable(),
  demo: z.boolean(),
});

/** The MCP outputSchema of a tool: the envelope wrapped around that tool's `data` schema. */
export function envelopeSchema<O extends z.ZodType>(data: O) {
  return z.object({ data, page: pageSchema.optional(), meta: metaSchema });
}

export interface ToolCallContext<C> {
  tenantId: string;
  organizationId: string;
  demo: boolean;
  requestId: string;
  /** Connector-specific API client, already bound to tenant, org, governor and credentials. */
  client: C;
  log: Logger;
  /** Records governor/cache decisions for the usage event and the playground trace. */
  note(decision: GovernorDecision): void;
}

export interface ToolHandlerResult<T> {
  data: T;
  page?: Page;
  upstreamUrl?: string | null;
  cached?: boolean;
}

export interface ToolDefinition<C, I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** `zoho_<verb>_<noun>`; must match /^[a-z][a-z0-9_]{2,63}$/ */
  name: string;
  title: string;
  /** What it returns + "Use when…" + "Don't use when… (use X instead)" + limits. */
  description: string;
  input: I;
  /** Schema of `data` only. Parsing with it strips unknown keys, so it doubles as the field allow-list. */
  output: O;
  /** Upstream OAuth scopes the tool needs. */
  scopes: readonly string[];
  handler(args: z.output<I>, ctx: ToolCallContext<C>): Promise<ToolHandlerResult<z.output<O>>>;
}

export type AnyToolDefinition<C> = ToolDefinition<C, z.ZodType, z.ZodType>;

/** `const defineTool = createToolFactory<ZohoApi>()` gives typed `ctx.client` in every tool of a connector. */
export function createToolFactory<C>() {
  return function defineTool<I extends z.ZodType, O extends z.ZodType>(
    def: ToolDefinition<C, I, O>,
  ): ToolDefinition<C, I, O> {
    return def;
  };
}

export interface ConnectorDefinition<C> {
  id: string;
  name: string;
  /** All scopes requested on first consent. */
  scopes: readonly string[];
  tools: readonly AnyToolDefinition<C>[];
}

export function defineConnector<C>(def: ConnectorDefinition<C>): ConnectorDefinition<C> {
  const seen = new Set<string>();
  for (const t of def.tools) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(t.name)) throw new Error(`Invalid tool name: ${t.name}`);
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    seen.add(t.name);
    for (const s of t.scopes) {
      if (!def.scopes.includes(s)) throw new Error(`Tool ${t.name} needs unrequested scope ${s}`);
    }
  }
  return def;
}

/** Annotations are hints for hosts; read-only is enforced server-side, not by these. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
