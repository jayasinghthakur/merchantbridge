import type { StatusResponse, ToolsResponse } from '@mb/core/http';
import { API_ROUTES } from '@mb/core/http';
import type { Page, Response } from '@playwright/test';
import { test as base, expect } from '@playwright/test';

/** Everything the browser reported as broken while a test ran. Each list must be empty when the test ends. */
export interface BrowserProblems {
  /** console.error output, including Chromium's "Failed to load resource" and CORS messages. */
  consoleErrors: string[];
  /** Uncaught exceptions in the page. */
  pageErrors: string[];
  /** Requests that never got a response (CORS block, DNS, connection refused). Aborts are logged, not failed. */
  failedRequests: string[];
  /** Responses with status >= 400. */
  httpErrors: string[];
}

function describeResponse(r: Response): string {
  return `${r.status()} ${r.request().method()} ${r.url()}`;
}

/**
 * `test` with an automatic browser guard: a console error, page error, failed request or HTTP error during any
 * test fails that test. Cancelled requests (net::ERR_ABORTED, e.g. a fetch aborted on unmount or a prefetch dropped
 * by navigation) are attached to the report for inspection but are not failures.
 */
export const test = base.extend<{ problems: BrowserProblems }>({
  problems: [
    async ({ page }, use, testInfo) => {
      const problems: BrowserProblems = {
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        httpErrors: [],
      };
      const notes: string[] = [];
      page.on('console', (msg) => {
        const where = msg.location().url;
        if (msg.type() === 'error')
          problems.consoleErrors.push(`${msg.text()}${where ? ` (${where})` : ''}`);
        else if (msg.type() === 'warning') notes.push(`console warning: ${msg.text()}`);
      });
      page.on('pageerror', (err) => problems.pageErrors.push(`${err.name}: ${err.message}`));
      page.on('requestfailed', (req) => {
        const reason = req.failure()?.errorText ?? 'unknown';
        const line = `${req.method()} ${req.url()}: ${reason}`;
        if (reason === 'net::ERR_ABORTED') notes.push(`aborted: ${line}`);
        else problems.failedRequests.push(line);
      });
      page.on('response', (r) => {
        if (r.status() >= 400) problems.httpErrors.push(describeResponse(r));
      });

      await use(problems);

      if (notes.length > 0) {
        await testInfo.attach('browser-notes.txt', {
          body: notes.join('\n'),
          contentType: 'text/plain',
        });
      }
      expect(problems, 'the browser reported errors or failed requests during this test').toEqual({
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        httpErrors: [],
      });
    },
    { auto: true },
  ],
});

export { expect };

/** What the page fetched from the real API, plus the API base URL the deployed bundle was built against. */
export interface Observed<T> {
  body: T;
  apiBase: string;
}

function apiBaseOf(url: string, route: string): string {
  const u = new URL(url);
  const path = u.pathname.endsWith(route) ? u.pathname.slice(0, -route.length) : u.pathname;
  return `${u.origin}${path}`.replace(/\/+$/, '');
}

async function observe<T>(
  page: Page,
  route: string,
  action: () => Promise<unknown>,
): Promise<Observed<T>> {
  const pending = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(route),
  );
  await action();
  const res = await pending;
  expect(res.status(), `${route} answered ${res.status()}`).toBe(200);
  return { body: (await res.json()) as T, apiBase: apiBaseOf(res.url(), route) };
}

/** Navigates and returns the /api/status body the page itself received (not a separate request). */
export function gotoObservingStatus(page: Page, path: string): Promise<Observed<StatusResponse>> {
  return observe<StatusResponse>(page, API_ROUTES.status, () => page.goto(path));
}

/** Navigates and returns the /api/tools body the page itself received. */
export function gotoObservingTools(page: Page, path: string): Promise<Observed<ToolsResponse>> {
  return observe<ToolsResponse>(page, API_ROUTES.tools, () => page.goto(path));
}

/** Parses a Streamable HTTP response body that is either plain JSON or one SSE `message` event. */
export function parseMcpBody(contentType: string, text: string): unknown {
  if (!contentType.includes('text/event-stream')) return JSON.parse(text) as unknown;
  const data = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
  return JSON.parse(data) as unknown;
}
