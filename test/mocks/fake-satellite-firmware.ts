// A model of the Satellite's own voice-assistant state machine.
//
// Transcribed from esphome/components/voice_assistant/voice_assistant.cpp as
// built into the running firmware (on_event + loop). A mock that only records
// the events we send cannot catch sending them in an order the device cannot
// survive — which is exactly how a stranded device shipped. This one can.
export type FirmwareState =
  | 'IDLE'
  | 'START_PIPELINE'
  | 'STARTING_PIPELINE'
  | 'STREAMING_MICROPHONE'
  | 'STOP_MICROPHONE'
  | 'STOPPING_MICROPHONE'
  | 'AWAITING_RESPONSE';

const EVENT = {
  ERROR: 0,
  RUN_START: 1,
  RUN_END: 2,
  STT_START: 3,
  STT_END: 4,
  INTENT_START: 5,
  INTENT_END: 6,
  STT_VAD_START: 11,
  STT_VAD_END: 12,
} as const;

export class FakeSatelliteFirmware {
  state: FirmwareState = 'IDLE';
  private desired: FirmwareState = 'IDLE';
  private micRunning = false;
  readonly history: FirmwareState[] = ['IDLE'];
  private pump: NodeJS.Timeout | null = null;

  /** The wake word fired: the device is streaming before the server says anything. */
  wake(): void {
    this.micRunning = true;
    this.enter('STREAMING_MICROPHONE');
    this.schedule();
  }

  /**
   * Apply one server event. Deliberately does NOT run the device loop: events
   * the bridge sends in one synchronous burst reach the firmware before it can
   * advance, which is the whole reason ordering matters here.
   */
  onEvent(eventType: number): void {
    switch (eventType) {
      // Triggers only — no state change. Safe at any point in a run.
      case EVENT.RUN_START:
      case EVENT.STT_START:
      case EVENT.STT_VAD_START:
      case EVENT.STT_END:
      case EVENT.INTENT_START:
      case EVENT.INTENT_END:
        break;
      case EVENT.STT_VAD_END:
        this.enter('STOP_MICROPHONE', 'AWAITING_RESPONSE');
        break;
      case EVENT.RUN_END:
        if (this.state === 'START_PIPELINE' || this.state === 'STARTING_PIPELINE' || this.state === 'STREAMING_MICROPHONE') {
          this.enter('STOP_MICROPHONE', 'IDLE');
        } else if (this.state === 'AWAITING_RESPONSE') {
          this.enter('IDLE', 'IDLE');
        }
        // Any other state — notably STOP_MICROPHONE / STOPPING_MICROPHONE —
        // matches nothing, and the device is left where it stands.
        break;
      case EVENT.ERROR:
        if (this.state !== 'IDLE') this.enter('STOP_MICROPHONE', 'IDLE');
        break;
      default:
        break;
    }
    this.schedule();
  }

  /** One pass of the device's loop(). */
  tick(): void {
    if (this.state === 'STOP_MICROPHONE') {
      if (this.micRunning) {
        this.micRunning = false;
        this.enter('STOPPING_MICROPHONE');
      } else {
        this.enter(this.desired);
      }
    } else if (this.state === 'STOPPING_MICROPHONE') {
      this.enter(this.desired);
    }
  }

  /**
   * Parked mid-run with nothing left to arrive. With no speaker there is no TTS
   * event to move it on, so this is terminal until someone reboots the device —
   * the blinking-LED state.
   */
  get stranded(): boolean {
    return this.state === 'AWAITING_RESPONSE';
  }

  get listening(): boolean {
    return this.state === 'STREAMING_MICROPHONE';
  }

  stop(): void {
    if (this.pump) clearTimeout(this.pump);
    this.pump = null;
  }

  /** The device's loop runs between bursts, not within one. */
  private schedule(): void {
    if (this.pump) return;
    this.pump = setTimeout(() => {
      this.pump = null;
      this.tick();
      this.tick();
    }, 0);
    this.pump.unref?.();
  }

  private enter(state: FirmwareState, desired?: FirmwareState): void {
    this.state = state;
    if (desired !== undefined) this.desired = desired;
    if (this.history[this.history.length - 1] !== state) this.history.push(state);
  }
}
