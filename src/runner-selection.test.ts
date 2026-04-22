import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function importRunnerSelection() {
  vi.resetModules();
  return import('./runner.js');
}

describe('runner selection', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults to claude when DEFAULT_RUNNER is unset', async () => {
    delete process.env.DEFAULT_RUNNER;

    const mod = await importRunnerSelection();

    expect(mod.getSelectedRunnerKind()).toBe('claude');
  });

  it('returns codex when DEFAULT_RUNNER=codex', async () => {
    process.env.DEFAULT_RUNNER = 'codex';

    const mod = await importRunnerSelection();

    expect(mod.getSelectedRunnerKind()).toBe('codex');
  });

  it('throws on invalid DEFAULT_RUNNER values', async () => {
    process.env.DEFAULT_RUNNER = 'bad-runner';

    await expect(importRunnerSelection()).rejects.toThrow(
      /DEFAULT_RUNNER/i,
    );
  });
});
