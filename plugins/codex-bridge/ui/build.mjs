import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');

/**
 * 使用 esbuild 将 TypeScript 前端与 @modelcontextprotocol/ext-apps 打包并内联为单个 HTML 文件
 */
async function buildSingleFileUi() {
  const result = await esbuild.build({
    entryPoints: [path.join(SRC_DIR, 'app.ts')],
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2022'],
    write: false,
  });

  const jsCode = result.outputFiles[0].text;
  const cssCode = fs.readFileSync(path.join(SRC_DIR, 'styles.css'), 'utf8');
  const template = fs.readFileSync(path.join(SRC_DIR, 'template.html'), 'utf8');

  // 使用函数替换避免代码中的 `$&` / `$$` 等字符被 String.replace 误解析
  const html = template
    .replace('/* __INLINE_CSS__ */', () => cssCode)
    .replace('/* __INLINE_JS__ */', () => jsCode);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');

  const sizeKb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`[codex-bridge] 单文件 UI 构建完成: ${outPath} (${sizeKb} KB)`);
}

buildSingleFileUi().catch((err) => {
  console.error('[codex-bridge] UI 构建失败:', err);
  process.exit(1);
});
