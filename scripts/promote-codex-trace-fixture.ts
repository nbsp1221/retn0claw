import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { sanitizeCodexTraceRecord } from '../src/runners/codex/codex-trace-sanitizer.js';

function defaultFixturePath(tracePath: string): string {
  const base = path.basename(tracePath, '.jsonl');
  return path.resolve(
    process.cwd(),
    'tests',
    'contracts',
    'fixtures',
    `${base}.fixture.json`,
  );
}

export function promoteCodexTraceFixture(
  tracePath: string,
  fixturePath = defaultFixturePath(tracePath),
): string {
  if (!tracePath) {
    throw new Error(
      'Usage: tsx scripts/promote-codex-trace-fixture.ts <tracePath> [fixturePath]',
    );
  }

  const records = fs
    .readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => sanitizeCodexTraceRecord(JSON.parse(line)));

  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(records, null, 2)}\n`);
  return fixturePath;
}

function main(): void {
  const tracePath = process.argv[2];
  const fixturePath = process.argv[3]
    ? path.resolve(process.argv[3])
    : defaultFixturePath(tracePath);
  process.stdout.write(`${promoteCodexTraceFixture(tracePath, fixturePath)}\n`);
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main();
}
