// reflex-guard/test/verify-host.mjs
// 真实宿主验证：用 DSH 自带的真实 @deepseek-ai/cordis + dsh-tools + dsh-system-prompt + dsh-fs-local 包
// 启动一个真实 Cordis 宿主，挂载 reflex-guard，并驱动真实的 tools/pre-execute 瀑布链与 rg_write 工具。

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..');
const wsRoot = path.resolve(rootDir, '..'); // 会话工作区根（模拟生产 session cwd）
const NM = 'C:/Users/Admin（无密码）/AppData/Local/Programs/DeepSeek Harness/resources/app.asar/dsh/node_modules/';

const { Context } = await import(pathToFileURL(NM + '@deepseek-ai/cordis/lib/index.js').href);
const SystemPrompt = (await import(pathToFileURL(NM + '@deepseek-ai/dsh-system-prompt/lib/index.js').href)).default;
const ToolRuntime = (await import(pathToFileURL(NM + '@deepseek-ai/dsh-tools/lib/index.js').href)).default;
const LocalFileSystem = (await import(pathToFileURL(NM + '@deepseek-ai/dsh-fs-local/lib/index.js').href)).default;

console.log('[1] 启动真实宿主 (cordis + dsh-tools + dsh-system-prompt + dsh-fs-local)');
const ctx = new Context();
await ctx.plugin(SystemPrompt, {});
await ctx.plugin(ToolRuntime, { mode: 'native' });
await ctx.plugin(LocalFileSystem, { cwd: wsRoot });
const tools = ctx.get('tools');
const fsx = ctx.get('fs');
console.log('[1] tools 服务:', tools ? 'present' : 'MISSING', '| fs 服务:', fsx ? 'present' : 'MISSING', '| tools.guard 类型:', typeof tools.guard);

console.log('[2] 挂载 reflex-guard');
const plugin = await import(pathToFileURL(path.join(rootDir, 'lib', 'index.js')).href + '?tag=' + Date.now());
await ctx.plugin(plugin, {
  maxRetry: 2,
  writeScope: true,
  forbidOverwrite: true,
  writeTools: ['write', 'edit', 'rg_write'],
  denyTools: ['pwsh'],
  rgWrite: true,
  writeZone: { root: 'rg-write-zone', allowOverwrite: false },
  workspaceRoot: rootDir,
});
console.log('[2] apply 无异常，钩子注册成功');

const drive = (exec) => ctx.waterfall('tools/pre-execute', exec, () => 'PASS_INNER');

console.log('[3a] 合法写 ok.txt ->', JSON.stringify(drive({ name: 'write', args: { path: 'ok.txt' } })));

const deny1 = drive({ name: 'write', args: { path: 'C:/outside/evil.txt' } });
console.log('[3b] 越界写 ->', JSON.stringify(deny1));

const deny2 = drive({ name: 'write', args: { path: 'C:/outside/2.txt' } });
console.log('[3c] 越界写(第2次) ->', JSON.stringify(deny2));

const esc = drive({ name: 'write', args: { path: 'C:/outside/3.txt' } });
console.log('[3d] 越界写(第3次, 应硬断) ->', JSON.stringify(esc));

console.log('[3e] 硬断后合法写 ok2.txt ->', JSON.stringify(drive({ name: 'write', args: { path: 'ok2.txt' } })));

const ow = drive({ name: 'write', args: { path: 'ok3.txt', mode: 'overwrite' } });
console.log('[3f] 覆盖写 ->', JSON.stringify(ow));

console.log('[3g] 非写工具 read ->', JSON.stringify(drive({ name: 'read', args: { path: 'x' } })));
const subDir = path.join(rootDir, 'sub');
console.log('[3h] 会话cwd动态根(合法) ->', JSON.stringify(drive({ name: 'write', args: { path: 'x.txt' }, agent: { session: { header: { cwd: subDir } } } })));
const h2 = drive({ name: 'write', args: { path: '../../outside-x.txt' }, agent: { session: { header: { cwd: subDir } } } });
console.log('[3i] 会话cwd动态根(越界) ->', JSON.stringify(h2).slice(0, 110));

const banned = drive({ name: 'pwsh', args: {} });
console.log('[3j] 黑名单工具 pwsh ->', JSON.stringify(banned).slice(0, 110));

// [3k] 生产字段形状：DSH 真实执行对象用 exec.arguments（2026-10-16 字段 bug 修复验证）
const argk = drive({ name: 'write', arguments: { path: 'C:/outside/argk.txt' } });
console.log('[3k] 生产字段 arguments 越界写 ->', JSON.stringify(argk).slice(0, 110));

