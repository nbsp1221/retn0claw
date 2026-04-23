import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

function findNewestTrace(groupFolder?: string): string {
  const baseDir = path.join(DATA_DIR, 'codex-traces');
  const candidateDirs = groupFolder
    ? [path.join(baseDir, groupFolder)]
    : fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(baseDir, entry.name));

  const files = candidateDirs.flatMap((dir) =>
    fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) => path.join(dir, file))
      : [],
  );

  if (files.length === 0) {
    throw new Error('No Codex trace files found.');
  }

  return files.sort(
    (a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs,
  )[0];
}

function main(): void {
  const groupFolder = process.argv[2];
  const limit = Number(process.argv[3] || '20');
  const tracePath = findNewestTrace(groupFolder);
  const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
  const tail = lines.slice(-Math.max(1, limit));

  process.stdout.write(`${tracePath}\n`);
  for (const line of tail) {
    process.stdout.write(`${line}\n`);
  }
}

main();
