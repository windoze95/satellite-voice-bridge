// Session lifecycle: per_utterance (fresh socket per command) or warm (one
// configured session kept open, recycled before OpenAI's 60-minute cap).
import type { Logger } from '../logger.js';
import { RealtimeClient } from './client.js';
import type { AudioInputConfig, SessionConfig } from './events.js';
import { CONTROL_DEVICE_TOOL } from './tools.js';

export const AUDIO_SAMPLE_RATE = 24_000;
/** Recycle warm sessions before the hard 60-minute session cap. */
const DEFAULT_MAX_AGE_MS = 55 * 60 * 1000;

export function buildSessionConfig(opts: { instructions: string; audio: boolean; transcribe: boolean }): SessionConfig {
  const audioInput: AudioInputConfig = {
    format: { type: 'audio/pcm', rate: AUDIO_SAMPLE_RATE },
    transcription: opts.transcribe ? { model: 'gpt-4o-mini-transcribe' } : null,
    // Defaults are unpublished — set every field explicitly. silence_duration_ms
    // adds directly to speech→action latency; tune from telemetry.
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 200,
      create_response: true,
      interrupt_response: false,
    },
  };
  return {
    type: 'realtime',
    output_modalities: ['text'],
    instructions: opts.instructions,
    tools: [CONTROL_DEVICE_TOOL],
    tool_choice: 'auto',
    max_output_tokens: 500,
    ...(opts.audio ? { audio: { input: audioInput } } : {}),
  };
}

export interface SessionManagerOptions {
  mode: 'per_utterance' | 'warm';
  url: string;
  apiKey: string;
  model: string;
  transcribe: boolean;
  logger: Logger;
  maxAgeMs?: number;
}

export interface AcquiredSession {
  client: RealtimeClient;
  reused: boolean;
}

export class SessionManager {
  private warmClient: RealtimeClient | null = null;
  private warmInstructions: string | null = null;
  private warmAudio = false;

  constructor(private readonly opts: SessionManagerOptions) {}

  get mode(): 'per_utterance' | 'warm' {
    return this.opts.mode;
  }

  /** Returns a connected, configured client ready for a command. */
  async acquire(instructions: string, audio: boolean): Promise<AcquiredSession> {
    if (this.opts.mode === 'warm') {
      const existing = this.usableWarmClient();
      if (existing) {
        if (this.warmInstructions !== instructions || this.warmAudio !== audio) {
          await existing.updateSession(buildSessionConfig({ instructions, audio, transcribe: this.opts.transcribe }));
          this.warmInstructions = instructions;
          this.warmAudio = audio;
        }
        return { client: existing, reused: true };
      }
    }
    const client = await RealtimeClient.connect({
      url: this.opts.url,
      apiKey: this.opts.apiKey,
      model: this.opts.model,
      logger: this.opts.logger,
    });
    await client.updateSession(buildSessionConfig({ instructions, audio, transcribe: this.opts.transcribe }));
    if (this.opts.mode === 'warm') {
      this.warmClient = client;
      this.warmInstructions = instructions;
      this.warmAudio = audio;
    }
    return { client, reused: false };
  }

  /** Per-utterance sessions close here; warm sessions survive unless failed. */
  release(client: RealtimeClient, opts: { failed?: boolean } = {}): void {
    if (this.opts.mode === 'per_utterance' || client !== this.warmClient) {
      client.close();
      return;
    }
    if (opts.failed || !client.isOpen) {
      this.opts.logger.info('realtime: recycling warm session', { failed: opts.failed ?? false });
      this.dropWarm();
    }
  }

  /** Warm mode: open and configure ahead of the first command. */
  async prewarm(instructions: string, audio: boolean): Promise<void> {
    if (this.opts.mode !== 'warm') return;
    if (this.usableWarmClient()) return;
    await this.acquire(instructions, audio);
    this.opts.logger.info('realtime: warm session ready', { model: this.opts.model });
  }

  /** Registry changed: refresh a live warm session's instructions in place. */
  async updateInstructions(instructions: string): Promise<void> {
    const client = this.usableWarmClient();
    if (!client || this.warmInstructions === instructions) return;
    await client.updateSession(buildSessionConfig({ instructions, audio: this.warmAudio, transcribe: this.opts.transcribe }));
    this.warmInstructions = instructions;
  }

  close(): void {
    this.dropWarm();
  }

  private usableWarmClient(): RealtimeClient | null {
    const client = this.warmClient;
    if (!client) return null;
    const maxAge = this.opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (!client.isOpen || Date.now() - client.connectedAt > maxAge) {
      this.dropWarm();
      return null;
    }
    return client;
  }

  private dropWarm(): void {
    this.warmClient?.close();
    this.warmClient = null;
    this.warmInstructions = null;
  }
}
