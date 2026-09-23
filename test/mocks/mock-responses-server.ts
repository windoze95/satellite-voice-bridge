// In-process OpenAI Responses API mock for the delegation path. Speaks the same
// shape src/realtime/delegate.ts parses: an `output` array of function_call and
// message items, plus usage.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockResponsesOptions {
  /** control_device calls to return, in order. */
  calls: Array<{ name: string; arguments: string }>;
  text?: string;
  status?: string;
  /** Respond with this HTTP status instead of a normal body. */
  httpStatus?: number;
  /** Delay the response by this long, to exercise the delegate timeout. */
  delayMs?: number;
  incompleteReason?: string;
}

export class MockResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private constructor(
    private readonly server: Server,
    private readonly opts: MockResponsesOptions,
  ) {}

  static start(opts: MockResponsesOptions): Promise<MockResponsesServer> {
    return new Promise((resolve) => {
      const server = createServer();
      const mock = new MockResponsesServer(server, opts);
      server.on('request', (req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += String(chunk)));
        req.on('end', () => {
          try {
            mock.requests.push(JSON.parse(body || '{}') as Record<string, unknown>);
          } catch {
            mock.requests.push({ unparseable: body });
          }
          const reply = (): void => {
            if (opts.httpStatus !== undefined && opts.httpStatus !== 200) {
              res.writeHead(opts.httpStatus, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { message: 'mock failure' } }));
              return;
            }
            const output: Array<Record<string, unknown>> = opts.calls.map((call, index) => ({
              type: 'function_call',
              name: call.name,
              call_id: `fc_${index}`,
              arguments: call.arguments,
            }));
            if (opts.text !== undefined) {
              output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: opts.text }] });
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'resp_mock',
                model: 'mock-delegate',
                status: opts.status ?? 'completed',
                incomplete_details: opts.incompleteReason ? { reason: opts.incompleteReason } : undefined,
                output,
                usage: {
                  input_tokens: 900,
                  output_tokens: 120,
                  input_tokens_details: { cached_tokens: 800 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              }),
            );
          };
          if (opts.delayMs) setTimeout(reply, opts.delayMs).unref?.();
          else reply();
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(mock));
    });
  }

  get url(): string {
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}/v1/responses`;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
