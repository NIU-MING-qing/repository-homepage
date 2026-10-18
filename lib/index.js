// reflex-guard/lib/index.js — DSH 宿主入口 + 核心再导出
// 把「拦截」接到 DSH 的 tools/pre-execute 与 ctx.tools.guard：
//   - tools/pre-execute 中间件返回 { kind: 'deny', reason } 即拒绝（对齐 dsh-ops 的 hostShellRefusal）
//   - ctx.tools.guard 返回 reason 字符串即拒绝
// 违规回传可行动的反思文本，由 DSH 喂回模型 → 模型重试 → 完成「反思重试」闭环。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Guard } from './guard.js';
import { allowToolsRule, denyToolsRule, writeScopeRule, forbidOverwriteRule, jsonSchemaRule } from './rules.js';
import { buildReflectPrompt } from './reflect.js';
import { createConsoleLogger, createJsonlLogger } from './logger.js';
import { rgWriteDefinition } from './rg-write.js';

export { Guard } from './guard.js';
export { allowToolsRule, denyToolsRule, writeScopeRule, forbidOverwriteRule, jsonSchemaRule, composeRules } from './rules.js';
export { buildReflectPrompt } from './reflect.js';
export { validate } from './validate.js';
export { createJsonlLogger, createConsoleLogger } from './logger.js';

export const name = 'reflex-guard';

const DEFAULT_WRITE_TOOLS = ['write', 'edit', 'replace', 'ops_replace', 'pwsh', 'rg_write'];

function report(ctx, msg, level = 'error') {
  const l = ctx && ctx.logger;
  if (l && typeof l[level] === 'function') l[level](msg);
  else if (level === 'warn') console.warn(msg);
  else console.error(msg);
}

export function buildRules(config, workspaceRoot) {
  const rules = [];
  // 黑名单最先裁决：即使工具同时在白名单里，禁用优先。
  if (config.denyTools && config.denyTools.length) {
    rules.push(denyToolsRule(config.denyTools, { ruleId: 'deny-tools' }));
  }
  if (config.allowTools && config.allowTools.length) {
    rules.push(allowToolsRule(config.allowTools, { ruleId: 'allow-tools' }));
  }
  if (config.writeScope !== false) {
    rules.push(writeScopeRule(workspaceRoot, {
      ruleId: 'write-scope',
      pathKey: config.writePathKey || ['path', 'file_path'],
      onlyTools: config.writeTools || DEFAULT_WRITE_TOOLS,
    }));
  }
  if (config.forbidOverwrite !== false) {
    rules.push(forbidOverwriteRule({ ruleId: 'no-overwrite' }));
  }
  if (config.schema) {
    rules.push(jsonSchemaRule(config.schema, {
      ruleId: config.schemaRuleId || 'schema',
      tools: config.schemaTools || null,
    }));
  }
  return rules;
}

// 一个 Guard 实例管一个被拦截工具名，成功即重置计数。
export function createInterceptor(config, workspaceRoot) {
  // 写范围根随 exec 的会话 cwd 动态解析（exec.agent.session.header.cwd，见 dsh-tools 的调用约定）
  const rootResolver = (action, ctx) => (ctx && ctx.sessionCwd) || workspaceRoot;
  const rules = buildRules(config || {}, rootResolver);
  const maxRetry = config && config.maxRetry != null ? config.maxRetry : 2;
  const logger = (config && config.auditFile) ? createJsonlLogger(config.auditFile) : createConsoleLogger();
  const guards = new Map();

  function intercept(exec) {
    const toolName = String(exec && exec.name ? exec.name : '');
    // DSH 工具执行对象的规范字段是 exec.arguments（dsh-tools 源码 3061/3163-3167/3310 处均用 .arguments）；
    // 旧版读 exec.args 导致生产环境 args 恒为空、writeScope/forbidOverwrite 全放行（2026-10-16 修复）。
    const args = (exec && (exec.arguments || exec.args || exec.params)) || {};
    const action = { name: toolName, args };
    if (!rules.length) return undefined;

    let guard = guards.get(toolName);
    if (!guard) {
      guard = new Guard({ rules, maxRetry, shouldGuard: () => true, logger: logger.log.bind(logger) });
      guards.set(toolName, guard);
    }
    const sessionCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
    const res = guard.submit(action, { sessionCwd });
    if (res.decision === 'execute') return undefined;
    if (res.decision === 'reflect') {
      return buildReflectPrompt(res.violation, { attempt: res.attempt, maxRetry });
    }
    // escalate：硬断，并重置以便下个用户回合重新开始
    const msg = '[拦截器-硬断] 连续 ' + (res.attempt != null ? res.attempt : maxRetry + 1)
      + ' 次违反规则 ' + res.violation.ruleId + ': ' + res.violation.reason
      + '。请停下，重新规划或向用户求助。';
    guard.reset();
    return msg;
  }

  return intercept;
}

