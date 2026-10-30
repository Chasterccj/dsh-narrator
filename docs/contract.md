# dsh-narrator 实作契约（Lead 定稿，队友照此实现）

本文件是 `docs/design.md` 的可执行版本。**接口、常量、文案、文件归属以下面为准**；不要自行改 package 元数据、不要加依赖。
实现语言：纯 ESM JavaScript（`"type":"module"`），只允许 `node:` 内建模块。**禁止 import 任何 `@deepseek-ai/*` 包**
（linked/npm 安装时解析不到，会 ERR_MODULE_NOT_FOUND；消息对象自己用 `node:crypto` 造）。

## 0. 文件归属（写作用域，勿越界）

| 归属 | 文件 |
|---|---|
| Lead | `package.json`、`cordis.patch.yml`、`docs/**`、`.gitignore`（见备注） |
| core 队友 | `lib/*.js`、`test/*.test.mjs` |
| packaging 队友 | `locale/en.json`、`locale/zh.json`、`icon.svg`、`README.md`、`LICENSE`、`CHANGELOG.md`、`.github/workflows/ci.yml`、`.gitignore` |

## 1. package.json 元数据（Lead 已写好，勿改）

```json
{
  "name": "dsh-narrator",
  "version": "0.1.0",
  "description": "Plain-language narration, an uncertainty gate, and mid-run interruption policy for DeepSeek Harness agents.",
  "type": "module",
  "license": "MIT",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["lib", "locale", "cordis.patch.yml", "icon.svg", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "dsh": ">=0.2.1-rc.2 <0.3.0" },
  "scripts": { "test": "node --test", "pack:check": "npm pack --dry-run" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 内容（Lead 已写）：

```yaml
- insert:
    - id: narrator
      name: dsh-narrator
