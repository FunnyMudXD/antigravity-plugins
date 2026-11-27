# Rules & MCP Manager (`customization-manager`)

可视化管理 Antigravity 全局与工作区规则（`GEMINI.md` / `AGENTS.md` / `rules/*.md`）、生命周期约束（`hooks.json`）、MCP 服务（`mcp_config.json`），并将统一配置安全链接或同步到多个 AI 客户端（Claude Code、Codex、Cursor、Qoder 及自定义路径）。

## 功能模块

1. **Rules（规则管理）**：编辑常驻规则与模块化规则（支持 `always_on` / `model_decision` / `glob` / `manual` 触发器），实时统计单文件 24 KB 上限与 20,000 tokens 预算。
2. **MCP（服务管理）**：可视化维护 Stdio 与 Streamable HTTP MCP 配置，提示 `/sse` 兼容风险，并支持一键热重载 `RefreshMcpServers`。
3. **Links（跨客户端与多路径共享）**：
   - 支持 **Windows Hard Link**（同盘符文件实时共享）、**Windows Junction**（目录联接）、**局部合并同步**（Claude `~/.claude.json` 仅合并 `mcpServers`，Codex `~/.codex/config.toml` 仅合并 `[mcp_servers.*]`）以及**全文件同步**。
   - 每次写入前均展示 Dry-Run Diff 预览并自动生成 `.bak` 备份，支持一键回滚。
4. **Hooks & 盘点**：可视化启停与编辑 `hooks.json`，只读盘点已安装插件与技能。

## 打开方式

- 在右侧辅助面板（Aux Pane）打开 **Rules & MCP**。
- 或在对话中直接输入：`打开全局规则与 MCP 管理面板`。
