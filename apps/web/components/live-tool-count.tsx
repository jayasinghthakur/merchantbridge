'use client';

import { STATIC_TOOLS } from '../lib/tools-fallback';
import { useStatus } from '../lib/use-status';

/**
 * The tool count reported by /api/status. Until it answers (and if it never does) the documented static count is
 * shown; `data-source` says which one is on screen.
 */
export function LiveToolCount({ testId }: { testId?: string }) {
  const status = useStatus();
  const live = status.kind === 'ready';
  return (
    <span data-testid={testId} data-source={live ? 'live' : 'static'} className="tabular-nums">
      {live ? status.status.tool_count : STATIC_TOOLS.length}
    </span>
  );
}
