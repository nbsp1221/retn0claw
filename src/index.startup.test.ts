import { describe, expect, it } from 'vitest';

import { shouldBootstrapClaudeRuntime } from './index.js';

describe('startup runtime bootstrap', () => {
  it('bootstraps container runtime only for claude', () => {
    expect(shouldBootstrapClaudeRuntime('claude')).toBe(true);
    expect(shouldBootstrapClaudeRuntime('codex')).toBe(false);
  });
});
