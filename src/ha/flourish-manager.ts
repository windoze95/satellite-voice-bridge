// Owns the "put it back" half of a flourish. Restores outlive the command that
// started them, so they live here rather than in the per-command pipeline.
import type { RotationConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { restorePlan, type LightSnapshot } from '../policy/flourish.js';
import { CommandTrace } from '../telemetry.js';
import type { HAClient } from './client.js';
import { executeAction } from './executor.js';

export interface FlourishManagerOptions {
  haClient: HAClient;
  logger: Logger;
  /** Test hook: replaces the real timer so tests need no wall-clock delay. */
  schedule?: (fn: () => void, delayMs: number) => { cancel: () => void };
}

interface PendingRun {
  snapshots: LightSnapshot[];
  cancel: () => void;
  /** Keep the event loop alive for this timer (see drain). */
  keepAlive: () => void;
  settled: Promise<void>;
  finish: () => void;
}

export class FlourishManager {
  private readonly runs = new Set<PendingRun>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly opts: FlourishManagerOptions) {}

  /**
   * Capture the current look of these lights, inheriting any snapshot a still
   * pending flourish holds for them — restoring to a previous flourish's colors
   * instead of the user's real lighting would be worse than not restoring.
   */
  snapshot(snapshotter: () => LightSnapshot[], entityIds: string[]): LightSnapshot[] {
    const inherited = new Map<string, LightSnapshot>();
    for (const run of this.runs) {
      for (const snapshot of run.snapshots) {
        if (entityIds.includes(snapshot.entityId)) inherited.set(snapshot.entityId, snapshot);
      }
    }
    this.cancelFor(entityIds);
    const fresh = snapshotter();
    return fresh.map((snapshot) => inherited.get(snapshot.entityId) ?? snapshot);
  }

  scheduleRestore(snapshots: LightSnapshot[], durationMs: number): void {
    if (snapshots.length === 0) return;
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run: PendingRun = { snapshots, cancel: () => {}, keepAlive: () => {}, settled, finish };
    const fire = (): void => {
      this.runs.delete(run);
      void this.track(this.restore(run.snapshots)).finally(() => run.finish());
    };
    if (this.opts.schedule) {
      run.cancel = this.opts.schedule(fire, durationMs).cancel;
    } else {
      const timer = setTimeout(fire, durationMs);
      // A pending restore must never be the reason a long-running service stays
      // up; drain() re-refs it when a short-lived command needs to wait.
      timer.unref?.();
      run.cancel = () => clearTimeout(timer);
      run.keepAlive = () => timer.ref?.();
    }
    this.runs.add(run);
  }

  /**
   * Walk the colour list around the lights until the flourish is up, then
   * restore. Each light holds a different colour and the assignment steps by
   * one each frame, so the rainbow travels around the room.
   */
  startRotation(
    entityIds: string[],
    rotation: RotationConfig,
    snapshots: LightSnapshot[],
    durationMs: number,
  ): void {
    if (entityIds.length === 0) return;
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run: PendingRun = { snapshots, cancel: () => {}, keepAlive: () => {}, settled, finish };

    let frame = 0;
    let stopped = false;
    const step = (): void => {
      if (stopped) return;
      frame++;
      void this.track(this.paintFrame(entityIds, rotation, frame));
    };
    const timer = setInterval(step, Math.max(150, rotation.intervalMs));
    timer.unref?.();
    const end = setTimeout(() => {
      stopped = true;
      clearInterval(timer);
      this.runs.delete(run);
      void this.track(this.restore(run.snapshots)).finally(() => run.finish());
    }, durationMs);
    end.unref?.();

    run.cancel = () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(end);
    };
    run.keepAlive = () => {
      timer.ref?.();
      end.ref?.();
    };
    this.runs.add(run);
    // Frame 0 immediately, so the rainbow is spread before the first step.
    void this.track(this.paintFrame(entityIds, rotation, 0));
  }

  private async paintFrame(entityIds: string[], rotation: RotationConfig, frame: number): Promise<void> {
    const { colors, transitionSeconds, brightnessPct } = rotation;
    await Promise.all(
      entityIds.map(async (entityId, index) => {
        const serviceData: Record<string, unknown> = {
          rgb_color: colors[(index + frame) % colors.length]!,
        };
        if (transitionSeconds > 0) serviceData.transition = transitionSeconds;
        // Brightness only on the opening frame; repeating it re-fades the bulb.
        if (frame === 0 && brightnessPct !== null) serviceData.brightness_pct = brightnessPct;
        try {
          await executeAction(
            this.opts.haClient,
            {
              tier: 'green',
              domain: 'light',
              service: 'turn_on',
              serviceData,
              entityIds: [entityId],
              verification: 'fire_and_forget',
            },
            new CommandTrace('text', 'flourish-rotate', 'internal'),
          );
        } catch (err) {
          this.opts.logger.debug('flourish: rotation frame failed', {
            entity: entityId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  /**
   * Wait for every pending restore to run. Short-lived commands (`voicebridge
   * text`/`say`) must call this before shutting down, or they exit holding a
   * snapshot the lights never get back.
   */
  async drain(): Promise<void> {
    while (this.runs.size > 0 || this.inflight.size > 0) {
      const runs = [...this.runs];
      for (const run of runs) run.keepAlive();
      await Promise.all([...runs.map((run) => run.settled), ...this.inflight]);
    }
  }

  /** A newer command owns these lights now; drop any restore that would undo it. */
  cancelFor(entityIds: string[]): void {
    const dropping = new Set(entityIds);
    for (const run of [...this.runs]) {
      const keep = run.snapshots.filter((snapshot) => !dropping.has(snapshot.entityId));
      if (keep.length === run.snapshots.length) continue;
      run.cancel();
      this.runs.delete(run);
      if (keep.length > 0) {
        this.opts.logger.debug('flourish: partial restore cancelled', {
          cancelled: run.snapshots.length - keep.length,
        });
        // The untouched lights still deserve their restore, immediately — the
        // original timer is gone and re-arming it would extend their flourish.
        void this.track(this.restore(keep)).finally(() => run.finish());
      } else {
        run.finish();
      }
    }
  }

  stop(): void {
    for (const run of this.runs) {
      run.cancel();
      run.finish();
    }
    this.runs.clear();
  }

  get pendingCount(): number {
    return this.runs.size;
  }

  private track(promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
    return tracked;
  }

  private async restore(snapshots: LightSnapshot[]): Promise<void> {
    const trace = new CommandTrace('text', 'flourish-restore', 'internal');
    for (const call of restorePlan(snapshots)) {
      try {
        const result = await executeAction(
          this.opts.haClient,
          {
            tier: 'green',
            domain: 'light',
            service: call.service,
            serviceData: call.serviceData,
            entityIds: call.entityIds,
            // Causally verified, so each step is confirmed applied before the
            // next is sent — bulbs need a beat, and drain() then genuinely
            // means "the lights are back", not "the calls were sent".
            verification: 'state',
          },
          trace,
        );
        if (!result.ok) {
          this.opts.logger.warn('flourish: restore call failed', {
            service: call.service,
            entities: call.entityIds,
            error: result.error,
          });
        }
      } catch (err) {
        this.opts.logger.warn('flourish: restore call threw', {
          service: call.service,
          entities: call.entityIds,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.opts.logger.info('flourish: restored', { entities: snapshots.map((s) => s.entityId) });
  }
}
