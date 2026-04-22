import { finalizeRunnerSessionsCutover } from '../src/finalize-runner-sessions-cutover.js';

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  finalizeRunnerSessionsCutover(process.argv[2]);
  process.stdout.write('runner_sessions cleanup cutover finalized\n');
}
