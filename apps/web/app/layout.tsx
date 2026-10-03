import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import { SiteFooter } from '../components/site-footer';
import { SiteHeader } from '../components/site-header';
import { THEME_INIT_SCRIPT } from '../lib/theme';
import './globals.css';

const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-manrope',
  fallback: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'Arial', 'sans-serif'],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
  fallback: ['ui-monospace', 'Menlo', 'Consolas', 'monospace'],
});

export const metadata: Metadata = {
  title: {
    default: 'MerchantBridge: a private connector for Zoho Inventory',
    template: '%s · MerchantBridge',
  },
  description:
    'An Agent Studio-style private connector that lets AI agents read a merchant’s Zoho Inventory over MCP: read-only by construction, rate-governed, fully audited.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F7F6F2' },
    { media: '(prefers-color-scheme: dark)', color: '#0E1513' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh flex-col">
        <SiteHeader />
        <main id="main" className="flex-1">
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
