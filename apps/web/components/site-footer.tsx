import Link from 'next/link';
import { REPO_URL } from '../lib/config';

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm text-ink-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p data-testid="not-affiliated">Independent take-home project. Not affiliated with Razorpay or Zoho.</p>
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          <li>
            <Link className="hover:text-ink" href="/playground">
              Playground
            </Link>
          </li>
          <li>
            <Link className="hover:text-ink" href="/tools">
              Tools
            </Link>
          </li>
          <li>
            <Link className="hover:text-ink" href="/docs">
              Docs
            </Link>
          </li>
          <li>
            <Link className="hover:text-ink" href="/connect">
              Connect
            </Link>
          </li>
          {REPO_URL ? (
            <li>
              <a className="hover:text-ink" href={REPO_URL} rel="noopener noreferrer" target="_blank">
                Source
              </a>
            </li>
          ) : null}
        </ul>
      </div>
    </footer>
  );
}