```

## 2. 插件入口 `lib/index.js`

```js
export const name = 'narrator'
export const inject = ['systemPrompt', 'commands']
export function apply(ctx, config) { /* ... */ }
```

`apply` 必须：

1. `normalizeConfig(config)`（`lib/config.js`）；非法配置在 `apply` 里 throw，错误信息以 `dsh-narrator:` 开头。
2. `loadOverrides()`（`lib/state.js`）；`effective = { ...config, ...overrides }`（overrides 只含被 `/narrator` 显式改过的键）。
3. 注册旁白提示：`ctx.effect(() => ctx.systemPrompt.context(promptContext(settingsRef)), 'narrator: policy prompt')`，
   其中 `promptContext` 在 `lib/prompt.js` 返回 `{ name: 'narrator:policy', order: 1000, interpolate: false, text: () => buildPromptText(currentSettings) }`。
   `text` 是函数，读当前开关；旁白关闭时返回 `''`（空字符串 = 不渲染）。
4. 注册 gate 与 interrupt 的监听器，全部放进 `ctx.effect(...)` 保证卸载干净。
5. 注册 `/narrator` 命令（`lib/command.js`）。
6. `ctx.logger.warn('dsh-narrator: ...')` 只用于非致命诊断（状态文件损坏等），不要抛。

共享可变状态用一个小对象 `runtime = { settings }`；`settings` 是 getter/对象，命令里改它并持久化。

## 3. 配置 `lib/config.js`

```js
export const DEFAULTS = {
  narration: true,
  gate: true,
  interrupt: true,
  children: 'report',            // 'report' | 'soft' | 'off'
  importantTools: [],            // 额外重要动作，工具名支持 * 通配
  quietTools: [],                // 强制不旁白，优先于 importantTools
  irreversibleBash: [],          // 额外不可逆 bash 规则（字符串 → new RegExp(s, 'i')）
  workspaceRoot: '',             // 空 = 用会话 header.cwd
}
export function normalizeConfig(raw) // → 完整对象；类型错误 throw
```

校验：`narration/gate/interrupt` 必须是 boolean；`children` ∈ 三值；三个数组必须是 string[]；`workspaceRoot` string。
错误示例：`dsh-narrator: config.gate must be a boolean`。

## 4. 分类 `lib/classify.js`（纯函数，可单测，不碰 ctx）

导出：

```js
export function isImportant(toolName, args, cfg)          // → boolean
export function isIrreversible(toolName, args, cfg, ctx)  // → false | { reason: string }
export function describeAction(toolName, args)            // → ≤120 字符的一行摘要，给"已中止：当时在做 X"
export function matchWildcard(pattern, name)              // * 通配
```

规则：

- `quietTools` 命中 → 不重要、不可逆判定也跳过（用户显式静音）。
- 重要动作默认集合（工具名，支持将来扩展）：`write`、`edit`、`bash`、`shell`、`terminal`、`run_command`、
  `plugin_manager`、`subagent`、`subagent_fork`、`workflow`、`spawn_teammate`；
  `schedule_create`、`schedule_update`、`schedule_delete` 仅当 name 以 `schedule_` 且非 `_list` 时重要。
- 不重要默认集合见契约文档同一列表：`read`、`grep`、`glob`、`web_search`、`web_fetch`、`todo_write`、`job_*`、`list_*`、
  `team_task_list`、`team_task_get`、`schedule_list`、`wait_agent`、`list_agents`、`skill`、`present`、`working_directory`、`ask_user_question`、`exit_plan_mode`。
- **未知工具默认算重要动作**（宁可多解释）。
- 不可逆判定（命中即返回 `{reason}`）：
  - `write`/`edit`：`args.file_path` 解析后落在 workspace 根之外（绝对/相对都先 `path.resolve`；
    workspace 根 = `cfg.workspaceRoot` 或 `ctx.cwd`；Windows 路径大小写不敏感：比较前统一 `toLowerCase()`）。
  - `plugin_manager`：`args.action` ∈ `install_bundle`、`remove_bundle`、`set_bundle`。
  - 工具名匹配 `publish|deploy|release`（如 `*_publish`）→ 不可逆。
  - `bash|shell|terminal|run_command`：取 `args.command` 字符串，命中下面任一正则 → 不可逆：
    `rm`、`rmdir`、`unlink`、`mv`、`dd`、`mkfs`、`truncate`、`chmod`、`chown`/`icacls`、`sudo`/`doas`、
    `shutdown`/`reboot`/`poweroff`、`git push`、`git reset --hard`、`git clean -.?f`、`git branch -D`、
    `(npm|pnpm|yarn|bun) (publish|unpublish)`、`(npm|pnpm|yarn|bun) (add|install|i|remove|rm|uninstall)`、
    Windows：`del `、`rd /s`、`Remove-Item`、`Format-Volume`、`Stop-Computer`、`Restart-Computer`、`Set-ExecutionPolicy`。
  - `cfg.irreversibleBash` 里的字符串逐条 `new RegExp(s, 'i')` 追加（非法正则 → normalizeConfig 阶段 throw）。
- `describeAction`：如 `bash: pnpm test`、`write: src/a.ts`、`plugin_manager: install_bundle`；超过 120 字符截断加 `…`。

## 5. 消息构造 `lib/messages.js`

```js
import { randomUUID } from 'node:crypto'
export function contextMessage(text, summary) // → 深冻结的 { id, role:'user', content:[{type:'text',text}], source:{kind:'narrator', form:'notice', summary} }
export function deepFreeze(value)
```

- `id` 用 `randomUUID()`；`form` 只用 `'notice'`。
- 该消息会进模型上下文，所以文本要短（≤400 字符）。

## 6. 状态 `lib/state.js`

- 路径：`process.env.DSH_HOME || path.join(os.homedir(), '.dsh')` → `narrator/state.json`。
- 文件格式：`{ "version": 1, "narration": true, "gate": false, "interrupt": true, "children": "report" }`，
  只存**显式覆盖**的键；`reset` 删除该文件（`unlinkSync` 容忍 ENOENT）。
- 读写都要 try/catch：读损坏 → 返回 `{}` 并 `ctx.logger?.warn`；写失败 → 不抛，warn。
- 写入用 `writeFileSync(tmp)` + `renameSync(tmp, target)`，`mkdirSync(dir,{recursive:true})`。

## 7. 门禁 `lib/gate.js`

`export function createGate({ runtime, logger })` → `{ hooks }`，hooks 是数组：
`[['tools/pre-execute', fn], ['tools/result', fn], ['tools/post-execute', fn], ['agent/pre-step', fn]]`
（`index.js` 负责 `ctx.effect(() => ctx.on(event, fn))`）。

逻辑：

- **per-agent 状态**：`WeakMap<Agent, { turn: number, askedTurn: number, preempted: boolean, activity: string }>`。
  `agent/pre-step` 收到 `{agent, turn, step}` → 若 `turn !== st.turn` 则 `st.turn = turn`、`st.preempted = false`。
- **pre-execute**：先 `await next()`；若下游 decision 不是 `allow` 原样返回。然后：
  - `runtime.settings.gate === false` → 返回下游。
  - `isIrreversible(exec.name, exec.arguments, cfg, { cwd })` 为 false → 下游。
  - 子代理（`agent.session.header.delegationDepth ?? 0 > 0`）→ 返回
    `{ kind:'deny', reason: 'NARRATOR-CHILD-GATE: <原因>。你无法直接询问用户；请停止该动作，把需要用户确认的决策（含原因）写进最终结果交回父代理。' }`
  - root 且 `st.askedTurn === st.turn` → 下游。
  - 否则 `{ kind:'deny', reason:'NARRATOR-GATE: <原因>。先用 ask_user_question 向用户确认，得到答复后再重试这个动作。' }`。
- **tools/result**（emit）：`exec.name === 'ask_user_question'` 且 `!result.isError` 且 `exec.agent` → `st.askedTurn = st.turn`；
  同时记录 `st.activity = describeAction(...)` 对重要动作。
- **tools/post-execute**：先 `await next()`；若 `result.content` 里有文本包含 `'NARRATOR-CHILD-GATE'`，给下游 decision 追加
  `additionalContexts: [contextMessage('你的子代理触发了不可逆动作门禁，需要用户确认。请先向用户说明并询问，得到答复后再重试或调整计划。', 'subagent gate')]`
  （`block` 与 `accept` 两种 decision 都要处理，保留其原字段）。
- 只处理 `exec.agent` 存在的调用（直接 `ctx.tools.execute()` 的调用跳过）。

## 8. 插话 `lib/interrupt.js`

`export function createInterrupt({ runtime, logger, agentState })`（`agentState` 与 gate 共用同一个 WeakMap）→ `{ hooks }`。

- **agent/inbox/inserted**（emit）：`payload = {agent, message}`；
  `runtime.settings.interrupt === false` → 返回；`message.source?.kind !== 'user'` → 返回；`agent.status !== 'running'` → 返回；
  记 `st.activity`（若为空用 `'(未记录)'`），然后
  `agent.cancel({ kind: 'hook', reason: 'narrator: user interjection' }, { keepInbox: true })`，`st.preempted = true`。
  用 try/catch 包住（宿主可能已 dispose）。
- **agent/pre-step**（waterfall）：先 `await next()`；若 `st.preempted` 且 `nextDecision.kind === 'enter'`：
  在 `messages` 前插 `contextMessage('人类在你执行时插话，已中止上一件事（当时：' + st.activity + '）。以用户最新的指示为准；若仍有歧义，先问清楚再继续。', 'interrupted')`，
  清 `st.preempted`，返回 `{ ...nextDecision, messages: [msg, ...nextDecision.messages] }`；否则原样返回。
- 与 gate 的 pre-step 监听器**合并成一个** listener（由 index.js 组装），避免两个 waterfall 都改 messages 时互相覆盖；
  若装成两个 listener，注意 `next()` 链的顺序会处理，但必须都调用 `next()`。

## 9. 旁白提示 `lib/prompt.js`

```js
export function buildPromptText(settings) // → string（旁白关时返回 ''）
```

固定文本（英文，模型按用户语言输出；不要逐字翻译）：

```text
## dsh-narrator policy (enforced by a plugin; follow it exactly)

