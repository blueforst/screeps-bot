export const ACTION_LOG_LIMIT = 20;

export function limitActionLog(actions: string[]): string[] {
  return actions.length > ACTION_LOG_LIMIT ? actions.slice(-ACTION_LOG_LIMIT) : actions;
}
