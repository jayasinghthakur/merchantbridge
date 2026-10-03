import Link from 'next/link';
import { buttonClass } from '../components/ui';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 text-center sm:px-6">
      <p className="font-mono text-sm text-ink-subtle">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">This page does not exist</h1>
      <p className="mt-2 text-ink-muted">
        The connector only has a handful of pages; try one of these.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link className={buttonClass('primary')} href="/playground">
          Open the playground
        </Link>
        <Link className={buttonClass('secondary')} href="/">
          Home
        </Link>
      </div>
    </div>
  );
}
