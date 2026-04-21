import fs from 'fs';

import { describe, expect, it } from 'vitest';

describe('orchestration runner seam', () => {
  it('removes direct runContainerAgent usage from orchestration callers', () => {
    const indexSource = fs.readFileSync(
      new URL('./index.ts', import.meta.url),
      'utf-8',
    );
    const schedulerSource = fs.readFileSync(
      new URL('./task-scheduler.ts', import.meta.url),
      'utf-8',
    );

    expect(indexSource).not.toMatch(/\brunContainerAgent\b/);
    expect(schedulerSource).not.toMatch(/\brunContainerAgent\b/);
  });

  it('keeps the host runner seam and orchestration paths free of container-specific contracts', () => {
    const indexSource = fs.readFileSync(
      new URL('./index.ts', import.meta.url),
      'utf-8',
    );
    const runnerSource = fs.readFileSync(
      new URL('./runner.ts', import.meta.url),
      'utf-8',
    );

    expect(indexSource).not.toMatch(
      /import\s*\{[^}]*writeTasksSnapshot[^}]*\}\s*from\s*'\.\/container-runner\.js'/,
    );
    expect(indexSource).not.toMatch(
      /import\s*\{[^}]*writeGroupsSnapshot[^}]*\}\s*from\s*'\.\/container-runner\.js'/,
    );
    expect(runnerSource).not.toMatch(/\bContainerInput\b/);
    expect(runnerSource).not.toMatch(/\bContainerOutput\b/);
  });
});
