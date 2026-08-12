/**
 * M4.12: no tool result reaches an LLM context unbounded. Every tool that
 * returns free text runs its output through this before returning.
 */
export const MAX_TOOL_TEXT_CHARS = 8000;

export function truncateText(text: string, maxChars: number = MAX_TOOL_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}
