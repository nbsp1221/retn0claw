export type VisibleAction =
  | { type: 'preview_update'; text: string }
  | { type: 'final_send'; text: string }
  | { type: 'final_replace_preview'; text: string }
  | { type: 'preview_finalize'; text?: string | null };

export type StateTransition =
  | { type: 'session_store'; sessionId: string }
  | { type: 'session_clear'; reason: 'resume_failed' }
  | { type: 'terminal_close'; reason: 'final' | 'interrupt' | 'close' };

export function isSemanticFinalAction(action: VisibleAction): boolean {
  return (
    action.type === 'final_send' ||
    action.type === 'final_replace_preview' ||
    action.type === 'preview_finalize'
  );
}
