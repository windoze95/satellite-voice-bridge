// In-process OpenAI Realtime mock speaking the same raw GA wire events the
// bridge does: session flow, scripted responses (function calls / text),
// VAD simulation for audio, and fault-injection knobs.
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawUsage, SessionConfig } from '../../src/realtime/events.js';

export interface MockResponseSpec {
  /** Emit these function calls (streamed args) in one response. */
  functionCalls?: Array<{ name?: string; arguments: string }>;
  /** Emit this text (as deltas) in the response. */
  text?: string;
  usage?: RawUsage;
}

export interface MockRealtimeOptions {
  apiKey?: string;
  /** Consumed in order: one per response.create / auto-VAD response. */
  responses: MockResponseSpec[];
  /** Simulated VAD: end speech after this many PCM bytes (default 48000 ≈ 1 s). */
  speechStopAfterBytes?: number;
  transcript?: string;
  /** Reply to session.update with an error event instead of session.updated. */
  errorOnUpdate?: string;
  /** Kill the socket right after the first function_call_arguments.done. */
  closeAfterArgsDone?: boolean;
}

const DEFAULT_USAGE: RawUsage = {
  input_tokens: 700,
  output_tokens: 40,
  input_token_details: { text_tokens: 680, audio_tokens: 20, cached_tokens: 0 },
  output_token_details: { text_tokens: 40 },
};

export class MockRealtimeServer {
  readonly received: Array<Record<string, unknown>> = [];
  readonly sessions: SessionConfig[] = [];
  lastAuth: string | undefined;
  lastModel: string | undefined;
  private readonly wss: WebSocketServer;
  private responseIndex = 0;
  private itemCounter = 0;

  private constructor(
    wss: WebSocketServer,
    private readonly opts: MockRealtimeOptions,
  ) {
    this.wss = wss;
    wss.on('connection', (ws, req) => {
      this.lastAuth = req.headers.authorization;
      this.lastModel = new URL(req.url ?? '/', 'http://x').searchParams.get('model') ?? undefined;
      const state = { audioBytes: 0, speechStarted: false, speechStopped: false };
      ws.on('message', (raw) => this.onMessage(ws, state, JSON.parse(String(raw)) as Record<string, unknown>));
      this.send(ws, { type: 'session.created', session: { type: 'realtime' } });
    });
  }

  static start(opts: MockRealtimeOptions): Promise<MockRealtimeServer> {
    return new Promise((resolve) => {
      const wss: WebSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(new MockRealtimeServer(wss, opts)));
    });
  }

  get url(): string {
    const addr = this.wss.address() as AddressInfo;
    return `ws://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private send(ws: WebSocket, event: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }

  private onMessage(ws: WebSocket, state: { audioBytes: number; speechStarted: boolean; speechStopped: boolean }, msg: Record<string, unknown>): void {
    this.received.push(msg);
    switch (msg.type) {
      case 'session.update':
        this.sessions.push(msg.session as SessionConfig);
        if (this.opts.errorOnUpdate) {
          this.send(ws, { type: 'error', error: { type: 'invalid_request_error', message: this.opts.errorOnUpdate } });
        } else {
          this.send(ws, { type: 'session.updated', session: msg.session });
        }
        return;
      case 'conversation.item.create':
        this.send(ws, { type: 'conversation.item.created', item: msg.item });
        return;
      case 'response.create':
        this.emitResponse(ws);
        return;
      case 'input_audio_buffer.append': {
        state.audioBytes += Buffer.from(String(msg.audio), 'base64').length;
        if (!state.speechStarted) {
          state.speechStarted = true;
          this.send(ws, { type: 'input_audio_buffer.speech_started', audio_start_ms: 0 });
        }
        if (!state.speechStopped && state.audioBytes >= (this.opts.speechStopAfterBytes ?? 48_000)) {
          state.speechStopped = true;
          this.send(ws, { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 1000 });
          this.send(ws, { type: 'input_audio_buffer.committed', item_id: `item_${++this.itemCounter}` });
          this.send(ws, { type: 'conversation.item.added', item: { type: 'message', role: 'user' } });
          this.send(ws, {
            type: 'conversation.item.input_audio_transcription.completed',
            transcript: this.opts.transcript ?? 'mock transcript',
          });
          // create_response: true semantics — the server starts the response itself.
          this.emitResponse(ws);
        }
        return;
      }
      default:
        return;
    }
  }

  private emitResponse(ws: WebSocket): void {
    const spec = this.opts.responses[this.responseIndex++];
    if (!spec) {
      this.send(ws, { type: 'error', error: { type: 'mock', message: 'mock: no scripted response left' } });
      return;
    }
    const responseId = `resp_${this.responseIndex}`;
    this.send(ws, { type: 'response.created', response: { id: responseId } });
    const output: Array<Record<string, unknown>> = [];

    for (const [i, call] of (spec.functionCalls ?? []).entries()) {
      const callId = `call_${this.responseIndex}_${i}`;
      const name = call.name ?? 'control_device';
      this.send(ws, { type: 'response.output_item.added', response_id: responseId, output_index: i, item: { type: 'function_call', name, call_id: callId } });
      const args = call.arguments;
      const mid = Math.ceil(args.length / 2);
      this.send(ws, { type: 'response.function_call_arguments.delta', response_id: responseId, call_id: callId, delta: args.slice(0, mid) });
      this.send(ws, { type: 'response.function_call_arguments.delta', response_id: responseId, call_id: callId, delta: args.slice(mid) });
      this.send(ws, { type: 'response.function_call_arguments.done', response_id: responseId, call_id: callId, name, arguments: args });
      output.push({ type: 'function_call', name, call_id: callId, arguments: args });
      if (this.opts.closeAfterArgsDone) {
        ws.terminate();
        return;
      }
    }

    if (spec.text !== undefined) {
      const mid = Math.ceil(spec.text.length / 2);
      this.send(ws, { type: 'response.output_text.delta', response_id: responseId, delta: spec.text.slice(0, mid) });
      this.send(ws, { type: 'response.output_text.delta', response_id: responseId, delta: spec.text.slice(mid) });
      this.send(ws, { type: 'response.output_text.done', response_id: responseId, text: spec.text });
      output.push({ type: 'message', role: 'assistant' });
    }

    this.send(ws, {
      type: 'response.done',
      response: { id: responseId, status: 'completed', output, usage: spec.usage ?? DEFAULT_USAGE },
    });
  }
}
