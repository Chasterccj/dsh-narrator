/**
 * Action classification: which tool calls get a plain-language narration, and
 * which are irreversible enough to require a user decision first.
 *
 * Pure functions only — no Context, no I/O — so both the pipeline hooks and
 * the unit tests can call them directly.
 */
import { isAbsolute, relative, resolve } from 'node:path'

/** Tools whose calls are worth narrating by default (name patterns). */
const IMPORTANT_DEFAULT = [
  'write',
  'edit',
  'bash',
  'shell',
  'terminal',
  'run_command',
  'plugin_manager',
  'subagent',
  'subagent_fork',
  'workflow',
  'spawn_teammate',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
]

/** Read-only and coordination tools that never need narration. */
const QUIET_DEFAULT = [
  'read',
  'read_image',
  'read_mcp_resource',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'todo_write',
  'job_output',
  'job_list',
  'job_kill',
  'list_agents',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'team_task_list',
  'team_task_get',
  'send_message',
  'interrupt_agent',
  'wait_agent',
  'schedule_list',
  'skill',
  'present',
  'working_directory',
  'ask_user_question',
  'exit_plan_mode',
  'remember',
]

/** Shell-like tools whose `command` argument can carry a destructive command. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'terminal', 'run_command'])

/** Destructive command patterns (source strings, compiled once). */
const DESTRUCTIVE_COMMANDS = [
  String.raw`\brm\b`,
  String.raw`\brmdir\b`,
  String.raw`\bunlink\b`,
  String.raw`\bmv\b`,
  String.raw`\bdd\b`,
  String.raw`\bmkfs(\.\w+)?\b`,
  String.raw`\btruncate\b`,
  String.raw`\bchmod\b`,
  String.raw`\bchown\b`,
  String.raw`\bicacls\b`,
  String.raw`\bsudo\b`,
  String.raw`\bdoas\b`,
  String.raw`\bshutdown\b`,
  String.raw`\breboot\b`,
  String.raw`\bpoweroff\b`,
  String.raw`\bgit\s+push\b`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bgit\s+clean\s+-[a-z]*f`,
  String.raw`\bgit\s+branch\s+-D\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(publish|unpublish)\b`,
  String.raw`\b(npm|pnpm|yarn|bun)\s+(add|install|i|remove|rm|uninstall)\b`,
  String.raw`\bdel\s`,
  String.raw`\brd\s+\/s`,
  String.raw`remove-item`,
  String.raw`format-volume`,
  String.raw`stop-computer`,
  String.raw`restart-computer`,
  String.raw`set-executionpolicy`,
]

/** Compiled destructive command matchers. */
const DESTRUCTIVE_MATCHERS = DESTRUCTIVE_COMMANDS.map(source => new RegExp(source, 'i'))

/** Plugin-manager actions that change installed code. */
const IRREVERSIBLE_PLUGIN_ACTIONS = new Set(['install_bundle', 'remove_bundle', 'set_bundle'])

/** Tool names that publish, deploy, or release something. */
const PUBLISHING_NAME = /publish|deploy|release/i

/** Tool-name patterns understood by `matchWildcard`; `*` is the only special character. */
const wildcardCache = new Map()

/**
 * Match one wildcard pattern against a tool name.
 * @param {string} pattern - pattern where `*` matches any run of characters.
 * @param {string} name - tool name to test.
 * @returns {boolean} whether the name matches.
 */
export function matchWildcard(pattern, name) {
  let matcher = wildcardCache.get(pattern)
  if (matcher === undefined) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
    matcher = new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
    wildcardCache.set(pattern, matcher)
  }
  return matcher.test(name)
}

/**
 * Whether one tool name matches any pattern in a list.
 * @param {readonly string[]} patterns - wildcard patterns.
 * @param {string} name - tool name.
 * @returns {boolean} whether the name matches.
 */
function matchesAny(patterns, name) {
  return patterns.some(pattern => matchWildcard(pattern, name))
}

/**
 * Whether a tool call is an important action worth a plain-language narration.
 * Unknown tools count as important: an unexplained custom action is exactly
 * what this plugin exists to prevent.
 * @param {string} toolName - tool name.
 * @param {object} config - normalized configuration.
 * @returns {boolean} whether the call should be narrated.
 */
export function isImportant(toolName, config) {
  const name = String(toolName)
  if (matchesAny(config.quietTools, name)) return false
  if (matchesAny(IMPORTANT_DEFAULT, name)) return true
  if (matchesAny(config.importantTools, name)) return true
  if (!matchesAny(QUIET_DEFAULT, name)) return true
  return false
}

/**
 * Extract the shell command from a tool call's arguments.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string} the command text, or `''` when the tool carries none.
 */
function commandOf(args) {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return ''
  const candidate = args.command ?? args.cmd ?? args.script
  return typeof candidate === 'string' ? candidate : ''
}

/**
 * Extract the target path from a file-writing tool call.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string} the path text, or `''` when the tool carries none.
 */
function pathOf(args) {
  if (args === null || typeof args !== 'object') return ''
  const candidate = args.file_path ?? args.path ?? args.target
  return typeof candidate === 'string' ? candidate : ''
}

/**
 * Whether a path resolves outside the workspace root.
 * @param {string} filePath - path taken from tool arguments.
 * @param {string} root - absolute workspace root.
 * @returns {boolean} whether writing there reaches outside the workspace.
 */
function isOutsideRoot(filePath, root) {
  if (filePath.length === 0) return false
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(resolvedRoot, filePath)
  const rel = relative(resolvedRoot, resolvedTarget)
  if (rel === '') return false
  return rel.startsWith('..') || isAbsolute(rel)
}

/**
 * Decide whether one call is irreversible and needs the user's decision first.
 * @param {string} toolName - tool name.
 * @param {unknown} args - parsed tool arguments.
 * @param {object} config - normalized configuration.
 * @param {string|null} cwd - absolute session working directory, when known.
 * @returns {false|{reason: string}} verdict with a short human reason.
 */
export function isIrreversible(toolName, args, config, cwd) {
  const name = String(toolName)
  if (matchesAny(config.quietTools, name)) return false
  if (PUBLISHING_NAME.test(name)) return { reason: `对外发布类工具 ${name}` }

  if (name === 'write' || name === 'edit') {
    const filePath = pathOf(args)
    const root = config.workspaceRoot || cwd || process.cwd()
    if (filePath.length > 0 && isOutsideRoot(filePath, root)) {
      return { reason: `写入工作区外路径 ${filePath}` }
    }
    return false
  }

  if (name === 'plugin_manager') {
    const action = args !== null && typeof args === 'object' ? args.action : undefined
    if (IRREVERSIBLE_PLUGIN_ACTIONS.has(action)) return { reason: `插件管理操作 ${action}` }
    return false
  }

  if (SHELL_TOOLS.has(name)) {
    const command = commandOf(args)
    if (command.length === 0) return false
    for (const matcher of DESTRUCTIVE_MATCHERS) {
      if (matcher.test(command)) return { reason: `可能不可逆的命令 ${command.slice(0, 80)}` }
    }
    for (const source of config.irreversibleBash) {
      if (new RegExp(source, 'i').test(command)) {
        return { reason: `命中自定义不可逆规则 ${source}: ${command.slice(0, 60)}` }
      }
    }
  }
  return false
}

/**
 * One short line describing an action, used in the "what was interrupted"
 * context after a user interjection.
 * @param {string} toolName - tool name.
 * @param {unknown} args - parsed tool arguments.
 * @returns {string} at most 120 characters.
 */
export function describeAction(toolName, args) {
  const name = String(toolName)
  let detail = ''
  if (SHELL_TOOLS.has(name)) detail = commandOf(args)
  else if (name === 'write' || name === 'edit') detail = pathOf(args)
  else if (name === 'plugin_manager' && args !== null && typeof args === 'object') {
    detail = typeof args.action === 'string' ? args.action : ''
  }
  if (detail.length === 0) {
    try {
      detail = typeof args === 'string' ? args : JSON.stringify(args ?? '')
    } catch {
      detail = ''
    }
    if (detail === '{}') detail = ''
  }
  const line = detail.length > 0 ? `${name}: ${detail}` : name
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}
