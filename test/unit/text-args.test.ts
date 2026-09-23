import { describe, expect, it } from 'vitest';
import { parseTextArgs } from '../../src/commands/text.js';

describe('parseTextArgs', () => {
  it('keeps the utterance when no --satellite flag is given', () => {
    // Regression: `indexOf` returns -1 without the flag, and `satelliteFlag + 1`
    // then pointed at argument 0 — silently eating the utterance and turning
    // every plain `voicebridge text "..."` into a usage error.
    expect(parseTextArgs(['turn on the kitchen lights'])).toEqual({
      ok: true,
      utterance: 'turn on the kitchen lights',
      dryRun: false,
      satelliteId: undefined,
    });
  });

  it('keeps the utterance alongside --dry-run', () => {
    expect(parseTextArgs(['hit the lights', '--dry-run'])).toMatchObject({
      ok: true,
      utterance: 'hit the lights',
      dryRun: true,
    });
  });

  it('joins bare words into one utterance', () => {
    expect(parseTextArgs(['hit', 'the', 'lights'])).toMatchObject({ ok: true, utterance: 'hit the lights' });
  });

  it('consumes the satellite id without swallowing the utterance', () => {
    expect(parseTextArgs(['--satellite', 'sat-1', 'dim it a bit', '--dry-run'])).toEqual({
      ok: true,
      utterance: 'dim it a bit',
      dryRun: true,
      satelliteId: 'sat-1',
    });
  });

  it('rejects --satellite with no id', () => {
    expect(parseTextArgs(['lights on', '--satellite'])).toEqual({ ok: false });
    expect(parseTextArgs(['lights on', '--satellite', '--dry-run'])).toEqual({ ok: false });
  });

  it('rejects an empty utterance', () => {
    expect(parseTextArgs(['--dry-run'])).toEqual({ ok: false });
  });
});
