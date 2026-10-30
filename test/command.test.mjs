import test from 'node:test'
import assert from 'node:assert/strict'
import { CHILDREN_MODES, normalizeConfig } from '../lib/config.js'
import { createCommand } from '../lib/command.js'

function makeRuntime({ config = {}, rawConfig, overrides = {} } = {}) {
  rawConfig = rawConfig ?? config
  const normalized = normalizeConfig(config)
  const runtime = {
    config: normalized,
    rawConfig,
    overrides: { ...overrides },
    settings: {
      narration: normalized.narration,
      gate: normalized.gate,
      interrupt: normalized.interrupt,
      children: normalized.children,
      ...overrides,
    },
    saved: 0,
    resets: 0,
    setMany(partial) {
      Object.assign(this.settings, partial)
      Object.assign(this.overrides, partial)
      this.saved += 1
    },
    reset() {
      for (const key of Object.keys(this.overrides)) delete this.overrides[key]
      this.settings.narration = normalized.narration
      this.settings.gate = normalized.gate
      this.settings.interrupt = normalized.interrupt
      this.settings.children = normalized.children
      this.resets += 1
    },
  }
  return runtime
}

const run = (runtime, rawInput) => createCommand({ runtime }).handler({ rawInput })

test('status reports every switch with its source', () => {
  const runtime = makeRuntime({ config: { gate: false } })
  const result = run(runtime, 'status')
  assert.equal(result.kind, 'success')
  assert.match(result.text, /旁白 narration: on/)
  assert.match(result.text, /不确定先问 gate: off/)
  assert.match(result.text, /插话即停 interrupt: on/)
  assert.match(result.text, /子代理 children: report/)
  const gateLine = result.text.split('\n').find(line => line.includes('gate:'))
  assert.match(gateLine, /config/)
})

test('an empty input is status', () => {
  const runtime = makeRuntime()
  assert.match(run(runtime, undefined).text, /Narrator 状态/)
  assert.match(run(runtime, '   ').text, /Narrator 状态/)
})

test('on/off flips all three behaviours and persists', () => {
  const runtime = makeRuntime()
  const off = run(runtime, 'off')
  assert.equal(off.kind, 'success')
  assert.equal(runtime.settings.narration, false)
  assert.equal(runtime.settings.gate, false)
  assert.equal(runtime.settings.interrupt, false)
  assert.equal(runtime.saved, 1)
  run(runtime, 'on')
  assert.equal(runtime.settings.narration, true)
  assert.equal(runtime.settings.gate, true)
  assert.equal(runtime.settings.interrupt, true)
})

test('a single switch can be changed', () => {
  const runtime = makeRuntime()
  run(runtime, 'gate off')
  assert.equal(runtime.settings.gate, false)
  assert.equal(runtime.settings.narration, true)
  run(runtime, 'interrupt OFF')
  assert.equal(runtime.settings.interrupt, false)
  run(runtime, 'narration on')
  assert.equal(runtime.settings.narration, true)
})

test('children accepts every documented mode and rejects others', () => {
  const runtime = makeRuntime()
  for (const mode of CHILDREN_MODES) {
    assert.equal(run(runtime, `children ${mode}`).kind, 'success')
    assert.equal(runtime.settings.children, mode)
  }
  assert.equal(run(runtime, 'children sometimes').kind, 'error')
})

test('a missing switch value is a usage error', () => {
  const runtime = makeRuntime()
  for (const input of ['gate', 'interrupt', 'narration']) {
    assert.equal(run(runtime, input).kind, 'error')
  }
})

test('reset restores configured values', () => {
  const runtime = makeRuntime({ config: { gate: false }, overrides: { gate: true, narration: false } })
  assert.equal(runtime.settings.gate, true)
  const result = run(runtime, 'reset')
  assert.equal(result.kind, 'success')
  assert.equal(runtime.resets, 1)
  assert.equal(runtime.settings.gate, false, 'configured value wins again')
  assert.equal(runtime.settings.narration, true, 'default value wins again')
})

test('unknown input returns the usage line', () => {
  const runtime = makeRuntime()
  const result = run(runtime, 'dance')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /\/narrator status/)
})

test('command metadata is present', () => {
  const definition = createCommand({ runtime: makeRuntime() })
  assert.equal(definition.name, 'narrator')
  assert.equal(typeof definition.description, 'string')
  assert.equal(typeof definition.input.hint, 'string')
})
