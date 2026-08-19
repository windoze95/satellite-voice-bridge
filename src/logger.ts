// Tiny JSONL logger: pretty console to stderr + optional size-capped file.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class Logger {
  private writesSinceStat = 0;

  constructor(
    private readonly opts: { level?: LogLevel; file?: string; console?: boolean } = {},
  ) {
    if (opts.file) mkdirSync(dirname(opts.file), { recursive: true });
  }

  debug(msg: string, fields?: Record<string, unknown>): void { this.log('debug', msg, fields); }
  info(msg: string, fields?: Record<string, unknown>): void { this.log('info', msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>): void { this.log('warn', msg, fields); }
  error(msg: string, fields?: Record<string, unknown>): void { this.log('error', msg, fields); }

  private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.opts.level ?? 'info']) return;
    const ts = new Date().toISOString();
    if (this.opts.console !== false) {
      const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
      process.stderr.write(`[${ts.slice(11, 19)}] ${level.toUpperCase().padEnd(5)} ${msg}${extra}\n`);
    }
    if (this.opts.file) {
      try {
        this.rotateIfNeeded();
        appendFileSync(this.opts.file, `${JSON.stringify({ ts, level, msg, ...fields })}\n`);
      } catch {
        // Logging must never take the bridge down.
      }
    }
  }

  private rotateIfNeeded(): void {
    const file = this.opts.file;
    if (!file) return;
    if (this.writesSinceStat++ % 200 !== 0) return;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // File may not exist yet.
    }
  }
}
