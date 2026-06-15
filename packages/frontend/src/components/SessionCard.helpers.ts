export const CARD_PREVIEW_LINES = 3;

export function formatModelName(model: string): string {
  return model.replace(/^claude-/, '');
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}
