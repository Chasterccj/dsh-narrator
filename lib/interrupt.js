/**
 * Mid-run interruption.
 *
 * When the user writes while an agent is working, the current turn is cancelled
 * so the newest instruction wins, and the next turn opens with a short notice
 * explaining what had been interrupted.
 *
 * The re-delivery step is load-bearing: DSH deliberately ignores a wake latch
 * requested by an inbox-splice observer (it captures `wakeAfterAbort` before
 * insertion so a reentrant cancel cannot reclassify the send). A plain
 * `cancel({keepInbox:true})` from this listener would therefore cancel the turn
 * and leave the queued message parked with no wake. Instead the plugin clears
 * the inbox and re-delivers the same message with `followup()`: the abort signal
 * is already set, so the driver latches a wake for the post-cancellation turn.
 */
import { contextMessage } from './messages.js'

/** Cause recorded on the cancelled turn. */
const CANCEL_CAUSE = Object.freeze({ kind: 'hook', reason: 'narrator: user interjection' })

/**
 * Report one non-fatal hook failure without breaking the pipeline.
 * @param {object} logger - optional logger.
 * @param {string} message - what failed.
 * @param {unknown} error - the failure.
 */
function warn(logger, message, error) {
  if (logger && typeof logger.warn === 'function') logger.warn(`dsh-narrator: ${message}: ${error?.message ?? String(error)}`)
}

/**
 * Create the interruption hooks.
 * @param {{runtime: object, agents: object, logger?: object}} options - shared plugin state.
 * @returns {object} hook handlers used by the plugin entry.
 */
export function createInterrupt({ runtime, agents, logger }) {
  return {
    /**
     * Cancel the running turn when the user themselves interjects, then wake a
     * fresh turn that carries the newest instruction.
     * @param {{agent: object, message: object}} payload - inbox insertion event.
     */
    onInboxInserted(payload) {
      try {
        if (!runtime.settings.interrupt) return
        const agent = payload?.agent
        const message = payload?.message
        if (!agent || !message) return
        if (message.source?.kind !== 'user') return
        if (agent.status !== 'running') return
        const state = agents.get(agent)
        if (state.redelivering) return
        state.preempted = true
        state.redelivering = true
        try {
          agent.cancel(CANCEL_CAUSE)
          agent.followup(message)
        } finally {
          state.redelivering = false
        }
      } catch (error) {
        warn(logger, 'interrupt cancellation failed', error)
      }
    },

    /**
     * Prepend the "what was interrupted" notice to the next turn's first step.
     * @param {{agent: object}} payload - pre-step payload.
     * @param {object} decision - downstream pre-step decision.
     * @returns {object} possibly replaced decision.
     */
    decoratePreStep(payload, decision) {
      try {
        if (!runtime.settings.interrupt) return decision
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
        if (!payload || !payload.agent) return decision
        const state = agents.get(payload.agent)
        if (!state.preempted) return decision
        state.preempted = false
        const activity = state.activity.length > 0 ? state.activity : '未记录'
        const text = `人类在你执行时插话，已中止上一件事（当时：${activity}）。以用户最新的指示为准；若仍有歧义，先问清楚再继续。`
        return { ...decision, messages: [contextMessage(text, 'interrupted'), ...decision.messages] }
      } catch (error) {
        warn(logger, 'interrupt pre-step decoration failed', error)
        return decision
      }
    },
  }
}
