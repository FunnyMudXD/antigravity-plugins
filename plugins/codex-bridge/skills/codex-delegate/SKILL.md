---
name: codex-delegate
description: 将代码编写、重构、排障或只读调研任务委派给本地 codex-cli（GPT）执行，并由 Antigravity 主模型负责拆解需求、跟踪进度与最终验收。当用户要求“让 Codex 干活”、“把任务交给 GPT 实现”、“打开 Codex 指挥台”或希望跨模型协同开发时使用。
---

# Codex 任务派发与验收流程

你作为 **Antigravity 主模型（架构师与验收者）**，负责通过 `codex-bridge` MCP 工具调度本机 `codex-cli`（GPT）完成具体实现，但始终由你把控整体质量。

## 标准协作流程

1. **先摸底，再派单**
   - 在调用 `codex_exec` 之前，先自己读取关键文件、明确需求边界、涉及的文件范围以及验收标准（例如需要跑通哪条测试命令）。
   - 给 Codex 的 `prompt` 必须清晰、自包含，写明目标、禁止改动的边界以及期望的验证步骤，避免丢给它一句含糊的话。

2. **按风险选择合适的沙箱与模式**
   - 纯代码分析、根因排查、方案对比：传 `sandbox: "read-only"`（或使用 `preset_id: "readonly-research"`）。
   - 日常功能开发、Bug 修复：传 `sandbox: "workspace-write"`（或 `preset_id: "daily-coding"`）。
   - 高风险重构、实验性改造：传 `sandbox: "workspace-write"` + `worktree: true`（或 `preset_id: "worktree-refactor"`）。
   - 为方便用户在右侧「Codex 指挥台」实时观看你下达的指令与 GPT 的执行时间线，无论是首次 `codex_exec` / `codex_review`，还是后续任意一轮 `codex_resume` 返工，都默认传 `background: true` 并带上当前上下文的 `conversation_id`；拿到新的 `job_id` 后，**每轮都必须立刻再次调用** `open_codex_console(focusTab: "monitor", jobId: <新job_id>, cwd: <当前工作区绝对路径>, conversation_id: <当前对话ID>)` 重新同步对话绑定并聚焦到新任务，再调用 `codex_job_status(job_id: <job_id>, wait_sec: 90)` 长等待直至完成（避免反复空轮询浪费 Token）。
   - 如果本轮任务涉及其他领域技能（如 `rpx-to-ureport`、`gssy-phase2` 等），在调用 `codex_exec` 时传入 `skills: ["<skill-name>"]`（由服务端自动注入只读路径与脚本清单），并在 `prompt` 中提炼核心红线摘要。
   - 给 GPT 派发写码任务时，在 `prompt` 中明确声明“当前为非交互式环境，请勿反问确认或仅输出建议，直接在限定文件范围内落盘修改并验证”，并按任务复杂度选择 `reasoning_effort`（`low`/`medium`/`high`）。如果返回结果中 `changedFiles` 为空且只给出了文字建议，立即用 `threadId` 调 `codex_resume` 要求直接落盘。

3. **必须亲自验收，禁止盲信口头汇报**
   - Codex 执行完成后，检查它返回的 `changedFiles` 和 `lastMessage`，并由你亲自查看工作区的 `git status` / `git diff` 以及关键测试结果。
   - 如果发现遗漏、边界问题或风格偏差，拿着该次任务返回的 `threadId` 调用 `codex_resume` 下达精准返工指令，不要另起新会话丢失上下文；若需要直接撤回该次 GPT 改动（如主对话回滚后清理磁盘改动），可调用 `codex_job_rollback(job_id: <job_id>)` 按任务前无侵入 Git 快照安全还原。

4. **环境异常处理**
   - 如果调用失败提示找不到 `codex` 或登录态失效，先调用 `codex_doctor` 诊断，并将具体原因和修复指引（例如运行 `codex login`）告知用户。
