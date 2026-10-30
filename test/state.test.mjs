import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearOverrides, loadOverrides, narratorDir, saveOverrides, statePath,
} from '../lib/state.js'

const logger = { warnings: [], warn(message) { this.warnings.push(message) } }

function withHome(run) {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-narrator-state-'))
  process.env.DSH_HOME = home
  try {
    return run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('state lives under DSH_HOME/narrator', () => {
  withHome(home => {
    assert.equal(narratorDir(), join(home, 'narrator'))
    assert.equal(statePath(), join(home, 'narrator', 'state.json'))
  })
})

test('save, load, and clear round-trip', () => {
  withHome(() => {
    assert.deepEqual(loadOverrides(logger), {})
    saveOverrides({ gate: false, children: 'soft' }, logger)
    assert.equal(existsSync(statePath()), true)
    const stored = JSON.parse(readFileSync(statePath(), 'utf8'))
    assert.equal(stored.version, 1)
    assert.equal(stored.gate, false)
    assert.deepEqual(loadOverrides(logger), { gate: false, children: 'soft' })
    clearOverrides(logger)
    assert.equal(existsSync(statePath()), false)
    assert.deepEqual(loadOverrides(logger), {})
  })
})

test('a corrupt state file degrades to no overrides', () => {
  withHome(() => {
    saveOverrides({}, logger)
    writeFileSync(statePath(), '{ not json', 'utf8')
    const before = logger.warnings.length
    assert.deepEqual(loadOverrides(logger), {})
    assert.equal(logger.warnings.length, before + 1)
  })
})

test('clear on a missing file is silent', () => {
  withHome(() => {
    const before = logger.warnings.length
    clearOverrides(logger)
    assert.equal(logger.warnings.length, before)
  })
})
