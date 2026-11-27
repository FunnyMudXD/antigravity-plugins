---
name: call-gpt
description: >-
  当用户显式使用本技能（如 call-gpt），或在对话中明确要求“调用 GPT”、“用 GPT 写/改/查/审”、“让 Codex 干活”、“交给 GPT 处理”时触发，通过本地 codex-bridge MCP 自动调度本机 codex-cli（GPT）执行任务。若用户未提及 GPT 或 Codex，严禁主动触发本技能。
---

# 调用 GPT（Codex CLI）执行任务

本技能用于将用户的明确请求自动路由给本机已安装的 `codex-cli`（OpenAI GPT），并由 Antigravity 主模型负责前置拆解、过程直播与最终验收。

> **触发边界**：仅在用户显式启用本技能或明确提出调用 GPT / Codex 时使用；普通开发任务中未提及 GPT / Codex 时，保持由 Antigravity 主模型直接处理，不要调用以下工具。
>
> **严禁越俎代庖**：一旦用户通过本技能要求由 GPT 写代码、修 Bug 或重构，主模型只负责前期调研与最终验收，**禁止自己顺手直接修改业务代码**，必须通过 `codex_exec` / `codex_resume` 交由 GPT 执行。

## MCP 服务与工具速查

所有工具均通过 `call_mcp_tool` 调用，固定 `ServerName` 为 **`codex-bridge_codex-bridge`**：

| ToolName | 用途 | 核心参数 |
| :--- | :--- | :--- |
| `codex_exec` | 派发编码、重构、排障或只读调研任务给 GPT | `prompt` (必填), `cwd` (必填), `conversation_id` (推荐传当前对话 ID 实现监工隔离), `sandbox` (`read-only`\|`workspace-write`), `reasoning_effort` (`low`\|`medium`\|`high`), `skills` (技能名数组，如 `["rpx-to-ureport"]`), `add_dirs` (可选额外可写目录), `preset_id`, `model`, `worktree`, `background`, `timeout_sec`, `skip_git_repo_check` |
| `codex_resume` | 基于已有会话继续追问或要求返工 | `prompt` (必填), `cwd` (必填), `thread_id` (或 `use_last: true`), `conversation_id` (留空自动继承), `model`, `reasoning_effort`, `background` |
| `codex_review` | 让 GPT 执行只读代码审查 / 对抗性审查 | `cwd` (必填), `conversation_id`, `mode` (`uncommitted`\|`base`\|`commit`), `base_branch`, `commit_sha`, `skills`, `prompt`, `model`, `reasoning_effort`, `background` |
| `codex_job_status` | 查询/长等待后台任务进度、时间线与结果 | `job_id`, `wait_sec` (推荐 `90`，任务完成时立即返回，避免空轮询) |
| `codex_job_cancel` | 强制终止运行中的后台任务 | `job_id` (必填) |
| `codex_job_rollback` | 按任务前无侵入 Git 快照精准回滚单次 GPT 改动 | `job_id` (必填), `force` (可选，默认 `false`，存在二次手工修改冲突时先拦截提示) |
| `codex_doctor` | 检查本机 `codex-cli` 安装与登录健康度 | 无 |
| `open_codex_console` | 在右侧边栏打开可视化 Codex 指挥台 | `focusTab` (`dispatch`\|`monitor`\|`settings`), `jobId`, `cwd`, `conversation_id` (传入当前对话 ID，右侧边栏默认仅看本对话任务) |

## 标准化高效执行流程

1. **前置摸底、技能透传与收窄边界（防止 GPT 过度防御）**
   - 自动获取当前工作区绝对路径作为 `cwd`；先快速读取关键文件，明确具体涉及的文件路径、改动目标、禁止触碰的边界和验证命令。
   - **主对话技能双保险透传**：若本轮对话激活了其他领域技能（如 `rpx-to-ureport`、`runqian-ureport-dev`、`gssy-phase2` 等），调用 `codex_exec` / `codex_review` 时必须同时做到两点：
     1. 通过结构化参数传入 `skills: ["<skill-name>"]`（服务端会自动解析并注入 `SKILL.md`、`scripts/`、`references/` 的只读绝对路径及 `$skill-name` 标记，**不**开放公共技能目录写权限）；
     2. 在 `prompt` 中专门提炼该技能的**核心红线摘要**（命名规则、输出路径、禁止事项），避免 GPT 漏读细则。
   - 仅在确需跨目录写入（如多仓库联调）时才显式传 `add_dirs`，不要把公共技能目录传进 `add_dirs`。
   - **写码任务必带“非交互直接落盘”声明**：在发给 `codex_exec` 的 `prompt` 开头或结尾明确写明：
     > 你当前运行在非交互式 `codex exec` 环境中。不要向用户反问确认，不要只输出文字建议而不修改文件；请在上述明确的文件范围内直接完成代码修改并运行验证命令。
   - **按难度动态选 `reasoning_effort`**：简单局部改动用 `low` 或 `medium` 提速；复杂架构排障、多文件重构或对抗性审查用 `high`。

2. **省 Token 实时直播派单模式（自动按对话隔离，返工必同步）**
   - 无论是首次派发 `codex_exec` / `codex_review`，还是后续任意一轮 `codex_resume` 返工，都默认传 **`background: true`** 以及当前上下文中的 **`conversation_id`**（可选附带简短 `conversation_title`），立即获取新的 `job_id`；
   - **每轮拿到新的 `job_id` 后，都必须立刻再次调用** `open_codex_console(focusTab: "monitor", jobId: <新job_id>, cwd: <当前工作区绝对路径>, conversation_id: <当前对话ID>)`（即便上一轮已打开过面板，返工时也必须再次调用以刷新对话绑定并聚焦新任务）；
   - 然后调用 **`codex_job_status(job_id: <job_id>, wait_sec: 90)`** 挂起等待结果（任务结束瞬间即刻返回，无需高频空轮询；若 90 秒后仍在运行再继续调用一次）。

3. **复杂多轮任务自动隔离上下文**
   - 如果预计任务涉及大量文件或多轮反复返工，可将整个“派单 → 验收 → 返工”闭环委派给 `codex-worker` 子代理，避免中间日志撑爆主对话上下文。

4. **主模型验收、安全回滚与“只说不做”自动追单**
   - `codex_job_status` 返回时已自动附带真实 `changedFiles` 和 `gitDiffStat`，主模型结合 `git diff`、挂载技能红线与测试结果亲自验收。
   - **防防御兜底**：如果任务类型是写代码（`workspace-write`），但完成后发现 `changedFiles` 为空、GPT 只回复了文字方案，不要直接草率结束，立即拿该次返回的 `threadId` 调用 `codex_resume` 明确指令：“方案已确认，请直接把上述改动落盘写入对应文件并跑通测试。”
   - **安全回滚**：若用户回滚了主对话并希望撤回 GPT 写入磁盘的改动，或验收不满意需要退回任务前状态，先通过 `codex_job_status` 确认目标 `job_id`，再调用 `codex_job_rollback(job_id: <job_id>)` 精准还原（保留用户原有未提交修改；若提示二次手工修改冲突，先向用户确认后再决定是否 `force: true`）。

5. **异常处理**
   - 若工具返回找不到 `codex`、超时或登录态失效，先调用 `codex_doctor` 获取准确诊断，再把原因和修复命令告知用户。
