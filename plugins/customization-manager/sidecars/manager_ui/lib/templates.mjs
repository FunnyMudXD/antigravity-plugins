/**
 * Built-in rule, hook, and MCP configuration templates for quick onboarding.
 */

export const RULE_TEMPLATES = [
  {
    id: 'global-zh-standards',
    name: '全局通用开发约束（简体中文 + 工程纪律）',
    fileName: 'GEMINI.md',
    isStandalone: true,
    trigger: 'always_on',
    description: '适用于所有项目与客户端的通用行为与代码质量要求',
    globs: '',
    content: `# 全局通用开发与沟通约束

- 始终使用**简体中文**与我沟通（代码标识符、命令和日志原文除外）。
- 修改代码前先确认影响范围，优先复用仓库现有工具函数与模式，避免重复造轮子。
- 禁止在未运行验证或未实际检查文件的情况下声称测试通过或文件存在。
- 不得擅自修改未授权的配置或吞掉异常错误信息。
`,
  },
  {
    id: 'modular-frontend-glob',
    name: '前端文件按类型约束（glob 示例）',
    fileName: 'frontend-standards.md',
    isStandalone: false,
    trigger: 'glob',
    description: '读写前端组件与样式文件时自动激活的规范',
    globs: '*.ts, *.tsx, *.vue, *.css',
    content: `# 前端开发规范

- 组件保持职责单一，避免在模板或 JSX 中堆砌复杂业务逻辑。
- 优先使用项目已有的设计系统变量与公共组件，禁止硬编码魔法颜色值。
- 修改交互逻辑后检查键盘可访问性与空状态处理。
`,
  },
  {
    id: 'modular-db-decision',
    name: '数据库变更安全规范（model_decision 示例）',
    fileName: 'database-safety.md',
    isStandalone: false,
    trigger: 'model_decision',
    description: '当任务涉及 SQL 查询、表结构迁移或线上数据排查时加载此规则',
    globs: '',
    content: `# 数据库与迁移安全约束

- 涉及生产或未知库查询时，默认仅执行只读 SELECT，并加 LIMIT 限制返回行数。
- 禁止直接生成无 WHERE 条件的 DELETE / UPDATE 语句。
- 表结构变更必须提供可回滚说明或迁移脚本。
`,
  },
];

export const HOOK_TEMPLATES = [
  {
    id: 'block-destructive-shell',
    hookName: 'safety-guard-example',
    description: '在 run_command 执行前记录或拦截高危命令示例（默认 disabled，需自行配置脚本后启用）',
    config: {
      enabled: false,
      PreToolUse: [
        {
          matcher: 'run_command',
          hooks: [
            {
              type: 'command',
              command: 'node -e "process.exit(0)"',
              timeout: 5,
            },
          ],
        },
      ],
    },
  },
];

export const MCP_TEMPLATES = [
  {
    id: 'stdio-npx-template',
    name: 'sqlite-helper',
    description: '本地 Stdio MCP 示例（npx 启动）',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sqlite', 'D:\\data\\example.db'],
      env: {
        DB_READONLY: 'true',
      },
    },
  },
  {
    id: 'http-streamable-template',
    name: 'remote-mcp',
    description: '远程 Streamable HTTP MCP 示例（/mcp 端点 + Bearer Token）',
    config: {
      url: 'https://mcp.example.com/mcp',
      headers: {
        Authorization: 'Bearer YOUR_TOKEN',
      },
    },
  },
];
