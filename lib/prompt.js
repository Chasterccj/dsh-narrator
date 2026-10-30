/**
 * The fixed model-facing policy prompt.
 *
 * Registered through `systemPrompt.context()` (cache-safe: appended after the
 * retained history) and evaluated on every assembly, so `/narrator` toggles
 * take effect without touching the prefix cache.
 */

const NARRATION_RULE = 'Narrate important actions in plain language. Before a tool call that changes files, runs '
  + 'a command, manages plugins, changes schedules, or starts a subagent, write ONE short sentence to the user '
  + 'saying what you are about to do and why. When it finishes, write ONE short sentence saying what happened and '
  + 'what changed. Do not narrate read-only actions. Use the language of the user\'s most recent message.'

const ASK_RULE = 'Ask instead of guessing. If the goal is ambiguous, several reasonable approaches exist, a '
  + 'required detail is missing, or an operation keeps failing, call ask_user_question before proceeding.'

const NEWEST_RULE = 'The newest instruction wins. If the user writes while you are working, drop the current plan '
  + 'and follow the new instruction.'

const GATE_RULE = 'Gated irreversible actions. If a tool call is denied with NARRATOR-GATE, do not retry it '
  + 'directly: first call ask_user_question, then retry only after the answer.'

/**
 * Build the policy context text for the current settings.
 * @param {{narration: boolean, gate: boolean, interrupt: boolean}} settings - effective toggles.
 * @returns {string} prompt context text, or `''` when every behaviour is off.
 */
export function buildPromptText(settings) {
  const rules = []
  if (settings.narration) rules.push(NARRATION_RULE)
  if (settings.gate) {
    rules.push(ASK_RULE)
    rules.push(GATE_RULE)
  }
  if (settings.interrupt) rules.push(NEWEST_RULE)
  if (rules.length === 0) return ''
  return [
    '## dsh-narrator policy (enforced by a plugin; follow it exactly)',
    '',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join('\n')
}
