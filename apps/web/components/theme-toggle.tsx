'use client';

import { useEffect, useState } from 'react';
import { THEME_STORAGE_KEY } from '../lib/theme';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';

type ThemePref = 'system' | 'light' | 'dark';

const ORDER: ThemePref[] = ['system', 'light', 'dark'];
const LABEL: Record<ThemePref, string> = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
}

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // storage blocked: stay on system
    }
    setPref(stored === 'light' || stored === 'dark' ? stored : 'system');
  }, []);

  const current = pref ?? 'system';
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system';
  const Icon = current === 'light' ? SunIcon : current === 'dark' ? MoonIcon : MonitorIcon;

  const onClick = () => {
    setPref(next);
    apply(next);
    try {
      if (next === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // non-persistent is fine
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${LABEL[current]}. Switch to ${LABEL[next].toLowerCase()}`}
      title={`${LABEL[current]} (click for ${LABEL[next].toLowerCase()})`}
      className="inline-flex h-9 w-9 items-center justify-center rounded-sm border border-line text-ink-muted transition-colors hover:border-brand hover:text-brand-ink"
    >
      <Icon size={17} />
    </button>
  );
}
