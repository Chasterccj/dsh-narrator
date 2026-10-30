/**
 * Message construction for narrator-injected context.
 *
 * The plugin must not import `@deepseek-ai/*` helpers: they are not resolvable
 * from an installed bundle (linked or npm), so messages are built from plain
 * JSON with Node's built-in `randomUUID`.
 */
import { randomUUID } from 'node:crypto'

/** Recursively freeze one JSON-ish value (idempotent). */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build one durable user-role context message produced by this plugin.
 * Contexts are model-visible, so callers keep `text` short.
 * @param {string} text - model-facing text.
 * @param {string} [summary] - optional short label for the context row.
 * @returns {Readonly<object>} frozen user message.
 */
export function contextMessage(text, summary) {
  const source = { kind: 'narrator', form: 'notice' }
  if (typeof summary === 'string' && summary.length > 0) source.summary = summary
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source,
  })
}
