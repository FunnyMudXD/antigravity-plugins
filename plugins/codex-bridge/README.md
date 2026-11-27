# Codex Bridge（Antigravity 插件）

`codex-bridge` 是一个原生 Antigravity 插件，通过本地 MCP Server 包装你本机已安装的 `codex-cli`，让 Antigravity 主模型与你本人都可以方便地指挥 OpenAI GPT（Codex）执行编码、重构、排障和代码审查任务，并提供内置的可视化配置与任务指挥台（MCP App）。

## 核心能力

- **可视化双形态指挥台**：支持在对话右侧边栏（`aux_pane`）常驻监工，也支持从左侧导航栏（`global`）全屏打开进行集中配置与任务管理。
- **双模式任务派发**：既自动同步 Antigravity 主模型委派的 Codex 任务，也支持在面板里手动填表直发任务。
- **插件独立配置与预设模板**：配置保存在 Antigravity 的 `${PLUGIN_DATA}/config.json`，不修改 `~/.codex/config.toml`。内置 4 套常用预设（只读调研、日常写码、Worktree 隔离大改、对抗性代码审查）。
- **结构化时间线与一键验收**：实时展示 Codex 执行步骤、耗时和改动文件（点击文件路径可直接调用 Antigravity 打开该文件），支持面板内直接 `codex resume` 返工，或一键发回主对话请 Antigravity 主模型做 `git diff` 验收。

## 目录结构

- `plugin.json`：插件元信息
- `mcp_config.json`：MCP Server 启动配置
- `server/`：零外部依赖的 Node.js stdio MCP Server 及 `codex-cli` 执行封装
- `ui/`：基于 `@modelcontextprotocol/ext-apps` 构建的单文件 MCP App 前端
- `skills/`：指导主模型派单与审查的标准 SOP
- `agents/`：用于隔离复杂多轮 Codex 交互的子代理
- `tests/`：Node.js 端到端协议与功能测试

## 重新构建前端与运行测试

```powershell
cd plugins/codex-bridge
npm install
npm run build:ui
npm test
```
