# dsh-narrator 设计文档

状态：待用户核可（核可后才开始实现）
日期：2026-10-30
目标 DSH：`>=0.2.1-rc.2 <0.3.0`（本机 0.2.1-rc.2）

## 1. 一句话

给 DSH 加一层“保镖”：重要动作前先用白话说明、不确定时先问人、你中途插话时立刻停下照你说的做。

## 2. 背景与痛点

用户原话：**“它闷头跑，来不及插手。”** 现状（已核实）：

- 模型在工具前后会不会解释，全看它心情；Web 只显示工具卡片，没有保证。
- `ask_user_question` 工具存在、会停下来等人答，但“要不要问”是模型自己决定，会漏问。
- Web 忙碌时 Enter 默认 `queue`（等这轮跑完才读你的话），`steer` 也只在下个 step 边界生效；**没有任何东西会中止正在跑的 turn**。

所以本插件不新增能力，而是把三件事从“看模型心情”变成“一定有”（保底/政策层）。

## 3. 目标 / 非目标

### 目标

1. 重要动作前 + 后各一句白话旁白（模型自己说，进聊天串流）。
2. 不确定时先问；不可逆动作**硬挡**到问过为止（同 turn 问一次即可复用）。
3. 用户在执行中插话 → 立刻 `cancel` 当前 turn，以新指示开新 turn，并交代“已中止什么”。
4. 子代理/队友：不可逆动作挡下并要求把决策带回父代理，父代理收到提示后转问用户。
5. 纯 JS、Host-only bundle，可 `npm publish` + GitHub，Windows 实测、Linux/macOS CI 验证。

### 非目标

- 不做 Web UI 页面/工具卡装饰（纯后端；旁白走聊天串流）。
- 不做“每次工具都讲”，只讲重要动作（省 token）。
- 不额外调用小模型生成旁白（零额外 LLM 成本）。
- 不做 macOS 实机验证（CI 三平台代替）。
- 不硬挡子代理（技术上做不到：子代理无法调用 `ask_user_question`）。

## 4. 用户已拍板的决定

| # | 决定 |
|---|---|
| 1 | 主痛点：闷头跑、来不及插手 |
| 2 | 不确定判定：混合（模型自评 + 外挂规则兜底） |
| 3 | 插话即停：默认做，可配置关 |
| 4 | 旁白：只讲重要动作；**省 token 方案**（不注入额外旁白 context，只靠提示词） |
| 5 | 发布：GitHub `Chasterccj/dsh-narrator`，npm 发布 `dsh-narrator`，MIT |
| 6 | 硬挡范围：不可逆清单；同 turn 问过可复用 |
| 7 | 插话边界：只认用户本人；问答回复不算；停后说明原任务；等问答时新输入 = 新指令并取消问题 |
| 8 | v1 纯后端，设置走 Config；加 `/narrator` 命令即时开关 |
| 9 | 子代理：(c) 最危险动作挡下并带回父代理，父代理被提示转问 |
| 10 | 文档/界面语言：`zh`（简体）+ `en`；README 简中为主 + 英文快速上手 |
| 11 | macOS 不做实机验证，CI 验证；Windows 由用户实测 |

## 5. 行为规格

### 5.1 旁白（narration）

- 机制：`ctx.systemPrompt.context()` 注册一段**固定**提示（cache-safe，追加在历史之后），要求模型：
  - 调用“重要动作”前，用一句白话（跟随用户最近消息的语言）说明“要做什么、为什么”；
  - 完成后用一句说明“结果、影响”；
  - 读类动作不旁白。
- 不注入任何 per-tool 旁白 context（省 token 的方案）。
- 重要动作默认清单（可配置增减）：
  - 文件改动：`write`、`edit`
  - 命令执行：`bash`（以及 `shell`/`terminal` 等同义工具名）
  - 插件/环境：`plugin_manager`
  - 派活：`subagent`、`subagent_fork`、`workflow`、`spawn_teammate`
  - 计划/定时改动：`schedule_create`、`schedule_update`、`schedule_delete`
- 读取/杂项不旁白：`read`、`grep`、`glob`、`web_search`、`todo_write`、`job_*`、`list_*`、`skill`、`present`、`working_directory` 等。
- 局限（已告知）：Host 端无法在工具调用“前”注入 context，旁白只能靠提示词保证，非 100%。

### 5.2 不确定先问（gate）

