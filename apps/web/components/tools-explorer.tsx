'use client';

import type { ExplorerCallResponse, PublicToolDescriptor, ToolsResponse } from '@mb/core/http';
import type { DemoFault } from '@mb/core/telemetry';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callExplorer, describeApiError, getTools } from '../lib/api';
import { decisionChip } from '../lib/decisions';
import { summarizeRpc } from '../lib/rpc';
import type { FormField, FormValues } from '../lib/schema-form';
import { argsToValues, defaultValues, schemaToFields, valuesToArgs } from '../lib/schema-form';
import { getTabSessionId } from '../lib/session';
import { FaultToggles } from './fault-toggles';
import { Spinner } from './icons';
import { JsonView, prettyJson } from './json-view';
import { Badge, buttonClass, EmptyState, Loading, Notice, Skeleton } from './ui';

type ToolsState =
  { kind: 'loading' } | { kind: 'ready'; data: ToolsResponse } | { kind: 'error'; message: string };

type CallState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; data: ExplorerCallResponse; at: number }
  | { kind: 'error'; message: string };

function typeHint(f: FormField): string {
  if (f.kind === 'array') return `list of ${f.itemKind ?? 'string'}, comma separated`;
  if (f.kind === 'enum') return 'one of';
  const range =
    f.minimum !== null || f.maximum !== null
      ? ` ${f.minimum ?? ''}–${f.maximum ?? ''}`.replace(/\s–$/, '')
      : '';
  return `${f.kind}${range}`;
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: FormField;
  value: string;
  error: string | undefined;
  onChange: (v: string) => void;
}) {
  const id = `arg-${field.name}`;
  const describedBy = `${id}-hint`;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-mono font-semibold text-ink">{field.name}</span>
        {field.required ? (
          <span className="text-xs font-semibold text-danger">required</span>
        ) : null}
        <span className="text-xs text-ink-subtle">{typeHint(field)}</span>
      </label>
      {field.kind === 'enum' ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mb-input mt-1"
          aria-describedby={describedBy}
        >
          <option value="">{field.required ? 'Choose…' : '(not set)'}</option>
          {field.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      ) : field.kind === 'boolean' ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mb-input mt-1"
          aria-describedby={describedBy}
        >
          <option value="">(not set)</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode={field.kind === 'number' || field.kind === 'integer' ? 'decimal' : undefined}
          className="mb-input mt-1 font-mono text-sm"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      <p id={describedBy} className={`mt-1 text-xs ${error ? 'text-danger' : 'text-ink-muted'}`}>
        {error ? `${field.name} ${error}` : (field.description ?? '')}
      </p>
    </div>
  );
}

