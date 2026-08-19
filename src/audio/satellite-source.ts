import { Pcm16Le16kTo24kResampler } from './resample.js';
import type { AudioSource } from './source.js';

const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export interface SatelliteAudioSourceOptions {
  /** Called once when OpenAI VAD first detects speech. */
  onSpeechStarted?: () => void;
  /** Called once when OpenAI VAD (or pipeline cleanup) tells the satellite to stop its microphone. */
  onStop?: () => void;
  /** Bounds audio buffered while the OpenAI Realtime session is becoming usable. */
  maxBufferedBytes?: number;
}

/**
 * One Satellite1 utterance. ESPHome pushes PCM16LE mono at 16 kHz into this
 * queue while the pipeline consumes PCM16LE mono at OpenAI's 24 kHz rate.
 */
export class SatelliteAudioSource implements AudioSource {
  readonly kind = 'satellite' as const;

  private readonly resampler = new Pcm16Le16kTo24kResampler();
  private readonly queue: Buffer[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly maxBufferedBytes: number;
  private bufferedBytes = 0;
  private ended = false;
  private stopped = false;
  private failure: Error | null = null;
  private consumerStarted = false;
  private speechHasStarted = false;

  constructor(
    readonly id: string,
    private readonly opts: SatelliteAudioSourceOptions = {},
  ) {
    this.maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  /** Push a native Satellite1 audio packet (PCM16LE mono, 16 kHz). */
  push(chunk: Buffer): void {
    if (this.ended || this.stopped || chunk.length === 0) return;
    const converted = this.resampler.push(chunk);
    if (converted.length > 0) this.enqueue(converted);
  }

  /** Mark the ESPHome audio stream complete and flush the resampler tail. */
  end(): void {
    if (this.ended || this.stopped) return;
    try {
      const tail = this.resampler.end();
      if (tail.length > 0) this.enqueue(tail);
      this.ended = true;
      this.wakeWaiters();
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Fail the utterance immediately (disconnect, cancellation, overflow). */
  fail(error: Error): void {
    if (this.ended || this.stopped) return;
    this.failure = error;
    this.ended = true;
    this.queue.length = 0;
    this.bufferedBytes = 0;
    this.resampler.reset();
    this.wakeWaiters();
  }

  async *frames(): AsyncIterable<Buffer> {
    if (this.consumerStarted) throw new Error(`Satellite audio source ${this.id} can only be consumed once`);
    this.consumerStarted = true;

    while (true) {
      const frame = this.queue.shift();
      if (frame) {
        this.bufferedBytes -= frame.length;
        yield frame;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended || this.stopped) return;
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** Advance the Satellite UI from waiting-for-command to listening. */
  speechStarted(): void {
    if (this.speechHasStarted || this.stopped) return;
    this.speechHasStarted = true;
    this.opts.onSpeechStarted?.();
  }

  /**
   * OpenAI VAD calls this as soon as it sees end-of-speech. Closing the queue
   * prevents already-buffered post-speech audio from being appended afterward.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.bufferedBytes = 0;
    this.resampler.reset();
    this.wakeWaiters();
    this.opts.onStop?.();
  }

  private enqueue(frame: Buffer): void {
    if (this.bufferedBytes + frame.length > this.maxBufferedBytes) {
      this.fail(new Error(`Satellite audio buffer exceeded ${this.maxBufferedBytes} bytes`));
      return;
    }
    this.queue.push(frame);
    this.bufferedBytes += frame.length;
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}
