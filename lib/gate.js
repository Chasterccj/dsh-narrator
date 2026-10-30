/**
 * Irreversible-action gate.
 *
 * `tools/pre-execute` denies a dangerous call until the model has asked the
 * user during the same turn (`ask_user_question` observed in `tools/result`).
 * Child agents cannot ask the human at all, so they are told to stop and hand
 * the decision back to the parent agent; the parent is reminded to ask.
 */
import { contextMessage } from './messages.js'
import { describeAction, isImportant, isIrreversible } from './classify.js'

/** Marker embedded in a child agent's deny reason. */
const CHILD_MARKER = 'NARRATOR-CHILD-GATE'

const CHILD_REASON = `${CHILD_MARKER}: `;
const ROOT_REASON = 'NARRATOR-GATE: '

const PARENT_REMINDER = 'Your subagent hit the irreversible-action gate (NARRATOR-CHILD-GATE) and needs the user\'s '
  + 'decision. Tell the user what it wanted to do and ask them before retrying or changing the plan.'

/**
 * Recursion depth of one agent's session: 0 for a root agent, >0 for a child.
 * @param {object} agent - live agent handle.
 * @returns {number} delegation depth.
 */
function depthOf(agent) {
  const depth = agent?.session?.header?.delegationDepth
  return typeof depth === 'number' ? depth : 0
}

/**
 * Report one non-fatal hook failure without breaking the tool pipeline.
 * @param {object} logger - optional logger.
 * @param {string} message - what failed.
 * @param {unknown} error - the failure.
 */
function warn(logger, message, error) {
  if (logger && typeof logger.warn === 'function') logger.warn(`dsh-narrator: ${message}: ${error?.message ?? String(error)}`)
}

/**
 * Whether one tool result content carries the child-gate marker.
 * @param {unknown} content - result content blocks.
 * @returns {boolean} whether the marker is present.
 */
function hasChildMarker(content) {
  if (!Array.isArray(content)) return false
  return content.some(block => block !== null && typeof block === 'object'
    && block.type === 'text' && typeof block.text === 'string' && block.text.includes(CHILD_MARKER))
}

/**
 * Append one context message to a post-execute decision, preserving its fields.
 * @param {object} decision - downstream PostToolDecision.
 * @param {object} note - context message to attach.
 * @returns {object} replaced decision.
 */
function withAdditionalContext(decision, note) {
  const existing = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
  return { ...decision, additionalContexts: [note, ...existing] }
}

/**
 * Create the gate hooks.
 * @param {{runtime: object, agents: object, logger?: object}} options - shared plugin state.
 * @returns {object} hook handlers used by the plugin entry.
 */
export function createGate({ runtime, agents, logger }) {
  return {
    /**
     * Deny an irreversible call until the user has answered in this turn.
     * @param {object} exec - tool execution.
     * @param {() => Promise<object>} next - downstream policy.
     * @returns {Promise<object>} pre-execute decision.
     */
    async preExecute(exec, next) {
      const decision = await next()
      try {
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'allow') return decision
        if (!exec || !exec.agent) return decision
        const state = agents.get(exec.agent)
        if (isImportant(exec.name, runtime.config)) state.activity = describeAction(exec.name, exec.arguments)
        if (!runtime.settings.gate) return decision
        const cwd = runtime.config.workspaceRoot || exec.agent.session?.header?.cwd || process.cwd()
        const verdict = isIrreversible(exec.name, exec.arguments, runtime.config, cwd)
        if (verdict === false) return decision
        if (depthOf(exec.agent) > 0) {
          if (runtime.settings.children !== 'report') return decision
          return {
            kind: 'deny',
            reason: `${CHILD_REASON}${verdict.reason}。你无法直接询问用户；请停止该动作，把需要用户确认的决策（含原因）写进最终结果交回父代理。`,
          }
        }
        if (state.askedTurn === state.turn) return decision
        return {
          kind: 'deny',
          reason: `${ROOT_REASON}${verdict.reason}。先用 ask_user_question 向用户确认，得到答复后再重试这个动作。`,
        }
      } catch (error) {
        warn(logger, 'gate pre-execute failed', error)
        return decision
      }
    },

    /**
     * Advance the per-agent turn cursor at the start of a turn.
     * @param {{agent: object, turn: number}} payload - pre-step payload.
     */
    resetTurn(payload) {
      try {
        if (!payload || !payload.agent) return
        const state = agents.get(payload.agent)
        const turn = typeof payload.turn === 'number' ? payload.turn : state.turn
        if (state.turn !== turn) state.turn = turn
      } catch (error) {
        warn(logger, 'gate turn reset failed', error)
      }
    },

    /**
     * Observe results: remember a successful user question and the last action.
     * @param {object} exec - tool execution.
     * @param {object} result - final tool result.
     */
    onResult(exec, result) {
      try {
        if (!exec || !exec.agent) return
        const state = agents.get(exec.agent)
        if (exec.name === 'ask_user_question' && result && result.isError !== true) {
          state.askedTurn = state.turn
        }
      } catch (error) {
        warn(logger, 'gate result observation failed', error)
      }
    },

    /**
     * Surface a child agent's blocked decision to its parent agent.
     * @param {object} exec - tool execution.
     * @param {object} result - normalized result.
     * @param {() => Promise<object>} next - downstream policy.
     * @returns {Promise<object>} post-execute decision.
     */
    async postExecute(exec, result, next) {
      const decision = await next()
      try {
        if (!exec || !exec.agent || depthOf(exec.agent) > 0) return decision
        if (!hasChildMarker(result?.content)) return decision
        return withAdditionalContext(decision, contextMessage(PARENT_REMINDER, 'subagent gate'))
      } catch (error) {
        warn(logger, 'gate post-execute failed', error)
        return decision
      }
    },
  }
}
