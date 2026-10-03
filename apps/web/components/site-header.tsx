'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoMark } from './icons';
import { ThemeToggle } from './theme-toggle';

const NAV = [
  { href: '/playground', label: 'Playground' },
  { href: '/tools', label: 'Tools' },
  { href: '/docs', label: 'Docs' },
  { href: '/connect', label: 'Connect' },
] as const;

function NavLinks({ pathname, className }: { pathname: string; className: string }) {
  return (
    <ul className={className}>
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex h-9 items-center rounded-sm px-2.5 text-sm font-semibold transition-colors sm:px-3 ${
                active ? 'bg-brand-soft text-brand-ink' : 'text-ink-muted hover:bg-sunken hover:text-ink'
              }`}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function SiteHeader() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:bg-raised focus:px-3 focus:py-2 focus:text-sm focus:font-semibold"
      >
        Skip to content
      </a>
      <nav aria-label="Main" className="mx-auto flex max-w-6xl flex-col px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between gap-3">
          <Link href="/" className="flex items-center gap-2 rounded-sm font-bold tracking-tight text-ink">
            <LogoMark />
            <span>MerchantBridge</span>
          </Link>
          <div className="flex items-center gap-1">
            <NavLinks pathname={pathname} className="hidden items-center gap-1 md:flex" />
            <span className="mx-1 hidden h-5 w-px bg-line md:block" aria-hidden="true" />
            <ThemeToggle />
          </div>
        </div>
        <NavLinks
          pathname={pathname}
          className="-mx-1 flex items-center gap-0.5 overflow-x-auto pb-2 md:hidden"
        />
      </nav>
    </header>
  );
}
