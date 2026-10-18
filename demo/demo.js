// reflex-guard/demo/demo.js — 端到端演示：证明三个坑都被解决 + rg_write 写区
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Guard } from '../lib/guard.js';
import { buildReflectPrompt } from '../lib/reflect.js';
import { allowToolsRule, denyToolsRule, writeScopeRule, forbidOverwriteRule, jsonSchemaRule } from '../lib/rules.js';
import { rgWriteDefinition } from '../lib/rg-write.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // 仓库根当作「允许写入目录」

function makeGuard() {
  return new Guard({
    rules: [
      allowToolsRule(['read_file', 'edit_file', 'run_test']),
      writeScopeRule(root, { pathKey: 'path', onlyTools: ['edit_file', 'write_file'] }),
      forbidOverwriteRule(),
      jsonSchemaRule(
        { type: 'object', required: ['path'], properties: { path: { type: 'string' } }, additionalProperties: false },
        { ruleId: 'edit-schema', tools: ['edit_file'] },
      ),
    ],
    maxRetry: 2,
  });
}

function runScenario(label, model) {
  const guard = model.guard || makeGuard();
  console.log('=== 场景: ' + label + ' ===');
  let prompt = '';
  for (let i = 0; i < 6; i++) {
    const action = model.next(prompt);
    const res = guard.submit(action);
    if (res.decision === 'execute') {
      console.log('  [通过] 执行: ' + JSON.stringify(action));
      console.log('');
      return;
    }
    if (res.decision === 'reflect') {
      prompt = buildReflectPrompt(res.violation, { attempt: res.attempt, maxRetry: guard.maxRetry });
      console.log('  [拦截] ' + res.violation.ruleId + ': ' + res.violation.reason);
      continue;
    }
    console.log('  [硬断] 规则ID轨迹: ' + res.trace.map((t) => t.ruleId).join(' -> '));
    console.log('  [硬断] 原因: ' + res.violation.reason);
    console.log('');
    return;
  }
  console.log('  (超出循环上限)');
  console.log('');
}

// 1. 合法动作直接通过
runScenario('合法动作直接通过', { next: () => ({ name: 'read_file', args: { path: 'README.md' } }) });

// 2. 越界写入 → 反思 → 纠正（副作用：执行前就被拦截，未产生任何写入）
runScenario('越界写入被拦后纠正', {
  _i: 0,
  next() {
    this._i += 1;
    return this._i === 1
      ? { name: 'edit_file', args: { path: '/outside/evil.txt' } }  // 越界
      : { name: 'edit_file', args: { path: 'ok.txt' } };            // 纠正
  },
});

// 3. 顽固越权 → 两次反思后硬断（成本：maxRetry=2 上限）
runScenario('顽固越权两次反思后硬断', { next: () => ({ name: 'delete_system', args: { path: 'x' } }) });

// 3.5 被禁工具 → 反思 → 换合法工具（denyTools 黑名单，同样走反思提示闭环）
runScenario('被禁工具被拦后换工具', {
  _i: 0,
  next() {
    this._i += 1;
    return this._i === 1
      ? { name: 'run_shell', args: { cmd: 'rm -rf /' } }   // 黑名单
      : { name: 'run_test', args: {} };                    // 纠正
  },
  guard: new Guard({
    rules: [
      denyToolsRule(['run_shell']),
      allowToolsRule(['read_file', 'edit_file', 'run_test']),
    ],
    maxRetry: 2,
  }),
});

// 4. 缺参 → 反思 → 补参（结构化输出）
runScenario('缺参被拦后补参', {
  _i: 0,
  next() {
    this._i += 1;
    return this._i === 1
      ? { name: 'edit_file', args: {} }                              // 缺 path
      : { name: 'edit_file', args: { path: 'b.txt' } };             // 补参
  },
});

// 5. rg_write 专用写工具（B 方案）：内存假 ctx.fs 直测 execute 的写区/覆盖写语义
async function runRgWriteScenario() {
  console.log('=== 场景: rg_write 写区工具（写区内/越界/覆盖写/allowOverwrite） ===');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-write-demo-'));
  const fakeFs = {
    resolve(p, opts) {
      const cwd = (opts && opts.cwd) || tmpRoot;
      const abs = path.resolve(cwd, p);
      return { targetKey: abs, displayPath: abs };
    },
    contains(parent, child) {
      const rel = path.relative(parent.targetKey, child.targetKey);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    },
    async stat(target) {
      try {
        const s = fs.statSync(target.targetKey);
        return { version: 'v1', type: s.isDirectory() ? 'directory' : 'file', size: s.size };
      } catch { return undefined; }
    },
    async writeText(target, content, expected) {
      if (expected && expected.kind === 'createIfAbsent' && fs.existsSync(target.targetKey)) {
        const err = new Error('cannot overwrite existing file (FS_NOT_OBSERVED)');
        err.code = 'FS_NOT_OBSERVED';
        throw err;
      }
      const existed = fs.existsSync(target.targetKey);
      fs.mkdirSync(path.dirname(target.targetKey), { recursive: true });
      fs.writeFileSync(target.targetKey, content, 'utf8');
      return { operation: existed ? 'update' : 'create', version: 'v1' };
    },
  };
  const execBase = { signal: undefined, agent: { session: { header: { cwd: tmpRoot } } } };
  const def = rgWriteDefinition({ fs: fakeFs }, { writeZone: { root: '.', allowOverwrite: false } });

  const r1 = await def.execute({ path: 'notes/plan.md', content: '# 计划' }, execBase);
  console.log('  [通过] 写区内创建: ' + JSON.stringify(r1));
  try {
    await def.execute({ path: '../escape.txt', content: 'x' }, execBase);
    console.log('  [FAIL] 越界未被拒');
  } catch (e) {
    console.log('  [拦截] 越界: ' + String(e.message).slice(0, 60));
  }
  try {
    await def.execute({ path: 'notes/plan.md', content: 'x' }, execBase);
    console.log('  [FAIL] 覆盖未被拒');
  } catch (e) {
    console.log('  [拦截] 覆盖写: ' + String(e.message).slice(0, 60));
  }
  const def2 = rgWriteDefinition({ fs: fakeFs }, { writeZone: { root: '.', allowOverwrite: true } });
  const r4 = await def2.execute({ path: 'notes/plan.md', content: 'v2' }, execBase);
  console.log('  [通过] allowOverwrite 覆盖: ' + JSON.stringify(r4));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('');
}

await runRgWriteScenario();

console.log('演示结束：');
console.log('  副作用泄漏  → 拦截发生在执行前（场景2越界写入未执行即被拦）');
console.log('  假阳性死循环 → 硬断日志含规则ID轨迹，可判断是规则错还是模型错（场景3）');
console.log('  成本失控     → maxRetry=2 硬上限，仅关键工具被拦（场景3最多两次反思）');
