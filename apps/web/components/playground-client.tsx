'use client';

import type { Scenario } from '@mb/core/scenarios';
import { SCENARIOS } from '@mb/core/scenarios';
import type { DemoFault, PlaygroundRequest } from '@mb/core/telemetry';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeApiError, isApiError, streamPlayground } from '../lib/api';
import { MAX_MESSAGE_CHARS } from '../lib/config';
import { getTabSessionId } from '../lib/session';
import type { RunState } from '../lib/trace';
import { applyEvent, failRun, finishRun, newRun } from '../lib/trace';
import { useStatus } from '../lib/use-status';
import { Countdown } from './countdown';
import { FaultToggles } from './fault-toggles';
import { SendIcon, StopIcon } from './icons';
import { ScenarioCards } from './scenario-cards';
import { TracePane } from './trace-pane';
import { Turnstile } from './turnstile';
import { buttonClass, Notice } from './ui';

const MAX_RUNS = 8;

export function PlaygroundClient() {
  const status = useStatus();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [faults, setFaults] = useState<DemoFault[]>([]);
  const [input, setInput] = useState('');
  const [runs, setRuns] = useState<RunState[]>([]);
  const [running, setRunning] = useState(false);
  const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const verifiedRef = useRef(false);
  const [turnstileKey, setTurnstileKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const runSeq = useRef(0);

  useEffect(() => {
    setSessionId(getTabSessionId());
    return () => controller.current?.abort();
  }, []);

  const siteKey = status.kind === 'ready' ? status.status.turnstile_site_key : null;
  // When the API says the model is off, every POST would be a 503 PLAYGROUND_DISABLED: keep the controls inert
  // and point to the Tools explorer, which runs the same tools without a model.
  const playgroundOff = status.kind === 'ready' && !status.status.playground_enabled;
  const needsTurnstile = siteKey !== null && !verified;
  const blocked = blockedUntil !== null;

  useEffect(() => {
    if (blockedUntil === null) return;
    const t = setTimeout(() => setBlockedUntil(null), Math.max(0, blockedUntil - Date.now()));
    return () => clearTimeout(t);
  }, [blockedUntil]);

  const updateRun = useCallback((id: string, fn: (r: RunState) => RunState) => {
    setRuns((rs) => rs.map((r) => (r.id === id ? fn(r) : r)));
  }, []);

  const send = useCallback(
    async (message: string, scenario: Scenario | null, onStart?: () => void) => {
      const text = message.trim().slice(0, MAX_MESSAGE_CHARS);
      if (!text || running || blocked || !sessionId || playgroundOff) return;
      if (needsTurnstile && !turnstileToken) {
        setNotice('Complete the human check below the question box first.');
        return;
      }
      setNotice(null);
      onStart?.();
      runSeq.current += 1;
      const id = `run-${runSeq.current}`;
      setRuns((rs) => [...rs, newRun(id, text, scenario?.id ?? null)].slice(-MAX_RUNS));
      setRunning(true);
      // On narrow screens the trace sits below the controls; bring it into view so the run is visible.
      const trace = traceRef.current;
      if (trace && trace.getBoundingClientRect().top > window.innerHeight * 0.6) {
        trace.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      const ac = new AbortController();
      controller.current = ac;

      const req: PlaygroundRequest = {
        message: text,
        session_id: sessionId,
        faults,
        ...(scenario ? { scenario_id: scenario.id } : {}),
        // Turnstile tokens are single-use; the API marks the session verified after the first message.
        ...(needsTurnstile && turnstileToken ? { turnstile_token: turnstileToken } : {}),
      };

      try {
        await streamPlayground(req, {
          signal: ac.signal,
          onEvent: (ev) => {
            if (ev.type === 'session') {
              verifiedRef.current = true;
              setVerified(true);
            }
            if (ev.type === 'error' && ev.code === 'RATE_LIMITED') {
              setBlockedUntil(Date.now() + (ev.retry_after_s ?? 60) * 1000);
            }
            updateRun(id, (r) => applyEvent(r, ev, Date.now()));
          },
        });
        updateRun(id, finishRun);
      } catch (e) {
        const message =
          isApiError(e) && e.kind === 'aborted'
            ? 'Stopped before the agent finished.'
            : describeApiError(e);
        updateRun(id, (r) => failRun(r, message));
      } finally {
        if (controller.current === ac) controller.current = null;
        setRunning(false);
        if (needsTurnstile) {
          // The token was consumed; if the session is still unverified, show a fresh widget.
          setTurnstileToken(null);
          if (!verifiedRef.current) setTurnstileKey((k) => k + 1);
        }
      }
    },
    [running, blocked, sessionId, playgroundOff, needsTurnstile, turnstileToken, faults, updateRun],
  );

  const disabled = running || blocked || !sessionId || playgroundOff;
  const activeScenario = running ? (runs[runs.length - 1]?.scenarioId ?? null) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0 space-y-5">
        {playgroundOff ? (
          <Notice
            tone="warn"
            title="Live agent paused"
            testId="playground-off"
            action={
              <Link href="/tools" className={buttonClass('secondary', 'sm')}>
                Open the Tools explorer
              </Link>
            }
          >
            This deployment is not running the model right now (no API key, the spend cap or the
            kill switch), so the scenarios are off. The Tools explorer calls the same MCP tools on
            the same demo data without a model, fault toggles included.
          </Notice>
        ) : null}
        {status.kind === 'error' ? (
          <Notice tone="warn" title="API status unavailable">
            {status.message} You can still try a scenario.
          </Notice>
        ) : null}

        <div>
          <h2 className="mb-2 text-sm font-bold text-ink">Scenarios</h2>
          <ScenarioCards
            scenarios={SCENARIOS}
            disabled={disabled}
            activeId={activeScenario}
            onPick={(s) => void send(s.prompt, s)}
          />
        </div>

        <form
          className="mb-card p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input, null, () => setInput(''));
          }}
        >
          <label htmlFor="pg-question" className="text-sm font-bold text-ink">
            Ask your own question
          </label>
          <textarea
            id="pg-question"
            value={input}
            maxLength={MAX_MESSAGE_CHARS}
            rows={3}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Which items are low on stock in Bengaluru?"
            disabled={playgroundOff}
            aria-describedby="pg-question-hint"
            className="mb-input mt-2 resize-y"
          />
          <div className="mt-1 flex items-center justify-between gap-2 text-xs text-ink-subtle">
            <span id="pg-question-hint">Enter to send, Shift+Enter for a new line</span>
            <span aria-live="polite">
              {input.length}/{MAX_MESSAGE_CHARS}
            </span>
          </div>
          {siteKey && !verified ? (
            <div className="mt-3">
              <Turnstile key={turnstileKey} siteKey={siteKey} onToken={setTurnstileToken} />
            </div>
          ) : null}
          {notice ? (
            <p className="mt-2 text-sm text-danger" role="alert">
              {notice}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {running ? (
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => controller.current?.abort()}
              >
                <StopIcon size={15} />
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={buttonClass('primary')}
                disabled={disabled || input.trim() === ''}
              >
                <SendIcon size={15} />
                Ask
              </button>
            )}
            {blockedUntil !== null ? (
              <span className="text-xs text-ink-muted">
                <Countdown untilMs={blockedUntil}>
                  {(s) => (s > 0 ? `Rate limited: ${s}s` : '')}
                </Countdown>
              </span>
            ) : null}
          </div>
        </form>

        <FaultToggles value={faults} onChange={setFaults} disabled={running || playgroundOff} />
      </div>

      <div ref={traceRef} className="min-w-0 scroll-mt-28 lg:sticky lg:top-[4.5rem]">
        <TracePane
          runs={runs}
          paused={playgroundOff}
          onClear={runs.length > 0 && !running ? () => setRuns([]) : null}
        />
      </div>
    </div>
  );
}
