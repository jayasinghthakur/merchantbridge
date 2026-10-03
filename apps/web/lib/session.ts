const KEY = 'mb.session_id';

function fallbackId(): string {
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `${rnd()}-${rnd()}-${rnd()}`;
}

/**
 * One demo session per browser tab (sessionStorage), so fault toggles and governor buckets (`demo:{session}`)
 * are isolated per reviewer. Falls back to an in-memory id when storage is blocked.
 */
export function getTabSessionId(): string {
  const make = () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackId();
  try {
    const existing = window.sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id = make();
    window.sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return make();
  }
}
