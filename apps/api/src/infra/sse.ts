import type { ServerResponse } from 'node:http';
import type { TraceEvent } from '@mb/core';

/**
 * Server-sent events writer for the playground. Headers disable proxy buffering (Fly/nginx) and transforms;
 * a ':' heartbeat every 15 s keeps idle connections open through proxies.
 */
export class SseStream {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly res: ServerResponse,
    extraHeaders: Record<string, string> = {},
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...extraHeaders,
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    this.heartbeat = setInterval(() => this.comment('ping'), 15_000);
    this.heartbeat.unref();
    res.on('close', () => this.close());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: TraceEvent): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  comment(text: string): void {
    if (this.closed) return;
    this.res.write(`: ${text}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }
}
