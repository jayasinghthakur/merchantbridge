'use client';

import { useEffect, useRef, useState } from 'react';

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
      theme?: 'auto' | 'light' | 'dark';
      size?: 'normal' | 'flexible' | 'compact';
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('turnstile failed to load'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/** Cloudflare Turnstile widget; reports a fresh token (or null when it expires or fails). */
export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cb = useRef(onToken);
  cb.current = onToken;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let widgetId: string | null = null;
    let live = true;
    loadTurnstile().then(
      (api) => {
        if (!live || !box.current) return;
        widgetId = api.render(box.current, {
          sitekey: siteKey,
          theme: 'auto',
          size: 'flexible',
          callback: (t) => cb.current(t),
          'expired-callback': () => cb.current(null),
          'error-callback': () => cb.current(null),
        });
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey]);

  return (
    <div>
      <div ref={box} className="min-h-[65px]" />
      {failed ? (
        <p className="text-xs text-danger">
          The human check could not load. Disable content blockers for challenges.cloudflare.com and reload.
        </p>
      ) : null}
    </div>
  );
}