- 软层：提示词要求遇到“目标模糊 / 多个合理做法 / 缺关键参数 / 同一操作连续失败”时先 `ask_user_question`。
- 硬层：`tools/pre-execute` 命中**不可逆清单**且本 turn 尚未问过 → `deny`，反馈写明：
  `NARRATOR-GATE：这是不可逆动作（<原因>）。先用 ask_user_question 向用户确认；得到答复后重试。`
  模型问过之后（`tools/result` 里看到成功的 `ask_user_question`）标记本 turn `asked=true`，重试放行。
- 不可逆默认清单（可配置）：
  - bash 命中：`rm`/`rmdir`、`mv`、`dd`、`mkfs`/`format`/`truncate`、`chmod`/`chown`、`sudo`、关机重启、`git push`、`git reset --hard`、`git clean -f`、`git branch -D`、`npm|pnpm publish`、包安装/移除（`npm|pnpm|yarn add|install|remove`）。
  - `write`/`edit` 的路径解析后落在 workspace 根之外。
  - `plugin_manager` 的 `install_bundle` / `remove_bundle`。
- 子代理/队友（非 root agent）：不 deny 到“先问”，而是否定并写明：
  `NARRATOR-CHILD-GATE：你无法直接问用户；请停止该动作，把需要用户确认的决策写进最终结果交回父代理。`
  父代理一侧：若工具结果里出现 `NARRATOR-CHILD-GATE` 标记 → `tools/post-execute` 附一条 context 提醒父代理“先问用户再重试”。
- 硬挡只压 root agent；子代理走上面的带回流程。

### 5.3 插话即停（interrupt）

- 监听 `agent/inbox/inserted`：当 `message.source.kind === 'user'` 且 `agent.status === 'running'`：
  1. 记录“正在做什么”（最近一次重要动作的一行摘要，内存里维护）；
  2. `agent.cancel({ kind: 'hook', reason: 'narrator: user interjection' })` **清空 inbox**（含所有尚未处理的排队消息——“最新指示优先”）；
  3. 立即 `agent.followup(message)` 把**同一句话**重新作为唤醒输入送回。为什么不能只 `keepInbox`：DSH 在 `send()` 插入前先算好 `wakeAfterAbort`，并故意忽略由 inbox 事件重入触发的取消唤醒；只保留 inbox 会让消息永远停在队列里（已实测踩坑）。此刻信号已中止，`followup` 会正确 latch 唤醒，取消收敛后自动开新回合；
  4. 标记 preempt；用 `redelivering` guard 挡住重送自己触发的 `agent/inbox/inserted` 重入。
- 下一次 `agent/pre-step`（新 turn 第一 step）：prepend 一条 context：
  `人类在你执行时插话，已中止上一件事（当时：<摘要>）。以用户最新指示为准；如仍有歧义先问清楚。`
- 不算插话：`ask_user_question` 的问答回复、定时/系统注入、队友消息、插件自己的 context（用 `source.kind` 区分）。
- 等问答时用户新输入：取消当前 turn（连带取消问题），按新指令处理（上面流程已覆盖）。
- 局限：只到 turn 级；同进程工具 body 无法硬杀（bash 会收到 abort 自行收敛）。

## 6. 架构

### 6.1 形态

- Host-only bundle，纯 ESM JavaScript，无构建步骤、无运行时依赖、无原生模块。
- `package.json`：`dsh.bundle.patch`、`exports`（`.`、`./cordis.patch.yml`、`./locale/*.json`、`./icon`）、`files`、`engines.dsh`、`peerDependencies` + `devDependencies`（运行时用到的 `@deepseek-ai/dsh-*`）。
- `cordis.patch.yml` 插入一行 `id: narrator`，`name: dsh-narrator`。

### 6.2 事件/钩子使用

| 用途 | 钩子 | 说明 |
|---|---|---|
| 旁白 | `ctx.systemPrompt.context()` | 固定提示，注册/注销随开关 |
| 硬挡 | `tools/pre-execute` | classify → allow/deny |
| 记录已问 | `tools/result` | 观察成功的 `ask_user_question` |
| 子代理带回提示 | `tools/post-execute` | 结果含 `NARRATOR-CHILD-GATE` 时附 context |
| turn 状态 | `agent/pre-step` | 重置 asked、prepend 中止说明 |
| 插话检测 | `agent/inbox/inserted` + `agent/status` | 只认 `source.kind==='user'` |
| 命令 | `ctx.commands.register()` | `/narrator` |

### 6.3 模块划分（lib/）

