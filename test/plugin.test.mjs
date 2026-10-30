import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../lib/index.js'
import { buildPromptText } from '../lib/prompt.js'

function fakeCtx() {
  const registered = { contexts: [], listeners: [], commands: [] }
  const disposers = []
  const disposer = () => {}
  const ctx = {
    logger: { warn() {} },
    systemPrompt: {
      context(context) {
        registered.contexts.push(context)
        return disposer
      },
    },
    commands: {
      register(command) {
        registered.commands.push(command)
        return disposer
      },
    },
    on(event, listener) {
      registered.listeners.push({ event, fn: listener })
      return disposer
    },
    effect(fn) {
      const result = fn()
      disposers.push(typeof result === 'function' ? result : disposer)
      return disposer
    },
  }
  return { ctx, registered, disposers }
}

async function withHome(run) {
  const previous = process.env.DSH_HOME
  const home = mkdtempSync(join(tmpdir(), 'dsh-narrator-plugin-'))
  process.env.DSH_HOME = home
  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

const listener = (registered, event) => registered.listeners.find(entry => entry.event === event).fn

test('plugin exports a stable name and its required services', () => {
  assert.equal(name, 'narrator')
  assert.deepEqual(inject, ['systemPrompt', 'commands'])
})

test('apply registers one prompt context, the hooks, and the command', async () => {
  await withHome(() => {
    const { ctx, registered, disposers } = fakeCtx()
    apply(ctx, undefined)
    assert.equal(registered.contexts.length, 1)
    assert.equal(registered.contexts[0].name, 'narrator:policy')
    assert.equal(registered.contexts[0].order, 1000)
    assert.equal(registered.commands.length, 1)
    assert.equal(registered.commands[0].name, 'narrator')
    const events = registered.listeners.map(entry => entry.event).sort()
    assert.deepEqual(events, [
      'agent/inbox/inserted',
      'agent/pre-step',
      'tools/post-execute',
      'tools/pre-execute',
      'tools/result',
    ])
    assert.equal(disposers.length, 7)
  })
})

test('the policy prompt explains all three behaviours', async () => {
  await withHome(() => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, undefined)
    const text = registered.contexts[0].text()
    assert.match(text, /dsh-narrator policy/)
    assert.match(text, /Narrate important actions/)
    assert.match(text, /ask_user_question/)
    assert.match(text, /newest instruction wins/i)
  })
})

test('invalid configuration fails loudly', async () => {
  await withHome(() => {
    const { ctx } = fakeCtx()
    assert.throws(() => apply(ctx, { gate: 'yes' }), /dsh-narrator/)
    assert.throws(() => apply(ctx, { children: 'maybe' }), /dsh-narrator/)
  })
})

test('the /narrator command toggles the live prompt text', async () => {
  await withHome(() => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, undefined)
    const command = registered.commands[0]
    const context = registered.contexts[0]
    assert.match(context.text(), /Narrate important actions/)
    const off = command.handler({ rawInput: 'off' })
    assert.equal(off.kind, 'success')
    assert.equal(context.text(), '')
    command.handler({ rawInput: 'on' })
    assert.match(context.text(), /Narrate important actions/)
  })
})

test('the wired pre-execute hook denies an irreversible call', async () => {
  await withHome(async () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, undefined)
    const hook = listener(registered, 'tools/pre-execute')
    const agent = { session: { header: { cwd: process.cwd() } }, status: 'running' }
    const decision = await hook({ agent, name: 'bash', arguments: { command: 'rm -rf build' } },
      async () => ({ kind: 'allow' }))
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /NARRATOR-GATE/)
  })
})

test('the wired interrupt hook cancels a running turn on a user message', async () => {
  await withHome(() => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, undefined)
    const hook = listener(registered, 'agent/inbox/inserted')
    const cancels = []
    const agent = {
      status: 'running',
      session: { header: { cwd: process.cwd() } },
      cancel(cause, options) { cancels.push({ cause, options }) },
    }
    hook({ agent, message: { source: { kind: 'user' } } })
    assert.equal(cancels.length, 1)
    assert.deepEqual(cancels[0].cause, { kind: 'hook', reason: 'narrator: user interjection' })
    assert.equal(cancels[0].options.keepInbox, true)

    hook({ agent, message: { source: { kind: 'user-question-reply' } } })
    assert.equal(cancels.length, 1, 'question replies are not interjections')

    agent.status = 'idle'
    hook({ agent, message: { source: { kind: 'user' } } })
    assert.equal(cancels.length, 1, 'idle agents need no cancellation')
  })
})

test('the prepended context explains what was interrupted', async () => {
  await withHome(async () => {
    const { ctx, registered } = fakeCtx()
    apply(ctx, undefined)
    const inbox = listener(registered, 'agent/inbox/inserted')
    const preStep = listener(registered, 'agent/pre-step')
    const execHook = listener(registered, 'tools/pre-execute')
    const agent = {
      status: 'running',
      session: { header: { cwd: process.cwd() } },
      cancel() {},
    }
    await execHook({ agent, name: 'bash', arguments: { command: 'pnpm build' } }, async () => ({ kind: 'allow' }))
    inbox({ agent, message: { source: { kind: 'user' } } })
    const decision = await preStep({ agent, turn: 1, step: 1, messages: [] },
      async () => ({ kind: 'enter', messages: [{ id: 'm1', role: 'user', content: [], source: { kind: 'user' } }] }))
    assert.equal(decision.kind, 'enter')
    assert.equal(decision.messages.length, 2)
    const notice = decision.messages[0]
    assert.equal(notice.source.kind, 'narrator')
    assert.match(notice.content[0].text, /已中止上一件事/)
    assert.match(notice.content[0].text, /pnpm build/)
  })
})

test('prompt text honours each switch independently', () => {
  const all = buildPromptText({ narration: true, gate: true, interrupt: true })
  assert.match(all, /1\. /)
  assert.match(all, /4\. /)
  const none = buildPromptText({ narration: false, gate: false, interrupt: false })
  assert.equal(none, '')
  const narrationOnly = buildPromptText({ narration: true, gate: false, interrupt: false })
  assert.match(narrationOnly, /Narrate important actions/)
  assert.doesNotMatch(narrationOnly, /ask_user_question/)
  assert.doesNotMatch(narrationOnly, /newest instruction wins/i)
})
