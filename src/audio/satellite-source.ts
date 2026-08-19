// Placeholder for the Satellite1 audio source (hardware not yet integrated).
//
// Planned transport: the ESPHome native API's voice-assistant audio streaming —
// the satellite runs microWakeWord on-device and streams command PCM over the
// LAN after a wake event. Candidate library: `esphome-client` (npm, hjdhjd) —
// TypeScript, zero-dep, Noise encryption, explicit voice-assistant audio
// support; requires ESPHome ≥ 2025.10 firmware.
//
// Contract this class must fulfil when built:
// - one instance per satellite, `id` matching a key in the `satellites:` config
//   map (which provides the origin area for room-local scoping);
// - emit a wake event (T0), then yield PCM16 mono frames resampled to 24 kHz
//   (the satellite captures at 16 kHz — a live 2:3 resample is required);
// - end the frame iterator on stop() (server VAD end-of-speech) or on the
//   satellite's own end-of-utterance signal.
import type { AudioSource } from './source.js';

export class SatelliteAudioSource implements AudioSource {
  readonly kind = 'satellite' as const;

  constructor(readonly id: string) {}

  frames(): AsyncIterable<Buffer> {
    throw new Error('Satellite1 audio source is not implemented yet (hardware milestone M8)');
  }

  stop(): void {
    // Nothing to stop yet.
  }
}
