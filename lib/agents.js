/**
 * Per-agent runtime state shared by the gate and interruption hooks.
 */

/**
 * Create the WeakMap-backed store. Agents are the keys, so entries disappear
 * with the agent and never leak across sessions.
 * @returns {{ get: (agent: object) => object }} accessor.
 */
export function createAgentState() {
  const states = new WeakMap()
  return {
    get(agent) {
      let state = states.get(agent)
      if (state === undefined) {
        // `turn` starts before `askedTurn` so an irreversible call arriving
        // before the first pre-step is still treated as not-yet-asked.
        // `redelivering` guards the plugin's own wake-up re-delivery from
        // being mistaken for another user interjection.
        state = { turn: -2, askedTurn: -1, preempted: false, redelivering: false, activity: '' }
        states.set(agent, state)
      }
      return state
    },
  }
}
