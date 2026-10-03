'use client';

import type { StatusResponse } from '@mb/core/http';
import { useEffect, useState } from 'react';
import { describeApiError, getStatus } from './api';

export type StatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: StatusResponse }
  | { kind: 'error'; message: string };

// One /api/status request per page load, shared by every component that needs it.
let inflight: Promise<StatusResponse> | null = null;

function loadStatus(): Promise<StatusResponse> {
  inflight ??= getStatus().catch((e: unknown) => {
    inflight = null;
    throw e;
  });
  return inflight;
}

export function useStatus(): StatusState {
  const [state, setState] = useState<StatusState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    loadStatus().then(
      (status) => {
        if (live) setState({ kind: 'ready', status });
      },
      (e: unknown) => {
        if (live) setState({ kind: 'error', message: describeApiError(e) });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
