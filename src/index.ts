#!/usr/bin/env node
// voicebridge CLI: run | text | say | doctor

const USAGE = `voicebridge — Satellite1 → OpenAI Realtime → Home Assistant

Usage:
  voicebridge run                      Start the always-on bridge service
  voicebridge text "<utterance>"       Send a text command through the full loop
  voicebridge say <file.wav>           Stream a WAV file through the audio loop
  voicebridge doctor                   Check every dependency (✓/✗)

Common flags:
  --dry-run          Resolve and log, but do not call Home Assistant (text/say)
  --print-context    Print the generated house context (doctor)
`;

try {
  process.loadEnvFile();
} catch {
  // No .env in cwd — fine; env vars may come from the environment (launchd).
}

const [, , command, ...rest] = process.argv;

async function main(): Promise<number> {
  switch (command) {
    case 'run':
      return (await import('./commands/run.js')).run(rest);
    case 'text':
      return (await import('./commands/text.js')).text(rest);
    case 'say':
      return (await import('./commands/say.js')).say(rest);
    case 'doctor':
      return (await import('./commands/doctor.js')).doctor(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return command === undefined ? 1 : 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
