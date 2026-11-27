---
name: codex-review
description: 调用本地 codex-cli（GPT）对当前工作区的未提交改动、分支差异或指定提交执行只读代码审查或对抗性审查。当用户要求“让 Codex 做代码审查”、“让 GPT 帮我挑刺”、“执行对抗性 review”时使用。
---

# Codex 代码审查与对抗性审查流程

利用 `codex-bridge_codex-bridge` 的 `codex_review` 工具，以不同模型视角（OpenAI GPT）为当前代码提供独立的第二意见。

## 使用规范

1. **确定审查范围与预设**
   - 审查本地未提交改动（默认）：`mode: "uncommitted"`
   - 对比基准分支（如 PR 前检查）：`mode: "base"` + `base_branch: "main"`（按实际主干分支名调整）
   - 审查特定提交：`mode: "commit"` + `commit_sha: "<sha>"`
   - **常规审查**：直接调用 `codex_review`（`reasoning_effort: "medium"`）。
   - **对抗性审查（Adversarial Review）**：传 `preset_id: "adversarial-review"` 与 `reasoning_effort: "high"`，自动注入严格挑刺审查模板，重点排查逻辑漏洞、边界条件、并发竞态、异常处理遗漏和安全风险。

2. **省 Token 实时直播流程**
   - 推荐传 `background: true` 拿到 `job_id` 后，立即调用 `open_codex_console(focusTab: "monitor", jobId: <job_id>)` 打开右侧指挥台，再调用 `codex_job_status(job_id: <job_id>, wait_sec: 90)` 长等待直至审查完成。

3. **汇总与闭环**
   - 收到审查结果后，不要机械照搬所有建议；结合你对项目上下文的理解，先过滤误报，再把真正有价值的问题按优先级呈现给用户，并询问是否由你或通过 `codex_exec` 修复。
