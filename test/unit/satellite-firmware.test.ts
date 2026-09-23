import { describe, expect, it } from 'vitest';
import { FakeSatelliteFirmware } from '../mocks/fake-satellite-firmware.js';

const RUN_END = 2;
const STT_END = 4;
const INTENT_START = 5;
const INTENT_END = 6;
const STT_VAD_START = 11;
const STT_VAD_END = 12;

/**
 * These pin the firmware behaviour the bridge steers. They exist because the
 * previous mock recorded events without modelling them, so a sequence that
 * stranded a real Satellite passed its tests.
 */
describe('Satellite firmware state machine', () => {
  it('strands when RUN_END follows STT_VAD_END with no time in between', () => {
    const fw = new FakeSatelliteFirmware();
    fw.wake();
    expect(fw.listening).toBe(true);

    // The shipped bug, exactly: both events in one burst. STT_VAD_END starts
    // the microphone stopping; RUN_END then matches no case and does nothing.
    fw.onEvent(STT_VAD_END);
    fw.onEvent(RUN_END);
    fw.tick();
    fw.tick();

    expect(fw.stranded).toBe(true);
    expect(fw.state).toBe('AWAITING_RESPONSE');
  });

  it('recovers when a second RUN_END arrives after it has settled', () => {
    const fw = new FakeSatelliteFirmware();
    fw.wake();
    fw.onEvent(STT_VAD_END);
    fw.onEvent(RUN_END);
    fw.tick();
    fw.tick();
    expect(fw.stranded).toBe(true);

    // The rescue: once settled in AWAITING_RESPONSE, RUN_END returns it to idle.
    fw.onEvent(RUN_END);
    fw.tick();
    expect(fw.state).toBe('IDLE');
  });

  it('closes cleanly when RUN_END arrives while still streaming', () => {
    const fw = new FakeSatelliteFirmware();
    fw.wake();
    // No STT_VAD_END at all — the follow-up case. RUN_END from
    // STREAMING_MICROPHONE both stops the microphone and goes idle.
    fw.onEvent(RUN_END);
    fw.tick();
    fw.tick();
    expect(fw.state).toBe('IDLE');
  });

  it('closes cleanly when the device had time to settle first', () => {
    const fw = new FakeSatelliteFirmware();
    fw.wake();
    fw.onEvent(STT_VAD_END);
    fw.tick();
    fw.tick();
    expect(fw.state).toBe('AWAITING_RESPONSE');

    // The long-standing single-utterance path: a real gap while the command
    // runs, then RUN_END finds it settled.
    fw.onEvent(RUN_END);
    fw.tick();
    expect(fw.state).toBe('IDLE');
  });

  it('treats mid-run reporting events as triggers that change nothing', () => {
    const fw = new FakeSatelliteFirmware();
    fw.wake();
    for (const event of [STT_VAD_START, STT_END, INTENT_START, INTENT_END]) fw.onEvent(event);
    fw.tick();
    // Safe to narrate a turn to the device without closing its microphone,
    // which is what makes a follow-up chain possible at all.
    expect(fw.listening).toBe(true);
  });
});
