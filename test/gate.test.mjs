import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentState } from '../lib/agents.js'
import { createGate } from '../lib/gate.js'
import { normalizeConfig } from '../lib/config.js'

const logger = { warn() {} }

function makeGate(overrides = {}) {
  const runtime = {
    config: normalizeConfig(overrides),
    settings: { narration: true, gate: true, interrupt: true, children: 'report' },
  }
  return { gate: createGate({ runtime, agents: createAgentState(), logger }), runtime }
}

const rootAgent = () => ({ session: { header: { cwd: '/work' } }, status: 'running' })
const childAgent = () => ({ session: { header: { cwd: '/work', delegationDepth: 1 } }, status: 'running' })
const allow = async () => ({ kind: 'allow' })
const exec = (agent, name = 'bash', args = { command: 'rm -rf build' }) => ({ agent, name, arguments: args })
const ask = agent => ({ agent, name: 'ask_user_question', arguments: {} })

test('root agent: irreversible call is denied before asking', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  const decision = await gate.preExecute(exec(agent), allow)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /NARRATOR-GATE/)
  assert.match(decision.reason, /ask_user_question/)
})

test('root agent: asking once in the turn releases the gate', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  await gate.preExecute(exec(agent), allow)
  gate.onResult(ask(agent), { isError: false })
  assert.equal((await gate.preExecute(exec(agent), allow)).kind, 'allow')
})

test('a later turn needs a fresh question', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  gate.onResult(ask(agent), { isError: false })
  assert.equal((await gate.preExecute(exec(agent), allow)).kind, 'allow')
  gate.resetTurn({ agent, turn: 2 })
  assert.equal((await gate.preExecute(exec(agent), allow)).kind, 'deny')
})

test('a failed question does not release the gate', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  gate.onResult(ask(agent), { isError: true })
  assert.equal((await gate.preExecute(exec(agent), allow)).kind, 'deny')
})

test('safe calls and non-allow downstream decisions pass through', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  assert.equal((await gate.preExecute(exec(agent, 'bash', { command: 'ls' }), allow)).kind, 'allow')
  const denied = await gate.preExecute(exec(agent), async () => ({ kind: 'deny', reason: 'other policy' }))
  assert.equal(denied.reason, 'other policy')
})

test('gate off allows everything', async () => {
  const { gate, runtime } = makeGate()
  runtime.settings.gate = false
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  assert.equal((await gate.preExecute(exec(agent), allow)).kind, 'allow')
})

test('child agents are told to hand the decision to the parent', async () => {
  const { gate } = makeGate()
  const agent = childAgent()
  gate.resetTurn({ agent, turn: 1 })
  const decision = await gate.preExecute(exec(agent), allow)
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /NARRATOR-CHILD-GATE/)
  assert.match(decision.reason, /父代理/)
})

test('children = soft or off lets child calls through', async () => {
  for (const children of ['soft', 'off']) {
    const { gate, runtime } = makeGate()
    runtime.settings.children = children
    const agent = childAgent()
    gate.resetTurn({ agent, turn: 1 })
    assert.equal((await gate.preExecute(exec(agent), allow)).kind, 'allow', children)
  }
})

test('a child-gate marker reminds the parent agent to ask the user', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  gate.resetTurn({ agent, turn: 1 })
  const result = {
    isError: true,
    content: [{ type: 'text', text: 'NARRATOR-CHILD-GATE: rm -rf build blocked' }],
  }
  const decision = await gate.postExecute(exec(agent), result, async () => ({ kind: 'accept' }))
  assert.equal(decision.additionalContexts.length, 1)
  assert.equal(decision.additionalContexts[0].source.kind, 'narrator')
  assert.match(decision.additionalContexts[0].content[0].text, /ask/i)
})

test('the child-gate reminder keeps a blocked decision blocked', async () => {
  const { gate } = makeGate()
  const agent = rootAgent()
  const feedback = [{ type: 'text', text: 'blocked by another policy' }]
  const decision = await gate.postExecute(
    exec(agent),
    { isError: true, content: [{ type: 'text', text: 'NARRATOR-CHILD-GATE' }] },
    async () => ({ kind: 'block', feedback }),
  )
  assert.equal(decision.kind, 'block')
  assert.deepEqual(decision.feedback, feedback)
  assert.equal(decision.additionalContexts.length, 1)
})

test('child agents do not receive the parent reminder themselves', async () => {
  const { gate } = makeGate()
  const agent = childAgent()
  const decision = await gate.postExecute(
    exec(agent),
    { isError: true, content: [{ type: 'text', text: 'NARRATOR-CHILD-GATE' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.additionalContexts, undefined)
})

test('calls without an agent are ignored', async () => {
  const { gate } = makeGate()
  assert.equal((await gate.preExecute(exec(undefined), allow)).kind, 'allow')
  assert.equal((await gate.postExecute(exec(undefined), { content: [] }, allow)).kind, 'allow')
})
