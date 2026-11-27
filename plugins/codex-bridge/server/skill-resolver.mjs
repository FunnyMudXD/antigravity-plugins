import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 解析 SKILL.md 顶部的简易 YAML frontmatter，提取 name 与 description
 * @param {string} content SKILL.md 文件内容
 * @param {string} fallbackName 目录名作为兜底技能名
 * @returns {{ name: string, description: string }} 技能元信息
 */
function parseSkillFrontmatter(content, fallbackName) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return { name: fallbackName, description: '' };
  }
  const block = match[1];
  const nameMatch = block.match(/^name:\s*['"]?([^\r\n'"]+)['"]?/m);
  const name = (nameMatch ? nameMatch[1].trim() : '') || fallbackName;

  // 兼容单行 description 与 YAML 折叠多行（>- / |）
  let description = '';
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const descMatch = line.match(/^description:\s*(.*)$/);
    if (!descMatch) continue;
    const rest = descMatch[1].trim();
    if (rest && rest !== '>' && rest !== '>-' && rest !== '|' && rest !== '|-') {
      description = rest.replace(/^['"]|['"]$/g, '');
      break;
    }
    const collected = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^[a-zA-Z0-9_-]+:/.test(lines[j])) break;
      const trimmed = lines[j].trim();
      if (trimmed) collected.push(trimmed);
    }
    description = collected.join(' ').trim();
    break;
  }

  return { name, description: description.slice(0, 260) };
}

/**
 * 列出技能目录下指定子文件夹中的直接文件（最多 20 个，防止大目录膨胀）
 * @param {string} skillDir 技能根目录
 * @param {string} subDir 子目录名（如 scripts / references）
 * @returns {string[]} 绝对路径数组
 */
function listSkillSubFiles(skillDir, subDir) {
  const target = path.join(skillDir, subDir);
  try {
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return [];
    return fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .slice(0, 20)
      .map((entry) => path.join(target, entry.name));
  } catch {
    return [];
  }
}

/**
 * 返回按优先级排序的本机技能扫描根目录清单
 * @param {string} [cwd] 当前项目工作区目录（可选）
 * @returns {Array<{ dir: string, codexNative: boolean, scope: string }>} 根目录列表
 */
export function getSkillSearchRoots(cwd = '') {
  const home = os.homedir();
  const roots = [];
  if (cwd && typeof cwd === 'string' && cwd.trim()) {
    roots.push({ dir: path.join(cwd, '.cursor', 'skills'), codexNative: false, scope: 'project' });
    roots.push({ dir: path.join(cwd, '.agents', 'skills'), codexNative: true, scope: 'project' });
  }
  roots.push({ dir: path.join(home, '.agents', 'skills'), codexNative: true, scope: 'user' });
  roots.push({ dir: path.join(home, '.gemini', 'config', 'skills'), codexNative: false, scope: 'user' });
  roots.push({ dir: path.join(home, '.codex', 'skills'), codexNative: true, scope: 'user' });
  return roots;
}

/**
 * 扫描并去重汇总本机及当前项目可用的技能清单
 * @param {string} [cwd] 当前项目工作区目录（可选）
 * @param {Array<{ dir: string, codexNative: boolean, scope: string }>} [customRoots] 测试用自定义目录
 * @returns {Array<object>} 技能详情数组（按名称排序）
 */
export function listAvailableSkills(cwd = '', customRoots = null) {
  const roots = Array.isArray(customRoots) ? customRoots : getSkillSearchRoots(cwd);
  const byName = new Map();

  for (const root of roots) {
    if (!root.dir || !fs.existsSync(root.dir)) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const skillDir = path.join(root.dir, entry.name);
      const skillMdPath = path.join(skillDir, 'SKILL.md');
      try {
        if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) continue;
      } catch {
        continue;
      }

      let rawContent = '';
      try {
        rawContent = fs.readFileSync(skillMdPath, 'utf8').slice(0, 2000);
      } catch {
        rawContent = '';
      }
      const meta = parseSkillFrontmatter(rawContent, entry.name);
      const key = meta.name.toLowerCase();

      if (byName.has(key)) {
        // 若同名技能也存在于 Codex 原生目录，补充标记便于提示词带 $skillName
        if (root.codexNative) {
          byName.get(key).inCodexNativeDir = true;
        }
        continue;
      }

      byName.set(key, {
        name: meta.name,
        description: meta.description,
        scope: root.scope,
        skillDir,
        skillMdPath,
        scripts: listSkillSubFiles(skillDir, 'scripts'),
        references: listSkillSubFiles(skillDir, 'references'),
        inCodexNativeDir: Boolean(root.codexNative),
      });
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 根据传入的技能名称列表解析真实路径，并构造给 codex-cli 注入的标准化提示词段落
 * @param {string[]} skillNames 技能名称数组（允许带前导 / 或 $）
 * @param {string} [cwd] 当前项目工作区目录
 * @param {Array<{ dir: string, codexNative: boolean, scope: string }>} [customRoots] 测试用自定义目录
 * @returns {{ resolvedSkills: object[], resolvedNames: string[], missingNames: string[], promptBlock: string }} 解析与注入结果
 */
export function resolveSkillsPromptBlock(skillNames, cwd = '', customRoots = null) {
  const normalizedInput = Array.isArray(skillNames)
    ? Array.from(
        new Set(
          skillNames
            .map((item) => String(item || '').trim().replace(/^[/\$]+/, ''))
            .filter(Boolean),
        ),
      )
    : [];

  if (normalizedInput.length === 0) {
    return { resolvedSkills: [], resolvedNames: [], missingNames: [], promptBlock: '' };
  }

  const catalog = listAvailableSkills(cwd, customRoots);
  const catalogMap = new Map(catalog.map((s) => [s.name.toLowerCase(), s]));

  const resolvedSkills = [];
  const missingNames = [];

  for (const name of normalizedInput) {
    const found = catalogMap.get(name.toLowerCase());
    if (found) {
      resolvedSkills.push(found);
    } else {
      missingNames.push(name);
    }
  }

  if (resolvedSkills.length === 0) {
    return { resolvedSkills: [], resolvedNames: [], missingNames, promptBlock: '' };
  }

  const sections = [
    '## 挂载的领域技能与脚本路径（只读参考）',
    '以下技能文档和脚本位于只读技能目录中，请严格按其规范执行；禁止修改技能目录内的任何文件，所有中间产物和业务代码改动必须落在当前工作区目录内：',
  ];

  for (const skill of resolvedSkills) {
    const tag = skill.inCodexNativeDir ? `（Codex 技能标识：$${skill.name}）` : '';
    sections.push(`- 技能 **${skill.name}**${tag}`);
    sections.push(`  - 规范文档：${skill.skillMdPath}`);
    if (skill.scripts.length > 0) {
      sections.push(`  - 配套脚本：${skill.scripts.join(' ; ')}`);
    }
    if (skill.references.length > 0) {
      sections.push(`  - 参考资料：${skill.references.join(' ; ')}`);
    }
  }

  return {
    resolvedSkills,
    resolvedNames: resolvedSkills.map((s) => s.name),
    missingNames,
    promptBlock: `${sections.join('\n')}\n\n`,
  };
}
