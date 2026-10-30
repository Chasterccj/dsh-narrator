/**
 * Persistence for `/narrator` overrides.
 *
 * Only explicitly toggled settings are stored, so a configuration change (or a
 * plugin upgrade) still applies to everything the user did not override. The
 * file lives under the Harness home, never under the profile directory, and a
 * damaged file can never prevent the plugin from loading.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeOverrides } from './config.js'

/** On-disk format version. */
const FILE_VERSION = 1

/**
 * Directory holding narrator state (`$DSH_HOME/narrator`).
 * @returns {string} absolute directory path.
 */
export function narratorDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'narrator')
}

/**
 * Path of the overrides file.
 * @returns {string} absolute file path.
 */
export function statePath() {
  return join(narratorDir(), 'state.json')
}

/**
 * Load persisted overrides; any failure degrades to "no overrides".
 * @param {object} [logger] - optional logger with a `warn` method.
 * @returns {object} valid overrides only.
 */
export function loadOverrides(logger) {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    return normalizeOverrides(parsed)
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(logger, `failed to read ${statePath()}`, error)
    return {}
  }
}

/**
 * Persist the complete override set with a temp-file rename.
 * @param {object} overrides - overrides to store.
 * @param {object} [logger] - optional logger with a `warn` method.
 */
export function saveOverrides(overrides, logger) {
  try {
    mkdirSync(narratorDir(), { recursive: true })
    const target = statePath()
    const temporary = `${target}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: FILE_VERSION, ...overrides }, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
  } catch (error) {
    warn(logger, `failed to write ${statePath()}`, error)
  }
}

/**
 * Remove persisted overrides.
 * @param {object} [logger] - optional logger with a `warn` method.
 */
export function clearOverrides(logger) {
  try {
    unlinkSync(statePath())
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(logger, `failed to remove ${statePath()}`, error)
  }
}

/**
 * Report one non-fatal persistence problem.
 * @param {object} logger - optional logger.
 * @param {string} message - what failed.
 * @param {unknown} error - the failure.
 */
function warn(logger, message, error) {
  if (logger && typeof logger.warn === 'function') logger.warn(`${message}: ${error?.message ?? String(error)}`)
}