function ToolDetail({
  tool,
  sessionId,
  faults,
  onFaultsChange,
}: {
  tool: PublicToolDescriptor;
  sessionId: string | null;
  /** Owned by the explorer, not the tool: faults model the demo upstream for this tab, whichever tool runs next. */
  faults: DemoFault[];
  onFaultsChange: (next: DemoFault[]) => void;
}) {
  const { fields, unsupported } = useMemo(() => schemaToFields(tool.inputJsonSchema), [tool]);
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [values, setValues] = useState<FormValues>(() => defaultValues(fields));
  const [raw, setRaw] = useState('{}');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [call, setCall] = useState<CallState>({ kind: 'idle' });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const switchMode = (next: 'form' | 'json') => {
    if (next === mode) return;
    if (next === 'json') {
      setRaw(prettyJson(valuesToArgs(fields, values).args));
      setJsonError(null);
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          setValues(argsToValues(fields, parsed as Record<string, unknown>));
        }
      } catch {
        // keep the previous form values if the JSON is invalid
      }
    }
    setMode(next);
  };

  const run = async () => {
    let args: Record<string, unknown>;
    if (mode === 'form') {
      const built = valuesToArgs(fields, values);
      setErrors(built.errors);
      if (Object.keys(built.errors).length > 0) return;
      args = built.args;
    } else {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setJsonError('Arguments must be a JSON object.');
          return;
        }
        args = parsed as Record<string, unknown>;
        setJsonError(null);
      } catch (e) {
        setJsonError(e instanceof Error ? e.message : 'Invalid JSON.');
        return;
      }
    }
    if (!sessionId) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setCall({ kind: 'running' });
    try {
      const data = await callExplorer(
        { tool: tool.name, args, session_id: sessionId, faults },
        { signal: ac.signal },
      );
      setCall({ kind: 'done', data, at: Date.now() });
    } catch (e) {
      if (!ac.signal.aborted) setCall({ kind: 'error', message: describeApiError(e) });
    }
  };

  const rpc = call.kind === 'done' ? summarizeRpc(call.data.response) : null;

  return (
    <div className="min-w-0 space-y-5">
      <div className="mb-card p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-bold tracking-tight">{tool.title}</h2>
          {tool.annotations.readOnlyHint ? <Badge tone="brand">read-only</Badge> : null}
        </div>
        <p className="mt-0.5 font-mono text-sm break-all text-brand-ink">{tool.name}</p>
        <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-ink-muted">
          {tool.description}
        </p>
        {tool.scopes.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-ink-subtle">Scopes</span>
            {tool.scopes.map((s) => (
              <Badge key={s} mono>
                {s}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <form
        className="mb-card p-4 sm:p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold">Arguments</h3>
          <div
            role="tablist"
            aria-label="Argument editor"
            className="inline-flex rounded-sm border border-line p-0.5"
          >
            {(['form', 'json'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={`h-7 rounded-[4px] px-3 text-xs font-semibold ${
                  mode === m ? 'bg-brand-soft text-brand-ink' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {m === 'form' ? 'Form' : 'Raw JSON'}
              </button>
            ))}
          </div>
        </div>

        {mode === 'form' ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {fields.length === 0 ? (
              <p className="text-sm text-ink-muted sm:col-span-2">This tool takes no arguments.</p>
            ) : (
              fields.map((f) => (
                <FieldInput
                  key={f.name}
                  field={f}
                  value={values[f.name] ?? ''}
                  error={errors[f.name]}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                />
              ))
            )}
            {unsupported.length > 0 ? (
              <p className="text-xs text-ink-muted sm:col-span-2">
                Edit {unsupported.join(', ')} in Raw JSON.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-4">
            <label htmlFor="raw-args" className="sr-only">
              Arguments as JSON
            </label>
            <textarea
              id="raw-args"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={8}
              spellCheck={false}
              className="mb-input font-mono text-sm"
              aria-invalid={jsonError ? true : undefined}
            />
            {jsonError ? <p className="mt-1 text-xs text-danger">{jsonError}</p> : null}
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className={buttonClass('primary')}
            disabled={call.kind === 'running' || !sessionId}
          >
            {call.kind === 'running' ? <Spinner size={15} /> : null}
            Run {tool.name}
          </button>
          {faults.length > 0 ? (
            <span className="text-xs text-accent-ink">
              with {faults.length} fault{faults.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </form>

      <FaultToggles value={faults} onChange={onFaultsChange} disabled={call.kind === 'running'} />

      <section aria-label="Call result" aria-live="polite" className="space-y-3">
        {call.kind === 'idle' ? (
          <EmptyState title="No call yet">
            Run the tool to see the raw JSON-RPC request sent to /mcp/demo and the response it
            returned.
          </EmptyState>
        ) : null}
        {call.kind === 'running' ? <Loading label={`Calling ${tool.name}…`} /> : null}
        {call.kind === 'error' ? (
          <Notice tone="error" title="The explorer call failed">
            {call.message}
          </Notice>
        ) : null}
        {call.kind === 'done' && rpc ? (
          <>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="explorer-summary">
              {rpc.isError ? (
                <Badge tone="danger" testId="explorer-error-badge">
                  isError {rpc.code ?? ''}
                </Badge>
              ) : (
                <Badge tone="brand">ok</Badge>
              )}
              <Badge mono>{call.data.duration_ms} ms</Badge>
            </div>
            {call.data.decisions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-ink-subtle">Governor decisions</span>
                <ul
                  className="flex flex-wrap gap-1.5"
                  aria-label="Governor decisions"
                  data-testid="explorer-decisions"
                >
                  {call.data.decisions.map((d, i) => {
                    const chip = decisionChip(d, call.at);
                    return (
                      <li key={i}>
                        <Badge
                          mono
                          tone={chip.tone}
                          title={chip.detail}
                          testId={`decision-${d.type}`}
                        >
                          {chip.label}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {rpc.structured !== null ? (
              <JsonView
                value={rpc.structured}
                label={
                  rpc.isError ? 'Error result (structuredContent)' : 'Result (structuredContent)'
                }
                testId="rpc-result"
              />
            ) : null}
            <JsonView value={call.data.request} label="JSON-RPC request" testId="rpc-request" />
            <JsonView value={call.data.response} label="JSON-RPC response" testId="rpc-response" />
          </>
        ) : null}
      </section>
    </div>
  );
}

export function ToolsExplorer() {
  const [state, setState] = useState<ToolsState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [faults, setFaults] = useState<DemoFault[]>([]);

  const load = useCallback((signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    getTools({ signal }).then(
      (data) => {
        setState({ kind: 'ready', data });
        setSelected((cur) => cur ?? data.tools[0]?.name ?? null);
      },
      (e: unknown) => {
        if (!signal?.aborted) setState({ kind: 'error', message: describeApiError(e) });
      },
    );
  }, []);

  useEffect(() => {
    setSessionId(getTabSessionId());
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)]" aria-busy="true">
        <div className="space-y-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
        <div>
          <Loading label="Loading tools from the API…" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <Notice
        tone="error"
        title="Could not load the tool list"
        action={
          <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => load()}>
            Retry
          </button>
        }
      >
        {state.message}
      </Notice>
    );
  }

  const tools = state.data.tools;
  if (tools.length === 0) {
    return (
      <EmptyState title="The server lists no tools">
        The API answered, but tools/list is empty.
      </EmptyState>
    );
  }
  const tool = tools.find((t) => t.name === selected) ?? tools[0];
  if (!tool) return null;

  return (
    <div className="grid gap-6 md:grid-cols-[260px_minmax(0,1fr)] md:items-start">
      <div className="min-w-0">
        <label htmlFor="tool-select" className="text-sm font-bold md:hidden">
          Tool
        </label>
        <select
          id="tool-select"
          className="mb-input mt-1 font-mono text-sm md:hidden"
          value={tool.name}
          onChange={(e) => setSelected(e.target.value)}
        >
          {tools.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <nav aria-label="Tools" className="hidden md:block">
          <p className="mb-2 text-xs font-semibold text-ink-subtle">
            {state.data.server.name} v{state.data.server.version} · {tools.length} tools
          </p>
          <ul className="space-y-1" data-testid="tool-list">
            {tools.map((t) => {
              const active = t.name === tool.name;
              return (
                <li key={t.name}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.name)}
                    aria-current={active ? 'true' : undefined}
                    className={`w-full rounded-sm border px-3 py-2 text-left transition-colors ${
                      active
                        ? 'border-brand bg-brand-soft'
                        : 'border-transparent hover:border-line hover:bg-raised'
                    }`}
                  >
                    <span className="block text-sm font-semibold text-ink">{t.title}</span>
                    <span className="block truncate font-mono text-xs text-ink-muted">
                      {t.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <ToolDetail
        key={tool.name}
        tool={tool}
        sessionId={sessionId}
        faults={faults}
        onFaultsChange={setFaults}
      />
    </div>
  );
}
