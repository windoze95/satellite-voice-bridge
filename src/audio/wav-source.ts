// WAV/AIFF/anything-ffmpeg-reads → PCM16 mono 24 kHz frames, paced at realtime
// so server VAD sees an honest stream, with a silence tail so it can close.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { AUDIO_SAMPLE_RATE } from '../realtime/session.js';
import type { AudioSource } from './source.js';

const BYTES_PER_SAMPLE = 2;

export interface WavSourceOptions {
  ffmpegPath: string;
  /** Pace frames at realtime (default true). Tests set false to run fast. */
  pace?: boolean;
  frameMs?: number;
  /** Silence appended after the file so server VAD can detect end of speech. */
  trailingSilenceMs?: number;
}

export class WavAudioSource implements AudioSource {
  readonly id = 'wav';
  readonly kind = 'wav' as const;
  private stopped = false;
  private child: ReturnType<typeof spawn> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly opts: WavSourceOptions,
  ) {}

  stop(): void {
    this.stopped = true;
    this.child?.kill('SIGKILL');
  }

  async *frames(): AsyncIterable<Buffer> {
    if (!existsSync(this.filePath)) throw new Error(`audio file not found: ${this.filePath}`);
    const frameMs = this.opts.frameMs ?? 40;
    const frameBytes = (AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE * frameMs) / 1000;
    const pace = this.opts.pace !== false;

    const child = spawn(
      this.opts.ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-i', this.filePath, '-f', 's16le', '-ac', '1', '-ar', String(AUDIO_SAMPLE_RATE), 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += String(d);
    });
    const spawnFailed = new Promise<never>((_, reject) => {
      child.on('error', (err) => reject(new Error(`could not run ffmpeg at ${this.opts.ffmpegPath}: ${err.message}`)));
    });

    const startedAt = performance.now();
    let framesSent = 0;
    const paceFrame = async (): Promise<void> => {
      framesSent++;
      if (!pace) return;
      const due = framesSent * frameMs - (performance.now() - startedAt);
      if (due > 0) await sleep(due);
    };

    let leftover: Buffer = Buffer.alloc(0);
    try {
      const stdout = child.stdout;
      if (!stdout) throw new Error('ffmpeg produced no output stream');
      const iterator = stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      while (!this.stopped) {
        const next = await Promise.race([iterator.next(), spawnFailed]);
        if (next.done) break;
        leftover = leftover.length === 0 ? next.value : Buffer.concat([leftover, next.value]);
        while (leftover.length >= frameBytes && !this.stopped) {
          const frame = leftover.subarray(0, frameBytes);
          leftover = leftover.subarray(frameBytes);
          await paceFrame();
          if (this.stopped) return;
          yield frame;
        }
      }
      if (this.stopped) return;
      if (leftover.length > 0) {
        const padded = Buffer.alloc(frameBytes);
        leftover.copy(padded);
        await paceFrame();
        yield padded;
      }

      const exitCode: number | null = child.exitCode;
      if (exitCode !== null && exitCode !== 0) {
        throw new Error(`ffmpeg failed (exit ${exitCode}): ${stderr.trim() || 'unknown error'}`);
      }

      const silenceFrames = Math.ceil((this.opts.trailingSilenceMs ?? 1500) / frameMs);
      const silence = Buffer.alloc(frameBytes);
      for (let i = 0; i < silenceFrames && !this.stopped; i++) {
        await paceFrame();
        if (this.stopped) return;
        yield silence;
      }
    } finally {
      this.stop();
    }
  }
}
