# Antigravity Plugins

自研的 Google Antigravity（反重力）原生插件集合，采用单仓多插件（Monorepo）结构管理，通过 `~/.gemini/config/plugins.json` 统一加载。

## 包含插件

| 插件目录 | 显示名称 | 版本 | 说明 |
| :--- | :--- | :--- | :--- |
| [codex-bridge](./plugins/codex-bridge/README.md) | Codex Bridge | `0.1.0` | 在 Antigravity 中通过本地 MCP Server 编排 `codex-cli`（GPT），内置可视化配置与任务指挥台（支持侧边栏与全屏）。 |
| [customization-manager](./plugins/customization-manager/README.md) | Rules & MCP Manager | `1.0.0` | 全局与工作区规则、Hooks、MCP Server 及多 AI 客户端（Antigravity、Claude Code、Codex、Cursor、Qoder）配置同步的可视化管理面板。 |
| [token-stats](./plugins/token-stats/README.md) | Token & Cache Stats | `1.0.0` | 基于 `PostInvocation` Hook 的零上下文开销统计插件，提供每轮 Token 消耗、缓存命中率与耗时追踪及仪表盘面板。 |

## 目录结构

```text
antigravity-plugins/
├── .gitignore
├── LICENSE
├── README.md
├── scripts/
│   └── setup.ps1                # Windows 一键初始化脚本（装依赖、构建 UI、注册 plugins.json）
└── plugins/
    ├── codex-bridge/
    ├── customization-manager/
    └── token-stats/
```

## 快速开始

### 方式一：Windows 一键初始化（推荐）

克隆仓库后，在仓库根目录运行初始化脚本：

```powershell
git clone https://github.com/FunnyMudXD/antigravity-plugins.git
cd antigravity-plugins
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

该脚本会自动完成以下操作：
1. 安装 `plugins/codex-bridge` 的 npm 依赖并构建前端 UI（`ui/dist/index.html`）。
2. 将当前仓库的 `plugins/` 目录自动追加注册到 `~/.gemini/config/plugins.json`（保留你已有的其他配置项）。

### 方式二：手动安装（Windows / macOS / Linux 通用）

1. **构建 `codex-bridge` 前端产物**（需要 Node.js）：
   ```bash
   cd plugins/codex-bridge
   npm ci
   npm run build:ui
   ```
   > `customization-manager` 与 `token-stats` 均无外部依赖（`token-stats` 需要本机可用 Python 3）。

2. **在 `~/.gemini/config/plugins.json` 中注册插件目录**：
   ```json
   {
     "entries": [
       { "path": "/你的本地路径/antigravity-plugins/plugins" }
     ]
   }
   ```
   > 注意：如果你此前在 `~/.gemini/config/plugins/` 下安装过同名插件，请先移除旧目录以避免同名冲突。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
