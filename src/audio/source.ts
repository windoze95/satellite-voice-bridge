// The satellite seam. Anything that can produce command audio implements this:
// today a WAV file (dev/testing), later the Satellite1 over the ESPHome native
// API. Frames are PCM16 mono at the Realtime API's 24 kHz input rate.

export interface AudioSource {
  /** Stable identifier; satellite ids map to areas via the `satellites:` config. */
  readonly id: string;
  readonly kind: 'wav' | 'satellite';
  /**
   * PCM16 mono 24 kHz frames. The iterator ends when the source is exhausted
   * or stop() is called (e.g. server VAD detected end of speech).
   */
  frames(): AsyncIterable<Buffer>;
  /** Notify live sources when Realtime VAD first detects speech. */
  speechStarted?(): void;
  /** Stop producing frames; must be idempotent. */
  stop(): void;
}
