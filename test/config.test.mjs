import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, normalizeConfig, normalizeOverrides } from '../lib/config.js'

test('normalizeConfig fills every default', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    narration: true,
    gate: true,
    interrupt: true,
    children: 'report',
    importantTools: [],
    quietTools: [],
    irreversibleBash: [],
    workspaceRoot: '',
  })
  assert.deepEqual({ ...DEFAULTS, importantTools: [], quietTools: [], irreversibleBash: [] }, normalizeConfig({}))
})

test('normalizeConfig accepts explicit values', () => {
  const config = normalizeConfig({
    narration: false,
    gate: false,
    interrupt: false,
    children: 'off',
    importantTools: ['mcp_*'],
    quietTools: ['bash'],
    irreversibleBash: ['deploy'],
    workspaceRoot: '/work',
  })
  assert.equal(config.narration, false)
  assert.equal(config.children, 'off')
  assert.deepEqual(config.importantTools, ['mcp_*'])
  assert.deepEqual(config.irreversibleBash, ['deploy'])
})

test('normalizeConfig rejects invalid fields with the dsh-narrator prefix', () => {
  const invalid = [
    ['narration', 'yes'],
    ['gate', 1],
    ['interrupt', null],
    ['children', 'sometimes'],
    ['importantTools', 'bash'],
    ['quietTools', [1]],
    ['irreversibleBash', ['[']],
    ['workspaceRoot', 42],
  ]
  for (const [key, value] of invalid) {
    assert.throws(() => normalizeConfig({ [key]: value }), /dsh-narrator/, `${key} should be rejected`)
  }
  assert.throws(() => normalizeConfig('nope'), /dsh-narrator/)
})

test('normalizeConfig copies arrays instead of aliasing input', () => {
  const input = { quietTools: ['bash'] }
  const config = normalizeConfig(input)
  input.quietTools.push('write')
  assert.deepEqual(config.quietTools, ['bash'])
})

test('normalizeOverrides keeps only valid setting entries', () => {
  assert.deepEqual(normalizeOverrides(undefined), {})
  assert.deepEqual(normalizeOverrides({ version: 1, narration: false, gate: 'nope', children: 'soft', junk: 1 }), {
    narration: false,
    children: 'soft',
  })
  assert.deepEqual(normalizeOverrides({ children: 'report' }), { children: 'report' })
})
