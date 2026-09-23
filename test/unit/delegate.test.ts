import { describe, expect, it } from 'vitest';
import type { DelegateConfig } from '../../src/config.js';
import { Logger } from '../../src/logger.js';
import { delegateCommand } from '../../src/realtime/delegate.js';
import { MockResponsesServer } from '../mocks/mock-responses-server.js';

const logger = new Logger({ level: 'error', console: false });

const cfg = (overrides: Partial<DelegateConfig> = {}): DelegateConfig => ({
  enabled: true,
  model: 'mock-delegate',
  url: 'http://127.0.0.1:1/v1/responses',
  reasoningEffort: 'none',
  timeoutMs: 2000,
  ...overrides,
});

const CALL = JSON.stringify({ action: 'turn_on', domain: 'light', target: 'lights', area: 'Kitchen', light: { brightness_pct: 40 } });

async function run(server: MockResponsesServer, overrides: Partial<DelegateConfig> = {}) {
  return delegateCommand({
    cfg: cfg({ url: server.url, ...overrides }),
    apiKey: 'sk-test',
    instructions: 'HOUSE:\nAREA: Kitchen\n  light: Kitchen Ceiling',
    request: 'something warm',
    transcript: 'make it cozy in here',
    tone: 'intimate',
    originArea: 'Kitchen',
    logger,
  });
}

describe('delegateCommand', () => {
  it('turns function calls into proposals carrying the fast model\'s tone', async () => {
    const server = await MockResponsesServer.start({ calls: [{ name: 'control_device', arguments: CALL }] });
    const result = await run(server);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({ action: 'turn_on', domain: 'light', area: 'Kitchen' });
    // The delegate reads text and cannot hear delivery, so the tone the fast
    // model heard has to ride along or mood rendering would lose it.
    expect(result.actions[0]?.tone).toBe('intimate');
    expect(result.usage.inputTokens).toBe(900);
    expect(result.usage.cachedTokens).toBe(800);
    await server.close();
  });

  it('sends the verbatim transcript, the paraphrase, the tone and the room', async () => {
    const server = await MockResponsesServer.start({ calls: [{ name: 'control_device', arguments: CALL }] });
    await run(server);

    const body = server.requests[0]!;
    expect(body.model).toBe('mock-delegate');
    expect(body.reasoning).toEqual({ effort: 'none' });
    const input = JSON.stringify(body.input);
    // A paraphrase can lose the detail that made the request hard.
    expect(input).toContain('make it cozy in here');
    expect(input).toContain('something warm');
    expect(input).toContain('intimate');
    expect(input).toContain('Kitchen');
    expect(String(body.instructions)).toContain('HOUSE:');
    await server.close();
  });

  it('reports a timeout rather than hanging the command', async () => {
    const server = await MockResponsesServer.start({
      calls: [{ name: 'control_device', arguments: CALL }],
      delayMs: 500,
    });
    const result = await run(server, { timeoutMs: 60 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a timeout');
    expect(result.error).toContain('timed out');
    await server.close();
  });

  it('reports an HTTP failure instead of throwing', async () => {
    const server = await MockResponsesServer.start({ calls: [], httpStatus: 500 });
    const result = await run(server);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('HTTP 500');
    await server.close();
  });

  it('rejects malformed arguments rather than passing them to policy', async () => {
    const server = await MockResponsesServer.start({
      calls: [{ name: 'control_device', arguments: '{"action":"explode","domain":"light","target":"lights"}' }],
    });
    const result = await run(server);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.error).toContain('bad function arguments');
    await server.close();
  });

  it('distinguishes a truncated response from a considered refusal', async () => {
    const truncated = await MockResponsesServer.start({
      calls: [],
      status: 'incomplete',
      incompleteReason: 'max_output_tokens',
    });
    const cut = await run(truncated);
    expect(cut.ok).toBe(false);
    if (cut.ok) throw new Error('expected an incomplete report');
    expect(cut.error).toContain('max_output_tokens');
    await truncated.close();

    // No calls and a completed status is the model declining, which is a
    // legitimate answer the caller reports as no_action rather than an error.
    const declined = await MockResponsesServer.start({ calls: [], text: 'Nothing here matches that.' });
    const result = await run(declined);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.actions).toHaveLength(0);
    expect(result.text).toBe('Nothing here matches that.');
    await declined.close();
  });

  it('returns an error when the endpoint is unreachable', async () => {
    const result = await delegateCommand({
      cfg: cfg({ url: 'http://127.0.0.1:1/v1/responses' }),
      apiKey: 'sk-test',
      instructions: 'HOUSE:',
      request: 'anything',
      tone: 'neutral',
      logger,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure');
    expect(result.error).toContain('delegate failed');
  });
});
