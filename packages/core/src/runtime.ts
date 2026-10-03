import { z } from 'zod';
import type { Clock } from './clock';
import { systemClock } from './clock';
import type { ErrorCode, ToolErrorBody } from './errors';
import { ConnectorError, isConnectorError, isUpstreamError } from './errors';
import { MAX_RESULT_TOKENS, estimateTokens } from './format';
import type { GovernorDecision } from './governor';
import type { UsageEvent } from './telemetry';
import { maskArgs } from './telemetry';
import type { AnyToolDefinition, ConnectorDefinition, Envelope, Logger } from './tool';
import { READ_ONLY_ANNOTATIONS, envelopeSchema } from './tool';

export interface CallOptions {
  tenantId: string;
  requestId: string;
  demo: boolean;
  clientName?: string | null;
}

export interface ResolvedTenant<C> {
  client: C;
  organizationId: string;
  /** Remaining daily upstream budget for this tenant/org, if known. */
  budgetRemaining(): Promise<number | null>;
}

export interface ToolRuntimeDeps<C> {
  connector: ConnectorDefinition<C>;
  /** Binds credentials, org and governor for the caller. Throws ConnectorError (e.g. RECONNECT_REQUIRED). */
  resolve(opts: CallOptions, onDecision: (d: GovernorDecision) => void): Promise<ResolvedTenant<C>>;
  /** Called exactly once per callTool, success or error. Must not throw (failures are logged). */
  emit(event: UsageEvent): void | Promise<void>;
  log: Logger;
  clock?: Clock;
  maxResultTokens?: number;
}

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
  annotations: typeof READ_ONLY_ANNOTATIONS;
  scopes: readonly string[];
}

export interface ToolCallResult {
  isError: boolean;
  structuredContent: Envelope<unknown> | ToolErrorBody;
  /** JSON text copy of structuredContent for clients that ignore structured output. */
  text: string;
  decisions: GovernorDecision[];
  usage: UsageEvent;
}

/** Protocol-level error (unknown tool): maps to a JSON-RPC error, not an isError result. */
export class UnknownToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = 'UnknownToolError';
  }
}

function zodIssuesToMessage(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

export interface ToolRuntime {
  listTools(): ToolDescriptor[];
  callTool(name: string, rawArgs: unknown, opts: CallOptions): Promise<ToolCallResult>;
}

export function createToolRuntime<C>(deps: ToolRuntimeDeps<C>): ToolRuntime {
  const clock = deps.clock ?? systemClock;
  const maxTokens = deps.maxResultTokens ?? MAX_RESULT_TOKENS;
  const tools = new Map<string, AnyToolDefinition<C>>(deps.connector.tools.map((t) => [t.name, t]));

  const descriptors: ToolDescriptor[] = [...deps.connector.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const output = envelopeSchema(t.output);
      return {
        name: t.name,
        title: t.title,
        description: t.description,
        input: t.input,
        output,
        inputJsonSchema: z.toJSONSchema(t.input, { io: 'input' }),
        outputJsonSchema: z.toJSONSchema(output, { io: 'output' }),
        annotations: READ_ONLY_ANNOTATIONS,
        scopes: t.scopes,
      };
    });

  async function callTool(name: string, rawArgs: unknown, opts: CallOptions): Promise<ToolCallResult> {
    const tool = tools.get(name);
    if (!tool) throw new UnknownToolError(name);

    const started = clock.now();
    const decisions: GovernorDecision[] = [];
    const note = (d: GovernorDecision) => decisions.push(d);
    let organizationId: string | null = null;
    let structuredContent: Envelope<unknown> | ToolErrorBody;
    let errorCode: ErrorCode | null = null;

    try {
      const parsedArgs = tool.input.safeParse(rawArgs ?? {});
      if (!parsedArgs.success) {
        throw new ConnectorError('INVALID_INPUT', `Invalid arguments: ${zodIssuesToMessage(parsedArgs.error)}`, {
          hint: 'Check the tool input schema; ids and cursors must be passed exactly as returned by other tools.',
        });
      }

      const tenant = await deps.resolve(opts, note);
      organizationId = tenant.organizationId;

      const result = await tool.handler(parsedArgs.data, {
        tenantId: opts.tenantId,
        organizationId: tenant.organizationId,
        demo: opts.demo,
        requestId: opts.requestId,
        client: tenant.client,
        log: deps.log,
        note,
      });

      const data = tool.output.safeParse(result.data);
      if (!data.success) {
        deps.log.error(
          { tool: name, request_id: opts.requestId, issues: zodIssuesToMessage(data.error) },
          'tool output failed its schema',
        );
        throw new ConnectorError('UPSTREAM_ERROR', 'The upstream system returned data in an unexpected shape.', {
          retryable: false,
          hint: 'This is a connector bug; try a different query or report it.',
        });
      }

      const envelope: Envelope<unknown> = {
        data: data.data,
        ...(result.page ? { page: result.page } : {}),
        meta: {
          organization_id: tenant.organizationId,
          as_of: new Date(clock.now()).toISOString(),
          cached: result.cached ?? decisions.some((d) => d.type === 'cache_hit'),
          zoho_url: result.upstreamUrl ?? null,
          budget_remaining_today: await tenant.budgetRemaining(),
          demo: opts.demo,
        },
      };

      if (estimateTokens(envelope) > maxTokens) {
        throw new ConnectorError('INVALID_INPUT', 'The result is too large to return in one call.', {
          hint: 'Use a smaller limit, narrower filters, or a get_* tool for a single record.',
        });
      }
      structuredContent = envelope;
    } catch (e) {
      if (e instanceof UnknownToolError) throw e;
      let ce: ConnectorError;
      if (isConnectorError(e)) ce = e;
      else if (isUpstreamError(e)) {
        ce = new ConnectorError('UPSTREAM_ERROR', 'The upstream system is temporarily unavailable.', {
          retryable: true,
        });
      } else {
        deps.log.error({ tool: name, request_id: opts.requestId, err: e }, 'unexpected tool error');
        ce = new ConnectorError('UPSTREAM_ERROR', 'Unexpected connector error.', { retryable: true });
      }
      errorCode = ce.code;
      structuredContent = ce.toBody();
    }

    const text = JSON.stringify(structuredContent);
    const usage: UsageEvent = {
      ts: new Date(started).toISOString(),
      request_id: opts.requestId,
      tenant_id: opts.tenantId,
      organization_id: organizationId,
      connector: deps.connector.id,
      tool: name,
      client_name: opts.clientName ?? null,
      demo: opts.demo,
      status: errorCode ? 'error' : 'ok',
      error_code: errorCode,
      duration_ms: clock.now() - started,
      upstream_calls: decisions.filter((d) => d.type === 'admitted').length,
      cache_hits: decisions.filter((d) => d.type === 'cache_hit').length,
      retries: decisions.filter((d) => d.type === 'retried').length,
      result_tokens: estimateTokens(text),
      args_masked: maskArgs(rawArgs),
    };
    try {
      await deps.emit(usage);
    } catch (err) {
      deps.log.error({ err, request_id: opts.requestId }, 'usage event emit failed');
    }

    return { isError: errorCode !== null, structuredContent, text, decisions, usage };
  }

  return { listTools: () => descriptors, callTool };
}
