import { expect } from 'vitest';

import {
  isSemanticFinalAction,
  type VisibleAction,
} from './visible-actions.js';

export function semanticFinalCount(actions: readonly VisibleAction[]): number {
  return actions.filter(isSemanticFinalAction).length;
}

export function expectSingleSemanticFinal(
  actions: readonly VisibleAction[],
): void {
  expect(
    semanticFinalCount(actions),
    'expected exactly one semantic final',
  ).toBe(1);
}

export function expectNoVisibleDelivery(
  actions: readonly VisibleAction[],
): void {
  expect(actions).toHaveLength(0);
}

export function expectNoProgressPreview(
  actions: readonly VisibleAction[],
): void {
  expect(
    actions.filter((action) => action.type === 'preview_update'),
  ).toHaveLength(0);
}