// 诊断标记：每次 apply 都把关键信息写进插件目录的 rg-canary.json（本地调试用）
const __here = path.dirname(fileURLToPath(import.meta.url));
function writeCanary(obj) {
  try {
    fs.appendFileSync(path.join(__here, '..', 'rg-canary.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
  } catch { /* 忽略写入失败 */ }
}

export function apply(ctx, rawConfig) {
  const config = rawConfig || {};
  writeCanary({ step: 'apply-start', hasGet: typeof ctx.get === 'function', hasOn: typeof ctx.on === 'function', hasInject: typeof ctx.inject === 'function', hasEffect: typeof ctx.effect === 'function' });
  try {
    // workspaceRoot 只作兜底；写范围实际按 exec.agent.session.header.cwd 动态解析。
    let workspaceRoot = config.workspaceRoot;
    if (!workspaceRoot) {
      try { workspaceRoot = (ctx.get('workspace') || {}).root; }
      catch (e) { writeCanary({ step: 'workspace-get-threw', error: String(e && e.message).slice(0, 300) }); }
    }
    if (!workspaceRoot) workspaceRoot = process.cwd();
    const intercept = createInterceptor(config, workspaceRoot);

    // 权威模式（对齐 dsh-ops installHostShellDenial）：在 inject(['tools']) 的上下文里注册钩子
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], (toolsCtx) => {
          writeCanary({ step: 'inject-tools-callback', hasToolsProp: !!(toolsCtx && toolsCtx.tools), guardType: typeof (toolsCtx && toolsCtx.tools && toolsCtx.tools.guard) });
          toolsCtx.on('tools/pre-execute', (exec, next) => {
            const reason = intercept(exec);
            if (reason) return { kind: 'deny', reason };
            return next();
          });
          if (toolsCtx.tools && typeof toolsCtx.tools.guard === 'function') {
            toolsCtx.effect(() => toolsCtx.tools.guard((exec) => intercept(exec)), name + ': guard');
            writeCanary({ step: 'guard-registered' });
          } else {
            writeCanary({ step: 'guard-missing' });
          }
        });
        writeCanary({ step: 'inject-called' });
      } catch (e) { writeCanary({ step: 'inject-tools-threw', error: String(e && e.message).slice(0, 300) }); }
    }

    // rg_write 专用写工具（B 方案）：在受控写区（writeZone.root，相对会话 cwd）内写 UTF-8 文件，
    // 越出写区/覆盖已有文件被拒（带中文理由）。config.rgWrite === false 时关闭注册。
    if (config.rgWrite !== false && typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools', 'fs'], (tc) => {
          writeCanary({ step: 'inject-tools-fs-callback', hasFs: !!(tc && tc.fs) });
          if (tc && tc.tools && typeof tc.tools.register === 'function' && tc.fs) {
            tc.tools.register(rgWriteDefinition(tc, config));
            writeCanary({
              step: 'rg-write-registered',
              zoneRoot: (config.writeZone && config.writeZone.root) || '.',
              allowOverwrite: !!(config.writeZone && config.writeZone.allowOverwrite),
            });
          } else {
            writeCanary({ step: 'rg-write-skipped', hasFs: !!(tc && tc.fs) });
          }
        });
      } catch (e) { writeCanary({ step: 'inject-tools-fs-threw', error: String(e && e.message).slice(0, 300) }); }
    }

    // 兜底：根上下文注册（老方式，双注册无害——瀑布链第一个拒绝即返回）
    ctx.on('tools/pre-execute', (exec, next) => {
      const reason = intercept(exec);
      if (reason) return { kind: 'deny', reason };
      return next();
    });

    report(ctx, 'reflex-guard: 拦截器已挂载 (denyTools=' + (config.denyTools || []).join(',')
      + ', writeScope=' + (config.writeScope !== false)
      + ', forbidOverwrite=' + (config.forbidOverwrite !== false)
      + ', rgWrite=' + (config.rgWrite !== false)
      + ', maxRetry=' + (config.maxRetry != null ? config.maxRetry : 2) + ')', 'info');
    writeCanary({ step: 'apply-done', workspaceRoot });
  } catch (e) {
    writeCanary({ step: 'apply-error', error: String(e && e.stack ? e.stack : e).slice(0, 2000) });
    throw e;
  }
}

export default apply;
