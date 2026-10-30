# dsh-narrator ｜ 旁白

> 给 DSH（DeepSeek Harness）的 Agent 加一层"保镖"：**重要动作前后先用白话说明、不确定时先问再动手、执行中你一插话它立刻停下照你说的做。**

---

## 它解决什么

默认情况下，Agent 会不会解释、要不要问、能不能中途改向，全看模型自己的判断。这个插件把三件事变成"一定会发生"的政策层（不再依赖模型心情）：

| 行为 | 机制 | 效果 |
| --- | --- | --- |
| **重要动作旁白** | 系统提示里一段固定策略（cache-safe，不破坏前缀缓存） | 写文件、跑命令、装插件、改定时、派子代理之前，先用一句白话说明"要做什么、为什么"；做完再说一句"结果如何" |
| **不确定先问** | 提示词要求自评 + `tools/pre-execute` 硬门禁 | 不可逆动作会被拦下，直到模型真的用 `ask_user_question` 问过你；同一个 turn 问过一次即可复用 |
| **插话即停** | 监听你本人的新消息 → 取消当前 turn | 你在它干活时发一句话，它会停下手上的事，以你的最新指示开启新回合，并说明"已中止什么" |

## 安装

### 方式一：Web 界面（推荐）

1. 打开 DSH Web，左侧 **Plugins（插件）** 页
2. **Add plugin（添加插件）**，填 `dsh-narrator`（或 GitHub 源 `github:Chasterccj/dsh-narrator`）
3. 安装完成后确认 bundle 已启用；若没有立即生效，重启一次 DSH

### 方式二：命令行

```bash
dsh plugin --profile web add dsh-narrator
# 或从 GitHub 装：
dsh plugin --profile web add github:Chasterccj/dsh-narrator
```

`dsh plugin` 只负责把包装进 profile；装完到 Web 的 **Plugins** 页确认 bundle 已选中（首次可能需要重启一次）。

## 配置

在 profile 的 `cordis.patch.yml` 里给 `narrator` 行加 `config`（也可以直接改 profile 的 patch 文件）：

```yaml
- id: narrator
  name: dsh-narrator
  config:
    narration: true          # 重要动作旁白
    gate: true               # 不确定先问（硬门禁）
    interrupt: true          # 插话即停
    children: report         # 子代理策略：report | soft | off
    importantTools: []       # 额外重要动作，工具名支持 * 通配
    quietTools: []           # 强制不旁白（优先于 importantTools）
    irreversibleBash: []     # 额外不可逆命令正则（字符串）
    workspaceRoot: ""        # 空 = 用会话 cwd
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `narration` | `true` | 重要动作前/后各一句白话说明 |
| `gate` | `true` | 不可逆动作先问用户才放行 |
| `interrupt` | `true` | 用户在执行中发消息 → 取消当前 turn |
| `children` | `report` | 子代理命中不可逆动作时：`report` 挡下并交回父代理；`soft` 只放行；`off` 关闭 |
| `importantTools` | `[]` | 追加重要动作工具名（`*` 通配） |
| `quietTools` | `[]` | 强制静音的工具（优先级最高，同时关闭该工具的硬门禁） |
| `irreversibleBash` | `[]` | 追加不可逆 shell 正则（不区分大小写） |
| `workspaceRoot` | `""` | 工作区根；空则用会话 cwd。写入落在根之外视为不可逆 |

### 默认重要动作

`write`、`edit`、`bash`/`shell`/`terminal`/`run_command`、`plugin_manager`、`subagent`、`subagent_fork`、`workflow`、`spawn_teammate`、`schedule_create`/`schedule_update`/`schedule_delete`。
**未知工具默认也算重要动作**（宁可多解释一句）；`read`/`grep`/`glob`/`web_search`/`todo_write`/`job_*`/`list_*` 等只读与协调类工具不旁白。

### 默认不可逆动作（硬门禁）

- **写文件**：`write`/`edit` 的目标路径解析后落在工作区根之外
- **插件**：`plugin_manager` 的 `install_bundle` / `remove_bundle` / `set_bundle`
- **发布类工具**：工具名含 `publish` / `deploy` / `release`
- **命令**：`rm`、`rmdir`、`unlink`、`mv`、`dd`、`mkfs`、`truncate`、`chmod`、`chown`/`icacls`、`sudo`/`doas`、关机/重启、`git push`、`git reset --hard`、`git clean -f`、`git branch -D`、`npm|pnpm|yarn|bun publish`、`npm|pnpm|yarn|bun add|install|remove`、Windows 的 `del` / `rd /s` / `Remove-Item` / `Format-Volume` / `Stop-Computer` / `Restart-Computer` / `Set-ExecutionPolicy`

命中后模型不会直接执行：它必须先调用 `ask_user_question` 向你确认，答复后重试才放行（同一个 turn 问一次即可）。

## `/narrator` 命令

```
/narrator status                      # 查看三个开关、子代理策略与来源
/narrator on | off                    # 三个行为一起开关
/narrator narration on|off
/narrator gate on|off
/narrator interrupt on|off
/narrator children report|soft|off
/narrator reset                       # 清除命令覆盖，回到配置默认值
```

命令的覆盖值会持久化到 `$DSH_HOME/narrator/state.json`（Windows 一般是 `%USERPROFILE%\.dsh\narrator\state.json`），重启后保留；`/narrator reset` 删除该文件。

## 子代理 / Agent Teams

子代理（subagent、teammate）**无法直接向用户提问**（DSH 限制）。所以 `children: report`（默认）时：

1. 子代理命中不可逆动作 → 被挡下，并被告知把"需要用户确认的决策"写进最终结果交回父代理；
2. 父代理收到带 `NARRATOR-CHILD-GATE` 标记的结果时，会收到一条上下文提示：**先向用户确认再重试或调整计划**。

## 卸载

```bash
dsh plugin --profile web remove dsh-narrator
```

然后在 Web **Plugins** 页确认 bundle 已移除；状态文件可手动删除：`$DSH_HOME/narrator/state.json`。

---

## English quick start

`dsh-narrator` is a host-only DeepSeek Harness bundle that makes an agent:

1. **narrate important actions** (file writes, commands, plugin changes, schedules, subagents) in one plain-language sentence before and after doing them;
2. **ask instead of guessing** — irreversible calls are denied by `tools/pre-execute` until the model has asked the user via `ask_user_question` in the same turn;
3. **follow your newest instruction** — a user message during a running turn cancels that turn and the next turn opens with a short "what was interrupted" notice.

Install (DSH `>= 0.2.1-rc.2 < 0.3.0`):

```bash
dsh plugin --profile web add dsh-narrator
# or from GitHub:
dsh plugin --profile web add github:Chasterccj/dsh-narrator
```

Then enable the bundle in the Web **Plugins** page (restart once if needed), and manage it with `/narrator status | on | off | gate on|off | interrupt on|off | children report|soft|off | reset`.

No network access, no runtime dependencies, no build step. Config and limitations are documented in the sections above.
