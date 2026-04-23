import {
  buildTranscript,
  namedTranscript,
} from '../../support/transcript-builders.js';

export const semanticTranscripts = {
  finalOnly: namedTranscript('final only', [{ type: 'final', text: 'done' }]),
  metaOnly: namedTranscript('meta only', [
    { type: 'meta', sessionId: 'thread-1' },
  ]),
  progressOnly: namedTranscript('progress only', [
    { type: 'progress', text: 'draft' },
  ]),
  progressStormThenFinal: namedTranscript('progress storm then final', [
    { type: 'progress', text: 'd' },
    { type: 'progress', text: 'dr' },
    { type: 'progress', text: 'draft' },
    { type: 'final', text: 'final answer' },
  ]),
  progressThenFinalThenLateProgress: namedTranscript(
    'progress then final then late progress',
    [
      { type: 'progress', text: 'draft' },
      { type: 'final', text: 'done' },
      { type: 'progress', text: 'too late' },
    ],
  ),
  duplicateFinalAfterTerminal: namedTranscript(
    'duplicate final after terminal delivery',
    [
      { type: 'progress', text: 'draft' },
      { type: 'final', text: 'done' },
      { type: 'final', text: 'done again' },
    ],
  ),
  progressThenEmptyFinal: namedTranscript('progress then empty final', [
    { type: 'progress', text: 'draft' },
    { type: 'final', text: null },
  ]),
  whitespaceOnlyProgress: namedTranscript('whitespace-only progress', [
    { type: 'progress', text: '   ' },
  ]),
  emptyFinal: namedTranscript('empty final', [{ type: 'final', text: null }]),
};

export const allSemanticTranscripts = buildTranscript([
  { type: 'meta', sessionId: 'thread-1' },
  { type: 'progress', text: 'draft' },
  { type: 'final', text: 'done' },
]);
