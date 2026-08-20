// packages/memory/memory-core/src/budget.ts
// Prompt budget helpers: every injected memory block passes through a char
// budget so a bloated store can never blow up the system prompt. Truncation
// prefers line boundaries and always appends a marker telling the model the
// full text stays reachable through the memory tools.

/** Appended whenever a block is cut; tells the model how to see the rest. */
export const TRUNCATION_MARKER = '\n…（已截断，可用工具查看完整内容）'

/**
 * Truncate `text` to at most `max` chars of content, cutting at the last
 * newline within budget when one exists and appending the truncation marker.
 * Text within budget is returned unchanged; `max <= 0` yields ''.
 * @param text - the block text.
 * @param max - char budget for the content (marker not counted).
 * @returns the budgeted text.
 */
export function truncateChars(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max - 1)
  const head = cut > 0 ? text.slice(0, cut) : text.slice(0, max)
  return head + TRUNCATION_MARKER
}

/**
 * Budget each part independently, drop the empty ones and join the rest with
 * blank lines. Returns '' when nothing survives.
 * @param parts - texts paired with their individual char budgets.
 * @returns the joined budgeted text.
 */
export function budgetText(parts: { text: string; max: number }[]): string {
  return parts
    .map(part => truncateChars(part.text, part.max))
    .filter(text => text !== '')
    .join('\n\n')
}
