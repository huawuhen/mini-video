// 脚手架：npm run driver:new -- <协议名>（ARCHITECTURE §5.5 驱动规范 6）。
// 复制 scripts/driver-template/ 到 src/engine/providers/drivers/<协议名>/ 并替换占位符；
// 新增协议只需填空（入口 TODO、夹具、README），不碰任何业务代码。
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE_DIR = fileURLToPath(new URL('./driver-template/', import.meta.url));
const DRIVERS_DIR = fileURLToPath(new URL('../src/engine/providers/drivers/', import.meta.url));
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const [protocol] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!protocol || !NAME_PATTERN.test(protocol)) {
  console.error('用法：npm run driver:new -- <协议名>（kebab-case，如 openai-audio）');
  process.exit(1);
}
const target = path.join(DRIVERS_DIR, protocol);
if (existsSync(target)) {
  console.error(`驱动目录已存在：${target}`);
  process.exit(1);
}

cpSync(TEMPLATE_DIR, target, { recursive: true });
const placeholders = ['index.js', 'driver.test.js', 'README.md'];
for (const file of placeholders) {
  const filePath = path.join(target, file);
  writeFileSync(filePath, readFileSync(filePath, 'utf8').replaceAll('__PROTOCOL__', protocol));
}
console.log(`已生成驱动骨架：server/src/engine/providers/drivers/${protocol}/`);
console.log('下一步：');
console.log('  1. 在 fixtures/ 补齐样本（来源写进 provenance.md）');
console.log('  2. 实现 index.js 的 TODO（prepare/submit/query/normalize 或 image/llm 形状）');
console.log(`  3. node --test src/engine/providers/drivers/${protocol}/driver.test.js（契约套件必须全绿）`);
console.log('  4. 在后台或 CLI 登记渠道（driver 填该目录名）');
console.log(`现有驱动：${readdirSync(DRIVERS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).join('、')}`);
