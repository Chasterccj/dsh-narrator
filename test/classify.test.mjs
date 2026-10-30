import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describeAction, isImportant, isIrreversible, matchWildcard } from '../lib/classify.js'
import { normalizeConfig } from '../lib/config.js'

const config = normalizeConfig({})
const cwd = resolve(process.cwd(), 'workspace')

test('wildcard matching is anchored and treats * as a run', () => {
  assert.equal(matchWildcard('bash', 'bash'), true)
  assert.equal(matchWildcard('bas*', 'bash'), true)
  assert.equal(matchWildcard('*_publish', 'npm_publish'), true)
  assert.equal(matchWildcard('bash', 'bashful_backup'), false, 'anchored at the end')
  assert.equal(matchWildcard('a.b', 'axb'), false, 'regex metacharacters are literal')
})

test('important actions: mutators yes, readers no, unknown yes', () => {
  for (const name of ['write', 'edit', 'bash', 'plugin_manager', 'subagent', 'schedule_create']) {
    assert.equal(isImportant(name, config), true, `${name} should be important`)
  }
  for (const name of ['read', 'grep', 'glob', 'todo_write', 'web_search', 'list_mcp_resources']) {
    assert.equal(isImportant(name, config), false, `${name} should be quiet`)
  }
  assert.equal(isImportant('some_mcp_tool', config), true, 'unknown tools default to important')
})

test('quietTools wins over importantTools', () => {
  const quieted = normalizeConfig({ quietTools: ['bash'] })
  assert.equal(isImportant('bash', quieted), false)

  const added = normalizeConfig({ importantTools: ['mcp_*'] })
  assert.equal(isImportant('mcp_write', added), true)
})

test('irreversible shell commands are denied', () => {
  const commands = [
    'rm -rf build',
    'sudo apt install x',
    'git push origin main',
    'git reset --hard HEAD~1',
    'pnpm publish',
    'npm install left-pad',
    'chmod 777 file',
    'rmdir data',
    'del file.txt',
  ]
  for (const command of commands) {
    const verdict = isIrreversible('bash', { command }, config, cwd)
    assert.notEqual(verdict, false, `${command} should be irreversible`)
    assert.equal(typeof verdict.reason, 'string')
  }
})

test('safe shell commands pass', () => {
  for (const command of ['ls -la', 'pnpm test', 'git status', 'cat package.json']) {
    assert.equal(isIrreversible('bash', { command }, config, cwd), false, command)
  }
})

test('custom irreversibleBash patterns apply', () => {
  const custom = normalizeConfig({ irreversibleBash: ['deploy\\.sh'] })
  assert.notEqual(isIrreversible('bash', { command: './deploy.sh prod' }, custom, cwd), false)
  assert.equal(isIrreversible('bash', { command: 'node app.js' }, custom, cwd), false)
  assert.throws(() => normalizeConfig({ irreversibleBash: ['('] }), /dsh-narrator/)
})

test('writes outside the workspace are irreversible, inside are not', () => {
  assert.equal(isIrreversible('write', { file_path: 'src/a.js' }, config, cwd), false)
  assert.equal(isIrreversible('edit', { file_path: 'docs/x.md' }, config, cwd), false)
  const outside = resolve(cwd, '..', 'outside.txt')
  assert.notEqual(isIrreversible('write', { file_path: outside }, config, cwd), false)
  assert.notEqual(isIrreversible('write', { file_path: '../outside.txt' }, config, cwd), false)
  assert.equal(isIrreversible('read', { file_path: outside }, config, cwd), false, 'quiet tools skip the gate')
})

test('workspaceRoot configuration overrides the session cwd', () => {
  const pinned = normalizeConfig({ workspaceRoot: '/pinned' })
  assert.equal(isIrreversible('write', { file_path: '/pinned/a.txt' }, pinned, cwd), false)
  assert.notEqual(isIrreversible('write', { file_path: '/elsewhere/a.txt' }, pinned, cwd), false)
})

test('plugin manager installation actions are irreversible', () => {
  assert.notEqual(isIrreversible('plugin_manager', { action: 'install_bundle' }, config, cwd), false)
  assert.notEqual(isIrreversible('plugin_manager', { action: 'remove_bundle' }, config, cwd), false)
  assert.equal(isIrreversible('plugin_manager', { action: 'list_plugins' }, config, cwd), false)
})

test('publishing-named tools are irreversible', () => {
  assert.notEqual(isIrreversible('npm_publish', {}, config, cwd), false)
  assert.notEqual(isIrreversible('deploy_site', {}, config, cwd), false)
})

test('describeAction is short and names the tool', () => {
  assert.equal(describeAction('bash', { command: 'pnpm test' }), 'bash: pnpm test')
  assert.equal(describeAction('write', { file_path: 'src/a.js' }), 'write: src/a.js')
  const long = describeAction('bash', { command: 'x'.repeat(500) })
  assert.equal(long.length, 120)
  assert.match(long, /…$/)
  assert.equal(describeAction('subagent', {}), 'subagent')
})
