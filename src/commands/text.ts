// voicebridge text "<utterance>" [--dry-run] [--satellite <id>] — full loop
// from typed text. --satellite borrows a configured satellite's room so typed
// commands resolve "in here" the way a spoken one would.
import { runCommand } from '../pipeline.js';
import { summaryLine } from '../telemetry.js';
import { AppError, createApp, shutdownApp, type App } from './app.js';

export interface TextArgs {
  ok: true;
  utterance: string;
  dryRun: boolean;
  satelliteId: string | undefined;
}

export type ParsedTextArgs = TextArgs | { ok: false };

/** Pure arg parsing, so the utterance-eating edge cases are testable. */
export function parseTextArgs(args: string[]): ParsedTextArgs {
  const dryRun = args.includes('--dry-run');
  const satelliteFlag = args.indexOf('--satellite');
  const satelliteId = satelliteFlag >= 0 ? args[satelliteFlag + 1] : undefined;
  if (satelliteFlag >= 0 && (!satelliteId || satelliteId.startsWith('--'))) return { ok: false };

  // Skip the value that follows --satellite, and only when the flag is present:
  // with no flag, indexOf returns -1 and a naive `satelliteFlag + 1` would drop
  // argument 0 — the utterance itself.
  const satelliteValueIndex = satelliteFlag >= 0 ? satelliteFlag + 1 : -1;
  const utterance = args
    .filter((a, i) => !a.startsWith('--') && i !== satelliteValueIndex)
    .join(' ')
    .trim();
  if (!utterance) return { ok: false };
  return { ok: true, utterance, dryRun, satelliteId };
}

export async function text(args: string[]): Promise<number> {
  const parsed = parseTextArgs(args);
  if (!parsed.ok) {
    console.error('usage: voicebridge text "<utterance>" [--dry-run] [--satellite <id>]');
    return 2;
  }
  const { utterance, dryRun, satelliteId } = parsed;

  let app: App;
  try {
    app = await createApp({ retryHA: false });
  } catch (err) {
    console.error(err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err));
    return 1;
  }

  let originArea: string | undefined;
  if (satelliteId) {
    const satellite = app.cfg.satellites[satelliteId];
    if (!satellite) {
      const known = Object.keys(app.cfg.satellites).join(', ') || '(none configured)';
      console.error(`unknown satellite "${satelliteId}". Configured: ${known}`);
      shutdownApp(app);
      return 2;
    }
    if (!satellite.area) {
      console.error(`satellite "${satelliteId}" has no area configured`);
      shutdownApp(app);
      return 2;
    }
    originArea = satellite.area;
  }

  try {
    const rec = await runCommand(app, { kind: 'text', utterance, originArea }, { dryRun });
    console.log(summaryLine(rec));
    // A flourish arms a restore that outlives the command; exiting here would
    // strand the lights mid-flourish.
    await app.flourish.drain();
    return rec.ok ? 0 : 1;
  } finally {
    shutdownApp(app);
  }
}
