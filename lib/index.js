/**
 * dsh-narrator — plugin entry.
 *
 * Three behaviours, all policy-layer:
 *  1. narration  — a fixed system-prompt context asks the model to explain
 *     important actions in plain language before and after doing them;
 *  2. gate       — `tools/pre-execute` denies irreversible calls until the
 *     model has asked the user in the same turn;
 *  3. interrupt  — a user message while a turn runs cancels that turn and the
 *     newest instruction wins.
 *
 * Every behaviour can be toggled at runtime through `/narrator`, whose choices
 * persist under the Harness home.
 */
import { SETTINGS_KEYS, normalizeConfig } from './config.js'
import { clearOverrides, loadOverrides, saveOverrides } from './state.js'
import { buildPromptText } from './prompt.js'
import { createAgentState } from './agents.js'
import { createGate } from './gate.js'
import { createInterrupt } from './interrupt.js'
import { createCommand } from './command.js'

/** Stable Cordis plugin name. */
export const name = 'narrator'

/** Services this plugin needs; the prompt registry and the human command registry. */
export const inject = ['systemPrompt', 'commands']

/**
 * Fallback logger so a host without `ctx.logger` still never crashes a hook.
 * @param {object} ctx - plugin context.
 * @returns {object} logger-ish object.
 */
function loggerOf(ctx) {
  if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') return ctx.logger
  return { warn() {} }
}

/**
 * Install prompt context, tool-pipeline hooks, and the `/narrator` command.
 * @param {object} ctx - plugin context.
 * @param {unknown} rawConfig - Loader row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = loggerOf(ctx)
  const raw = rawConfig !== null && rawConfig !== undefined && typeof rawConfig === 'object' ? rawConfig : {}
  const overrides = loadOverrides(logger)

  const settings = {
    narration: config.narration,
    gate: config.gate,
    interrupt: config.interrupt,
    children: config.children,
  }
  for (const key of SETTINGS_KEYS) {
    if (overrides[key] !== undefined) settings[key] = overrides[key]
  }

  const runtime = {
    config,
    rawConfig: raw,
    overrides,
    settings,
    /**
     * Apply one or more setting changes and persist them as overrides.
     * @param {object} partial - settings to change.
     */
    setMany(partial) {
      for (const [key, value] of Object.entries(partial)) {
        if (!SETTINGS_KEYS.includes(key)) continue
        settings[key] = value
        overrides[key] = value
      }
      saveOverrides(overrides, logger)
    },
    /** Drop every override and fall back to the configured values. */
    reset() {
      for (const key of SETTINGS_KEYS) delete overrides[key]
      settings.narration = config.narration
      settings.gate = config.gate
      settings.interrupt = config.interrupt
      settings.children = config.children
      clearOverrides(logger)
    },
  }

  const agents = createAgentState()
  const gate = createGate({ runtime, agents, logger })
  const interrupt = createInterrupt({ runtime, agents, logger })

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'narrator:policy',
    order: 1000,
    interpolate: false,
    text: () => buildPromptText(settings),
  }), 'narrator: policy prompt')

  ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => gate.preExecute(exec, next)),
    'narrator: irreversible gate')

  ctx.effect(() => ctx.on('tools/result', (exec, result) => gate.onResult(exec, result)),
    'narrator: gate result observation')

  ctx.effect(() => ctx.on('tools/post-execute', (exec, result, next) => gate.postExecute(exec, result, next)),
    'narrator: child-gate reminder')

  ctx.effect(() => ctx.on('agent/inbox/inserted', payload => interrupt.onInboxInserted(payload)),
    'narrator: interrupt on user input')

  ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    gate.resetTurn(payload)
    return interrupt.decoratePreStep(payload, decision)
  }), 'narrator: turn bookkeeping')

  ctx.effect(() => ctx.commands.register(createCommand({ runtime })), 'narrator: command')
}
