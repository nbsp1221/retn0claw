import fs from 'fs';
import path from 'path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { ChannelFeedbackCapabilities } from '../../../src/feedback/types.js';
import type { Channel } from '../../../src/types.js';

const repoRoot = process.cwd();
const srcRoot = path.join(repoRoot, 'src');
const allowedPlatformFeedbackFiles = new Set([
  path.join(srcRoot, 'channels', 'discord.ts'),
  path.join(srcRoot, 'channels', 'telegram.ts'),
]);
const legacyTypingMethod = 'set' + 'Typing';
const directPlatformTypingPattern = new RegExp(
  `\\bsendTyping\\b|\\bsendChatAction\\b|\\b${legacyTypingMethod}\\b`,
);
type LegacyTypingMethod = `set${'Typing'}`;

function tsFilesUnder(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(fullPath);
    if (
      entry.isFile() &&
      fullPath.endsWith('.ts') &&
      !fullPath.endsWith('.test.ts')
    ) {
      return [fullPath];
    }
    return [];
  });
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('feedback contract: channel boundary', () => {
  it('exposes feedback capabilities on the Channel type', () => {
    expectTypeOf<Channel['feedback']>().toEqualTypeOf<
      ChannelFeedbackCapabilities | undefined
    >();
    expectTypeOf<
      Extract<LegacyTypingMethod, keyof Channel>
    >().toEqualTypeOf<never>();
  });

  it('keeps the public channel contract on feedback capabilities', () => {
    const typeContract = read(path.join(srcRoot, 'types.ts'));

    expect(typeContract).toContain('feedback?: ChannelFeedbackCapabilities');
    expect(typeContract).not.toContain(legacyTypingMethod);
  });

  it('keeps direct platform typing calls inside Telegram and Discord adapters', () => {
    const violations = tsFilesUnder(srcRoot).filter((file) => {
      if (allowedPlatformFeedbackFiles.has(file)) return false;
      const source = read(file);
      return directPlatformTypingPattern.test(source);
    });

    expect(violations).toEqual([]);
  });
});
