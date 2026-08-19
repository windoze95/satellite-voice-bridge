// Shared bootstrap: config → logger → HA client + registry → session manager.
import { loadConfig, missingEnv, type Config } from '../config.js';
import { advertisedDomains, buildInstructions } from '../context/house-context.js';
import { HAClient } from '../ha/client.js';
import { Registry } from '../ha/registry.js';
import { Logger, type LogLevel } from '../logger.js';
import { SessionManager } from '../realtime/session.js';

export interface App {
  cfg: Config;
  logger: Logger;
  haClient: HAClient;
  registry: Registry;
  sessions: SessionManager;
}

export class AppError extends Error {}

export async function createApp(opts: { retryHA: boolean; logFile?: boolean }): Promise<App> {
  const cfg = loadConfig();
  const missing = missingEnv(cfg);
  if (missing.length > 0) {
    throw new AppError(`Missing environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  }

  const logger = new Logger({
    level: (process.env.VOICEBRIDGE_LOG_LEVEL as LogLevel | undefined) ?? 'info',
    file: opts.logFile ? 'var/log/voicebridge.log' : undefined,
  });

  const registry = new Registry(logger, {
    voiceDomains: advertisedDomains(cfg.policy),
    cacheDumpPath: 'var/registry-cache.json',
  });
  const haClient = new HAClient({
    url: cfg.haUrl!,
    token: cfg.haToken!,
    logger,
    retry: opts.retryHA,
    onSync: (client) => registry.sync(client),
  });
  registry.attach(haClient);

  const sessions = new SessionManager({
    mode: cfg.session.mode,
    url: cfg.realtimeUrl,
    apiKey: cfg.openaiApiKey!,
    model: cfg.session.model,
    transcribe: cfg.session.transcribeInput,
    logger,
  });

  // Registry drift → refresh a live warm session's house map (no-op otherwise).
  registry.on('updated', () => {
    if (registry.cache) {
      sessions.updateInstructions(buildInstructions(registry.cache, cfg.policy)).catch((err: unknown) => {
        logger.warn('warm session instruction refresh failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }
  });

  await haClient.start();
  return { cfg, logger, haClient, registry, sessions };
}

export function shutdownApp(app: App): void {
  app.sessions.close();
  app.haClient.stop();
}