- `index.js`：插件入口、Config、资源注册/清理。
- `classify.js`：重要动作 / 不可逆判定（工具名 + bash 命令 + 路径）。
- `prompt.js`：提示词文本（en/zh 选择）。
- `gate.js`：pre/post-execute 逻辑与 turn 状态机。
- `interrupt.js`：插话取消与 pre-step 编排。
- `state.js`：运行开关持久化（`$DSH_HOME/narrator/state.json`，原子写）。
- `command.js`：`/narrator` 子命令解析与文案。
- `lib/locale/en.json`、`zh.json`：`meta.title`/`meta.description`。

### 6.4 配置（schemastery `Config`）

```yaml
- id: narrator
  name: dsh-narrator
  config:
    narration: true        # 旁白开关
    gate: true             # 硬挡开关
    interrupt: true        # 插话即停开关
    children: report       # report | soft | off（子代理策略）
    importantTools: []     # 额外重要动作（工具名通配）
    quietTools: []         # 强制不旁白的工具（通配）
    irreversibleBash: []   # 额外不可逆 bash 正则
    workspaceRoot: ""      # 缺省从会话 cwd 推断
```

运行开关优先级：`/narrator` 覆盖（持久化） > Config > 内置默认。`/narrator reset` 清除覆盖。

### 6.5 `/narrator` 命令

```
/narrator status           # 当前三开关 + 覆盖来源
/narrator on | off         # 总开关（三行为一起）
/narrator narration on|off
/narrator gate on|off
/narrator interrupt on|off
/narrator children report|soft|off
/narrator reset            # 清覆盖，回 Config
```

## 7. 打包与发布

- 版本 `0.1.0`，MIT，仓库 `https://github.com/Chasterccj/dsh-narrator`，npm 包名 `dsh-narrator`。
- 文件：`lib/*`、`cordis.patch.yml`、`locale/*`、`icon.svg`、`README.md`、`LICENSE`、`CHANGELOG.md`、`docs/design.md` 不发布（放仓库）。
- 安装：`dsh plugin add dsh-narrator`（npm）；或 GitHub：`dsh plugin add github:Chasterccj/dsh-narrator`。
- README（简体中文为主 + 英文 quick start）：三件事、安装、配置、命令、重要动作/不可逆清单、子代理行为、平台支持、隐私（不联网、不外发）。
- CI：`.github/workflows/ci.yml`，ubuntu/windows/macos × Node 22/24，跑 `node --test` + `npm pack --dry-run`。
- 发布需要用户 `npm login`（本机当前未登录）。

## 8. 验证

1. `node --test` 单测：分类规则、命令解析、Config 校验、状态读写、gate 状态机。
2. CI 三平台矩阵绿。
3. 本机（Linux）安装验证：`plugin_manager install_bundle`（绝对路径）→ 插件行 enabled、无 diagnostic、`/narrator status` 可见。
4. 行为实测：旁白/硬挡/插话需要真实对话触发，由用户在装好后实测；我提供测试脚本与预期。
5. Windows：用户在 Windows 机器 `dsh plugin add dsh-narrator` 实测；macOS 仅 CI。
6. 发布后核对 `npm view dsh-narrator` 与 GitHub release。

## 9. 风险与回退

| 风险 | 处理 |
|---|---|
| 提示词旁白不保证 100% | 已在文档写明；/narrator off 可关 |
| 硬挡导致模型反复 deny 循环 | deny 反馈明确给出“先 ask 再重试”；同 turn 复用；可关 |
| 插话取消打断长任务（半途文件） | 用户拍板接受；`/narrator interrupt off` 可关 |
| 与 repeat-tool-reminder 等插件叠加 | 只追加 context，不冲突 |
| PTC 模式下子调用路径 | hooks 对 PTC 子调用照常触发（安装后验证，列未验证项） |
| 平台差异（路径/换行） | 只用 `node:` 内建，`node:path` 处理路径，JSON 无 BOM |

## 10. 我的裁量项（记录，可推翻）

1. 重要动作默认包含 `bash` 全部（命令执行对用户最不透明）；只读命令也不排除，宁可多讲一句。
2. 旁白提示固定文本，按 `/narrator` 开关注册/注销；不按语言双份。
3. 运行开关持久化到 `$DSH_HOME/narrator/state.json`（跨会话保留），`/narrator reset` 清除。
4. 子代理默认 `report`（最危险动作才挡）。
5. 不写 Web UI；不做图标以外的视觉资源。
6. 明早先本地安装、后发布；发布前需要用户 npm 登录。

## 11. 待用户提供

- npm 登录（或在发布步骤时授权方式）。
- Windows 实机测试（发布后）。
