// voicebridge run — the 24/7 service: keeps HA connected (and a warm Realtime
// session when configured). Satellite audio sources plug in here when built.
import { buildInstructions } from '../context/house-context.js';
import { SatelliteManager } from '../audio/satellite-manager.js';
import { runCommand } from '../pipeline.js';
import { AppError, createApp, shutdownApp, type App } from './app.js';

export async function run(_args: string[]): Promise<number> {
  let app: App;
  try {
    app = await createApp({ retryHA: true, logFile: true });
  } catch (err) {
    console.error(err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err));
    return 1;
  }
  const { cfg, logger, registry, sessions, haClient } = app;

  logger.info('voicebridge service started', {
    session_mode: cfg.session.mode,
    model: cfg.session.model,
    satellites: Object.keys(cfg.satellites).length,
    follow_up_ms: cfg.conversation.followUpMs,
    delegate: cfg.delegate.enabled ? cfg.delegate.model : 'disabled',
  });
  if (cfg.conversation.followUpMs > 0 && cfg.session.mode !== 'warm') {
    logger.warn('follow-ups are enabled but session.mode is per_utterance; every follow-up pays session setup', {
      follow_up_ms: cfg.conversation.followUpMs,
    });
  }
  if (Object.keys(cfg.satellites).length === 0) {
    logger.info('no satellite sources configured yet — idling with a live HA connection (use `voicebridge text/say` for commands)');
  }

  const prewarm = (): void => {
    if (cfg.session.mode !== 'warm' || !registry.cache) return;
    sessions.prewarm(buildInstructions(registry.cache, cfg.policy), true).catch((err: unknown) => {
      logger.warn('warm session prewarm failed (will retry on next use)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  prewarm();
  haClient.on('ready', prewarm);

  const satelliteManager = new SatelliteManager({
    satellites: cfg.satellites,
    logger,
    getEncryptionKey: (entryId) => haClient.getESPHomeEncryptionKey(entryId),
    runCommand: (source, opts) => runCommand(app, { kind: 'audio', source }, { followUpIndex: opts.followUpIndex }),
    followUpMs: cfg.conversation.followUpMs,
    maxFollowUps: cfg.conversation.maxFollowUps,
    // A follow-up chain shares one conversation so "now dim it a bit" resolves
    // against what just happened; that history is dropped once the chain ends.
    onChainEnd: () => sessions.pruneConversation(),
  });
  try {
    await satelliteManager.start();
  } catch (err) {
    logger.error('satellite startup failed', { error: err instanceof Error ? err.message : String(err) });
    await satelliteManager.stop();
    shutdownApp(app);
    return 1;
  }

  const heartbeat = setInterval(() => {
    logger.debug('heartbeat', { ha: haClient.state });
  }, 5 * 60 * 1000);
  heartbeat.unref?.();

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  logger.info('voicebridge service shutting down');
  clearInterval(heartbeat);
  await satelliteManager.stop();
  shutdownApp(app);
  return 0;
}
