'use client';

import { useStatus } from '../lib/use-status';

/**
 * "Live agent: <model>" from /api/status. The playground runs whichever LLM the API is configured with (a free
 * OpenAI-compatible model by default, or Claude), so the page never hard-codes it.
 */
export function LiveModel({ className = '' }: { className?: string }) {
  const status = useStatus();
  if (status.kind !== 'ready') return null;
  const { model, playground_enabled: enabled } = status.status;
  return (
    <p className={`text-xs text-ink-subtle ${className}`} data-testid="live-model">
      Live agent: <span className="font-mono text-ink-muted">{model}</span>
      {enabled ? null : ' (paused)'}
    </p>
  );
}
