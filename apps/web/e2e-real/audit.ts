import type { Page } from '@playwright/test';

export interface LayoutAudit {
  /** documentElement.scrollWidth - clientWidth; > 0 means the page scrolls sideways. */
  pageOverflowPx: number;
  /** Outermost visible elements that stick out of the viewport without a clipping/scrolling ancestor. */
  overflowing: string[];
  /** Text below WCAG AA contrast (4.5:1, or 3:1 for large text) against its composited background. */
  lowContrast: string[];
}

/**
 * Runs in the page. Colors are resolved by painting them on a 1x1 canvas, so any CSS color syntax Tailwind emits
 * (hex, oklab, color-mix) is measured as the browser actually renders it. Backgrounds are alpha-composited up the
 * ancestor chain. Disabled controls and content under opacity < 1 are skipped (WCAG exempts inactive components).
 */
export function auditLayout(page: Page): Promise<LayoutAudit> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;

    function label(el: Element): string {
      const id = el.id ? `#${el.id}` : '';
      const testId = el.getAttribute('data-testid');
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `${el.tagName.toLowerCase()}${id}${testId ? `[data-testid=${testId}]` : ''}${cls} "${text}"`;
    }

    function isVisuallyHidden(cs: CSSStyleDeclaration): boolean {
      return (
        cs.visibility === 'hidden' ||
        cs.display === 'none' ||
        (cs.position === 'absolute' && (cs.clip !== 'auto' || cs.clipPath !== 'none'))
      );
    }

    // ---- overflow ----
    const hits: Element[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= vw + 0.5 && r.left >= -0.5) continue;
      const cs = getComputedStyle(el);
      if (isVisuallyHidden(cs)) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        if (getComputedStyle(a).overflowX !== 'visible') {
          clipped = true;
          break;
        }
      }
      if (!clipped) hits.push(el);
    }
    const overflowing = hits
      .filter((el) => !hits.some((other) => other !== el && other.contains(el)))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${label(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}px (viewport ${vw}px)`;
      });

    // ---- contrast ----
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    type Rgba = [number, number, number, number];
    function toRgba(css: string): Rgba {
      if (!ctx) return [0, 0, 0, 1];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 255) / 255];
    }
    function over(top: Rgba, bottom: Rgba): Rgba {
      const a = top[3] + bottom[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const ch = (i: 0 | 1 | 2) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
      return [ch(0), ch(1), ch(2), a];
    }
    function luminance(c: Rgba): number {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    }
    function hex(c: Rgba): string {
      return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
    }
    function backgroundOf(el: Element): Rgba {
      const layers: Rgba[] = [];
      for (let a: Element | null = el; a; a = a.parentElement) {
        const bg = toRgba(getComputedStyle(a).backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 1) break;
      }
      let acc: Rgba = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i] as Rgba, acc);
      return acc;
    }
    function inactive(el: Element): boolean {
      if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, [aria-disabled="true"]')) {
        return true;
      }
      for (let a: Element | null = el; a; a = a.parentElement) {
        if (Number(getComputedStyle(a).opacity) < 1) return true;
      }
      return false;
    }

    const lowContrast: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.closest('svg')) continue;
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if (!ownText) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (isVisuallyHidden(cs) || inactive(el)) continue;
      const bg = backgroundOf(el);
      const fg = over(toRgba(cs.color), bg);
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const min = large ? 3 : 4.5;
      if (ratio < min) {
        lowContrast.push(
          `${label(el)}: ${ratio.toFixed(2)}:1 < ${min}:1 (text ${hex(fg)} on ${hex(bg)}, ${size}px/${cs.fontWeight})`,
        );
      }
    }

    return {
      pageOverflowPx: document.documentElement.scrollWidth - vw,
      overflowing,
      lowContrast,
    };
  });
}
