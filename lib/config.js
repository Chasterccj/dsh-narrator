/**
 * Plugin configuration: defaults, normalization, and fail-loud validation.
 *
 * The plugin ships no schemastery schema (that package is not resolvable from
 * an installed bundle), so the row `config` is validated here and an invalid
 * value throws from `apply`.
 */

/** Accepted subagent policies. */
export const CHILDREN_MODES = ['report', 'soft', 'off']

/** The four user-facing settings toggled by `/narrator`. */
export const SETTINGS_KEYS = ['narration', 'gate', 'interrupt', 'children']

/** Built-in defaults for every configuration field. */
export const DEFAULTS = Object.freeze({
  narration: true,
  gate: true,
  interrupt: true,
  children: 'report',
  importantTools: [],
  quietTools: [],
  irreversibleBash: [],
  workspaceRoot: '',
})

/**
 * Throw one configuration error with the plugin prefix.
 * @param {string} message - human-readable detail.
 */
function fail(message) {
  throw new Error(`dsh-narrator: ${message}`)
}

/**
 * Read one optional boolean field.
 * @param {object} input - raw configuration object.
 * @param {string} key - field name.
 * @param {object} target - normalized output.
 */
function readBoolean(input, key, target) {
  const value = input[key]
  if (value === undefined) return
  if (typeof value !== 'boolean') fail(`config.${key} must be a boolean`)
  target[key] = value
}

/**
 * Read one optional string-list field.
 * @param {object} input - raw configuration object.
 * @param {string} key - field name.
 * @param {object} target - normalized output.
 */
function readStringList(input, key, target) {
  const value = input[key]
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail(`config.${key} must be an array of non-empty strings`)
  }
  target[key] = [...value]
}

/**
 * Normalize a row `config` into a complete, validated configuration.
 * @param {unknown} raw - the Loader row's config (possibly undefined).
 * @returns {object} complete configuration with every default filled in.
 */
export function normalizeConfig(raw) {
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    fail('config must be an object')
  }
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = { ...DEFAULTS, importantTools: [], quietTools: [], irreversibleBash: [] }
  readBoolean(input, 'narration', out)
  readBoolean(input, 'gate', out)
  readBoolean(input, 'interrupt', out)
  readStringList(input, 'importantTools', out)
  readStringList(input, 'quietTools', out)
  readStringList(input, 'irreversibleBash', out)
  if (input.children !== undefined) {
    if (!CHILDREN_MODES.includes(input.children)) {
      fail(`config.children must be one of ${CHILDREN_MODES.join(', ')}`)
    }
    out.children = input.children
  }
  if (input.workspaceRoot !== undefined) {
    if (typeof input.workspaceRoot !== 'string') fail('config.workspaceRoot must be a string')
    out.workspaceRoot = input.workspaceRoot
  }
  for (const pattern of out.irreversibleBash) {
    try {
      new RegExp(pattern, 'i')
    } catch (error) {
      fail(`config.irreversibleBash contains an invalid regular expression ${JSON.stringify(pattern)}: ${error.message}`)
    }
  }
  return out
}

/**
 * Read the settings overrides persisted by `/narrator`, ignoring unknown or
 * invalid entries (a damaged state file must never break plugin startup).
 * @param {unknown} raw - parsed state file content.
 * @returns {object} overrides for the subset of {@link SETTINGS_KEYS} present.
 */
export function normalizeOverrides(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const key of ['narration', 'gate', 'interrupt']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  if (CHILDREN_MODES.includes(input.children)) out.children = input.children
  return out
}
