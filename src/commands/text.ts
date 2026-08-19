// voicebridge text "<utterance>" [--dry-run] — full loop from typed text.
import { runCommand } from '../pipeline.js';
import { summaryLine } from '../telemetry.js';
import { AppError, createApp, shutdownApp, type App } from './app.js';

export async function text(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const utterance = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!utterance) {
    console.error('usage: voicebridge text "<utterance>" [--dry-run]');
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
    const rec = await runCommand(app, { kind: 'text', utterance }, { dryRun });
    console.log(summaryLine(rec));
    return rec.ok ? 0 : 1;
  } finally {
    shutdownApp(app);
  }
}
