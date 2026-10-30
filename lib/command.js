/**
 * The human-facing `/narrator` command: status plus on/off controls for the
 * three behaviours, persisted so a restart keeps the user's choice.
 */
import { CHILDREN_MODES, SETTINGS_KEYS } from './config.js'

/** Command usage line shared by every parse error. */
const USAGE = '用法: /narrator status | on | off | narration on|off | gate on|off | interrupt on|off '
  + '| children report|soft|off | reset'

/** Human labels for the four settings. */
const LABELS = {
  narration: '旁白 narration',
  gate: '不确定先问 gate',
  interrupt: '插话即停 interrupt',
  children: '子代理 children',
}

/**
 * Render a boolean as a switch word.
 * @param {boolean} value - switch value.
 * @returns {string} `on` or `off`.
 */
function onOff(value) {
  return value ? 'on' : 'off'
}

/**
 * Where the effective value of one setting comes from.
 * @param {object} runtime - shared plugin state.
 * @param {string} key - setting name.
 * @returns {string} `/narrator`, `config`, or `默认`.
 */
function sourceOf(runtime, key) {
  if (runtime.overrides[key] !== undefined) return '/narrator'
  if (runtime.rawConfig[key] !== undefined) return 'config'
  return '默认'
}

/**
 * Multi-line status report.
 * @param {object} runtime - shared plugin state.
 * @returns {string} status text.
 */
function statusText(runtime) {
  const lines = ['Narrator 状态 / status']
  for (const key of SETTINGS_KEYS) {
    const value = key === 'children' ? runtime.settings.children : onOff(runtime.settings[key])
    lines.push(`- ${LABELS[key]}: ${value}（${sourceOf(runtime, key)}）`)
  }
  return lines.join('\n')
}

/**
 * Parse and apply one `/narrator` invocation.
 * @param {object} runtime - shared plugin state.
 * @param {unknown} rawInput - text after the command name.
 * @returns {{kind: 'success'|'error', text: string}} command result.
 */
function handle(runtime, rawInput) {
  const raw = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (raw.length === 0 || raw.toLowerCase() === 'status') {
    return { kind: 'success', text: statusText(runtime) }
  }
  const parts = raw.toLowerCase().split(/\s+/).filter(Boolean)
  const verb = parts[0]
  const value = parts[1]

  if (verb === 'on' || verb === 'off') {
    const enabled = verb === 'on'
    runtime.setMany({ narration: enabled, gate: enabled, interrupt: enabled })
    return { kind: 'success', text: `Narrator 三开关已全部${enabled ? '开启' : '关闭'}。\n${statusText(runtime)}` }
  }

  if (verb === 'reset') {
    runtime.reset()
    return { kind: 'success', text: `Narrator 已恢复配置默认值。\n${statusText(runtime)}` }
  }

  if (SETTINGS_KEYS.includes(verb)) {
    if (verb === 'children') {
      if (!CHILDREN_MODES.includes(value)) {
        return { kind: 'error', text: `children 必须是 ${CHILDREN_MODES.join(' | ')}。\n${USAGE}` }
      }
      runtime.setMany({ children: value })
      return { kind: 'success', text: statusText(runtime) }
    }
    if (value !== 'on' && value !== 'off') return { kind: 'error', text: USAGE }
    runtime.setMany({ [verb]: value === 'on' })
    return { kind: 'success', text: statusText(runtime) }
  }

  return { kind: 'error', text: USAGE }
}

/**
 * Create the command definition registered on `ctx.commands`.
 * @param {{runtime: object}} options - shared plugin state.
 * @returns {object} command definition passed to `ctx.commands.register`.
 */
export function createCommand({ runtime }) {
  return {
    name: 'narrator',
    description: '旁白 / 不确定先问 / 插话即停：查看与控制',
    input: { hint: 'status | on | off | gate on|off | interrupt on|off | narration on|off | children report|soft|off | reset' },
    handler(invocation) {
      try {
        return handle(runtime, invocation?.rawInput)
      } catch (error) {
        return { kind: 'error', text: `narrator: ${error?.message ?? String(error)}` }
      }
    },
  }
}
