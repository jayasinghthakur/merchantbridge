'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ZohoDc } from '../lib/connect';
import { oauthStartUrl, ZOHO_DCS } from '../lib/connect';
import { useStatus } from '../lib/use-status';
import { ArrowRightIcon } from './icons';
import { buttonClass, Notice, Skeleton } from './ui';

export function ConnectForm() {
  const status = useStatus();
  const [invite, setInvite] = useState('');
  const [dc, setDc] = useState<ZohoDc>('in');
  const [error, setError] = useState<string | null>(null);

  if (status.kind === 'loading') {
    return (
      <div className="mb-card space-y-3 p-5" aria-busy="true" aria-label="Checking whether connecting is enabled">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  const disabled = status.kind === 'ready' && !status.status.connect_enabled;

  return (
    <form
      className="mb-card space-y-4 p-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invite.trim()) {
          setError('Enter your invite code.');
          return;
        }
        window.location.assign(oauthStartUrl(dc, invite));
      }}
    >
      {disabled ? (
        <Notice tone="info" title="Connecting is closed right now" testId="connect-disabled">
          New Zoho connections are switched off on this deployment. The{' '}
          <Link href="/tools" className="font-semibold text-brand-ink underline">
            Tools explorer
          </Link>{' '}
          and the public demo MCP server keep working on demo data.
        </Notice>
      ) : null}
      {status.kind === 'error' ? (
        <Notice tone="warn" title="Could not check the API">
          {status.message} You can still try; the API will reject the request if connecting is unavailable.
        </Notice>
      ) : null}
      <div>
        <label htmlFor="invite" className="text-sm font-bold">
          Invite code
        </label>
        <input
          id="invite"
          className="mb-input mt-1 font-mono"
          value={invite}
          onChange={(e) => {
            setInvite(e.target.value);
            setError(null);
          }}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby="invite-hint"
        />
        <p id="invite-hint" className={`mt-1 text-xs ${error ? 'text-danger' : 'text-ink-muted'}`}>
          {error ?? 'Real-organization access is invite-only during the preview.'}
        </p>
      </div>
      <div>
        <label htmlFor="dc" className="text-sm font-bold">
          Zoho data center
        </label>
        <select
          id="dc"
          className="mb-input mt-1"
          value={dc}
          onChange={(e) => setDc(e.target.value as ZohoDc)}
          disabled={disabled}
        >
          {ZOHO_DCS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink-muted">The region of the domain you sign in to Zoho on.</p>
      </div>
      <button type="submit" className={buttonClass('primary')} disabled={disabled}>
        Continue to Zoho
        <ArrowRightIcon size={16} />
      </button>
    </form>
  );
}
