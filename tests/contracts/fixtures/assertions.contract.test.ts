import { describe, expect, it } from 'vitest';

import {
  expectSingleSemanticFinal,
  semanticFinalCount,
} from '../../support/assertions.js';
import type { VisibleAction } from '../../support/visible-actions.js';

describe('contract assertion helpers', () => {
  it('fail on duplicate visible finals', () => {
    const actions: VisibleAction[] = [
      { type: 'final_send', text: 'one' },
      { type: 'final_send', text: 'two' },
    ];

    expect(semanticFinalCount(actions)).toBe(2);
    expect(() => expectSingleSemanticFinal(actions)).toThrow(
      /expected exactly one semantic final/i,
    );
  });
});
