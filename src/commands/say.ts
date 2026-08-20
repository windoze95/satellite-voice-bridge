// voicebridge say <file.wav> [--dry-run] — stream an audio file through the
// real audio pipeline (ffmpeg → 24 kHz PCM → server VAD → function call).
import { WavAudioSource } from '../audio/wav-source.js';
import { runCommand } from '../pipeline.js';
import { summaryLine } from '../telemetry.js';
import { AppError, createApp, shutdownApp, type App } from './app.js';

export async function say(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: voicebridge say <file.wav> [--dry-run]');
    return 2;
  }

  let app: App;
  try {
    app = await createApp({ retryHA: false });
  } catch (err) {
    console.error(err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err));
    return 1;
  }

  try {
    const source = new WavAudioSource(file, { ffmpegPath: app.cfg.ffmpegPath });
    const rec = await runCommand(app, { kind: 'audio', source }, { dryRun });
    console.log(summaryLine(rec));
    // A flourish arms a restore that outlives the command; exiting here would
    // strand the lights mid-flourish.
    await app.flourish.drain();
    return rec.ok ? 0 : 1;
  } finally {
    shutdownApp(app);
  }
}