// [3l]-[3n] 0.1.4：forbidOverwrite 对已存在文件生效（不再依赖 mode 参数；内置 write 不传 mode）
const owExistSeed = path.join(wsRoot, 'verify-host-exist.txt');
fs.writeFileSync(owExistSeed, 'seed', 'utf8');
const owExist = drive({ name: 'write', args: { path: 'verify-host-exist.txt' }, agent: { session: { header: { cwd: wsRoot } } } });
console.log('[3l] 覆盖已存在文件(无mode) ->', JSON.stringify(owExist).slice(0, 150));
const owNew = drive({ name: 'write', args: { path: 'verify-host-new.txt' }, agent: { session: { header: { cwd: wsRoot } } } });
console.log('[3m] 写新文件(不存在) ->', JSON.stringify(owNew).slice(0, 90));
const owEdit = drive({ name: 'edit', args: { file_path: 'verify-host-exist.txt' }, agent: { session: { header: { cwd: wsRoot } } } });
console.log('[3n] edit 定点修改已存在文件(应放行) ->', JSON.stringify(owEdit).slice(0, 90));
fs.rmSync(owExistSeed, { force: true });

// [4] rg_write 专用写工具（B 方案）
const rgTool = tools.get('rg_write');
console.log('[4a] rg_write 注册 ->', rgTool ? 'present' : 'MISSING');
const rgExec = { signal: undefined, agent: { session: { header: { cwd: wsRoot } } } };
const rgPre = drive({ name: 'rg_write', arguments: { path: 'notes/a.txt', content: 'x' }, agent: { session: { header: { cwd: wsRoot } } } });
console.log('[4b] rg_write 写区内 pre-execute ->', JSON.stringify(rgPre));

let rgOutcome = null;
if (rgTool) {
  rgOutcome = await rgTool.execute({ path: 'notes/a.txt', content: '你好 rg_write' }, rgExec);
}
console.log('[4c] rg_write 写区内执行 ->', JSON.stringify(rgOutcome));

let rgEscape = null;
try { await rgTool.execute({ path: '../escape.txt', content: 'x' }, rgExec); } catch (e) { rgEscape = e; }
console.log('[4d] rg_write 越界 ->', rgEscape ? String(rgEscape.message).slice(0, 90) : '未拒绝!');

let rgOverwrite = null;
try { await rgTool.execute({ path: 'notes/a.txt', content: 'again' }, rgExec); } catch (e) { rgOverwrite = e; }
console.log('[4e] rg_write 覆盖写 ->', rgOverwrite ? String(rgOverwrite.message).slice(0, 90) : '未拒绝!');

const rgScope = drive({ name: 'rg_write', arguments: { path: 'C:/outside/rg.txt', content: 'x' }, agent: { session: { header: { cwd: wsRoot } } } });
console.log('[4f] writeScope 规则拦截 rg_write 绝对路径 ->', JSON.stringify(rgScope).slice(0, 110));

// 断言汇总
const pass = (cond, label) => console.log((cond ? '  PASS ' : '  FAIL ') + label);
pass(typeof tools.guard === 'function', 'tools.guard 已注册');
pass(fsx && typeof fsx.resolve === 'function', 'ctx.fs 服务可用');
pass(drive({ name: 'write', args: { path: 'again-ok.txt' } }) === 'PASS_INNER', '合法动作放行');
pass(h2 && h2.kind === 'deny' && /write-scope/.test(h2.reason), '会话cwd动态根越界被拦');
pass(deny1 && deny1.kind === 'deny' && /write-scope/.test(deny1.reason) && /允许范围/.test(deny1.reason), '越界写被拦(带原因+允许范围)');
pass(esc && esc.kind === 'deny' && /硬断/.test(esc.reason), '连续3次违规硬断');
pass(ow && ow.kind === 'deny' && /no-overwrite/.test(ow.reason), '覆盖写被拦(mode)');
pass(banned && banned.kind === 'deny' && /deny-tools/.test(banned.reason) && /允许范围/.test(banned.reason), 'denyTools 黑名单被拦(带原因+允许范围)');
pass(argk && argk.kind === 'deny' && /write-scope/.test(argk.reason), 'exec.arguments 字段形状被拦(字段bug修复)');
pass(owExist && owExist.kind === 'deny' && /no-overwrite/.test(owExist.reason) && /已存在/.test(owExist.reason), 'forbidOverwrite 覆盖已存在文件被拦(0.1.4 存在性检查)');
pass(owNew === 'PASS_INNER', 'forbidOverwrite 写新文件放行');
pass(owEdit === 'PASS_INNER', 'edit 定点修改已存在文件放行(先读后改)');
pass(!!rgTool, 'rg_write 已注册');
pass(rgPre === 'PASS_INNER', 'rg_write 写区内动作放行');
pass(rgOutcome && rgOutcome.operation === 'create' && fs.existsSync(path.join(wsRoot, 'rg-write-zone', 'notes', 'a.txt')), 'rg_write 写区内落盘成功');
pass(rgEscape && /越出了写区/.test(String(rgEscape.message)), 'rg_write 越界被拒(带允许范围)');
pass(rgOverwrite && /已存在/.test(String(rgOverwrite.message)), 'rg_write 覆盖写被拒');
pass(rgScope && rgScope.kind === 'deny' && /write-scope/.test(rgScope.reason), 'writeScope 规则覆盖 rg_write');

// 清理测试写区
try { fs.rmSync(path.join(wsRoot, 'rg-write-zone'), { recursive: true, force: true }); } catch { /* 忽略 */ }
console.log('验证结束');
