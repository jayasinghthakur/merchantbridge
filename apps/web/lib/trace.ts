import type { TraceEvent } from '@mb/core/telemetry';

export type SessionEvent = Extract<TraceEvent, { type: 'session' }>;
export type ToolCallEvent = Extract<TraceEvent, { type: 'tool_call' }>;
export type ToolResultEvent = Extract<TraceEvent, { type: 'tool_result' }>;
export type DoneEvent = Extract<TraceEvent, { type: 'done' }>;
export type ErrorEvent = Extract<TraceEvent, { type: 'error' }>;

export interface ToolStep {
  kind: 'tool';
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  result: ToolResultEvent | null;
  /** Client time the result arrived; anchors relative countdowns such as an open circuit. */
  resultAt: number | null;
}

export interface TextItem {
  kind: 'text';
  text: string;
}

export type TimelineItem = ToolStep | TextItem;

export type RunStatus = 'streaming' | 'done' | 'error' | 'interrupted';

export interface RunState {
  id: string;
  question: string;
  scenarioId: string | null;
  status: RunStatus;
  session: SessionEvent | null;
  items: TimelineItem[];
  done: DoneEvent | null;
  error: ErrorEvent | null;
  /** Transport failure (network, timeout) rather than a server-sent error event. */
  clientError: string | null;
  /** Client time the error event arrived; anchors the retry countdown. */
  errorAt: number | null;
}

export function newRun(id: string, question: string, scenarioId: string | null): RunState {
  return {
    id,
    question,
    scenarioId,
    status: 'streaming',
    session: null,
    items: [],
    done: null,
    error: null,
    clientError: null,
    errorAt: null,
  };
}

/** Pure reducer: folds one TraceEvent into the run's timeline. */
export function applyEvent(run: RunState, ev: TraceEvent, now: number): RunState {
  switch (ev.type) {
    case 'session':
      return { ...run, session: ev };
    case 'assistant_text': {
      if (ev.text === '') return run;
      const last = run.items[run.items.length - 1];
      if (last?.kind === 'text') {
        return {
          ...run,
          items: [...run.items.slice(0, -1), { kind: 'text', text: last.text + ev.text }],
        };
      }
      return { ...run, items: [...run.items, { kind: 'text', text: ev.text }] };
    }
    case 'tool_call':
      return {
        ...run,
        items: [
          ...run.items,
          { kind: 'tool', callId: ev.call_id, tool: ev.tool, args: ev.args, result: null, resultAt: null },
        ],
      };
    case 'tool_result': {
      let matched = false;
      const items = run.items.map((item) => {
        if (item.kind === 'tool' && item.callId === ev.call_id && !matched) {
          matched = true;
          return { ...item, result: ev, resultAt: now };
        }
        return item;
      });
      if (!matched) {
        // Result without a preceding call (e.g. a trimmed replay): still show it.
        items.push({ kind: 'tool', callId: ev.call_id, tool: ev.tool, args: {}, result: ev, resultAt: now });
      }
      return { ...run, items };
    }
    case 'done':
      return { ...run, done: ev, status: 'done' };
    case 'error':
      return { ...run, error: ev, errorAt: now, status: 'error' };
  }
}

/** Called when the stream closes: a run that never got `done` or `error` was interrupted. */
export function finishRun(run: RunState): RunState {
  return run.status === 'streaming' ? { ...run, status: 'interrupted' } : run;
}

export function failRun(run: RunState, message: string): RunState {
  return { ...run, status: 'interrupted', clientError: message };
}

export function toolSteps(run: RunState): ToolStep[] {
  return run.items.filter((i): i is ToolStep => i.kind === 'tool');
}