1. Narrate important actions in plain language. Before a tool call that changes files, runs a command,
   manages plugins, changes schedules, or starts a subagent, write ONE short sentence to the user saying
   what you are about to do and why. When it finishes, write ONE short sentence saying what happened and
   what changed. Do not narrate read-only actions. Use the language of the user's most recent message.
2. Ask instead of guessing. If the goal is ambiguous, several reasonable approaches exist, a required
   detail is missing, or an operation keeps failing, call ask_user_question before proceeding.
3. The newest instruction wins. If the user writes while you are working, drop the current plan and
   follow the new instruction.
4. Gated irreversible actions. If a tool call is denied with NARRATOR-GATE, do not retry it directly:
   first call ask_user_question, then retry only after the answer.
```

- 第 3 条仅 `settings.interrupt === true` 时包含；第 4 条仅 `settings.gate === true` 时包含；
  第 1 条仅 `settings.narration === true` 时包含；全关时返回 `''`。

## 10. `/narrator` 命令 `lib/command.js`

```js
export function createCommand({ runtime, persist }) // → { definition: {name:'narrator', description, input:{hint}, handler}, }
```

- `handler({ agent, rawInput })` → `{ kind:'success'|'error', text }`（`rawInput` 可能含前后空白）。
- 子命令：
  - 空 / `status` → 多行状态（中文为主 + 英文关键词）：
    ```
    Narrator 状态 / status
    - 旁白 narration: on
    - 不确定先问 gate: on
    - 插话即停 interrupt: on
    - 子代理 children: report
    来源: /narrator 覆盖 / config / 默认
    ```
    来源逐项判断：override 里显式有该键 → `/narrator`；否则 config 里显式写过 → `config`；否则 `默认`。
  - `on` / `off` → 三开关一起置 true/false（写 overrides 三个键 + 持久化）。
  - `narration|gate|interrupt on|off` → 单项。
  - `children report|soft|off` → 子代理策略。
  - `reset` → 清空 overrides + 删除状态文件。
  - 其他 → `{kind:'error', text:'用法: /narrator status | on | off | narration on|off | gate on|off | interrupt on|off | children report|soft|off | reset'}`。

## 11. 测试（core 负责，`node --test`）

每个测试用 `node:test` + `node:assert/strict`；不联网、不写真实 `$DSH_HOME`（`state` 测试用 `os.tmpdir()` + `process.env.DSH_HOME` 覆盖后还原）。
至少覆盖：

1. `classify`：重要/静音/未知工具、bash 不可逆与安全命令、workspace 内/外写入、Windows 路径大小写、`describeAction` 截断。
2. `config`：默认值、每个非法字段 throw。
3. `state`：保存/读取/损坏文件/reset。
4. `gate`：root 未问过 → deny；问过后（tools/result）→ allow；换 turn 重置；子代理 → CHILD-GATE；post-execute 标记传播；只处理有 agent 的调用。
5. `command`：status/on/off/单开关/children/reset/非法用法。
6. `plugin`：`apply` 用 fake ctx（见下）注册了 1 个 prompt context、≥4 个 on 监听、1 个命令；返回的 disposer 都被调用（fake ctx 记录）。

fake ctx 参考：

```js
function fakeCtx() {
  const disposers = [], registered = { contexts: [], listeners: [], commands: [] }
  const ctx = {
    logger: { warn() {}, info() {} },
    systemPrompt: { context: c => { registered.contexts.push(c); const d = () => {}; disposers.push(d); return d } },
    commands: { register: c => { registered.commands.push(c); const d = () => {}; disposers.push(d); return d } },
    on: (event, fn) => { registered.listeners.push({ event, fn }); const d = () => {}; disposers.push(d); return d },
    effect: (fn, label) => { const r = fn(); disposers.push(typeof r === 'function' ? r : () => {}); return () => {} },
  }
  return { ctx, registered, disposers }
}
```

## 12. 代码风格

- 每行 ≤ 120 字符；无分号强制；用单引号；2 空格缩进。
- 所有 hook 回调包 try/catch（`ctx.logger.warn` 记录），绝不让插件异常打断工具流水线；
  **除** `pre-execute` 里我们主动返回 deny 之外。
- 不写 `console.log`。
