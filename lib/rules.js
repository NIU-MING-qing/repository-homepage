// reflex-guard/lib/rules.js — 规则工厂与内置规则
// 每条规则：(action, ctx) => { ok:true } | { ok:false, ruleId, reason, allowedScope, whyBad }

import path from 'node:path';
import { validate } from './validate.js';

export function jsonSchemaRule(schema, opts = {}) {
  const ruleId = opts.ruleId || 'json-schema';
  const tools = opts.tools || null;
  return function schemaRule(action) {
    if (tools && !tools.includes(action.name)) return { ok: true };
    const errors = validate(action.args || {}, schema);
    if (errors.length === 0) return { ok: true };
    return {
      ok: false, ruleId,
      reason: '参数不符合 schema: ' + errors.join('; '),
      allowedScope: '需满足: ' + JSON.stringify(schema),
      whyBad: '结构化参数不合法会导致下游解析失败或产生幻觉污染。',
    };
  };
}

export function allowToolsRule(allowed, opts = {}) {
  const ruleId = opts.ruleId || 'allow-tools';
  const set = new Set(allowed);
  return function allowRule(action) {
    if (set.has(action.name)) return { ok: true };
    return {
      ok: false, ruleId,
      reason: '工具 "' + action.name + '" 不在授权列表内',
      allowedScope: '仅允许: ' + [...set].join(', '),
      whyBad: '调用未授权工具可能越权或污染状态。',
    };
  };
}

export function denyToolsRule(denied, opts = {}) {
  const ruleId = opts.ruleId || 'deny-tools';
  const set = new Set(denied);
  return function denyRule(action) {
    if (!set.has(action.name)) return { ok: true };
    return {
      ok: false, ruleId,
      reason: '工具 "' + action.name + '" 已被配置为禁用',
      allowedScope: '禁用工具: ' + [...set].join(', ') + '；请改用其他允许范围内的工具完成任务。',
      whyBad: '该工具被宿主配置明确列入黑名单，调用它违反当前使用策略。',
    };
  };
}

export function writeScopeRule(root, opts = {}) {
  const ruleId = opts.ruleId || 'write-scope';
  // 多路径键：内置 write/edit 用 file_path，ops_replace/rg_write 等用 path（2026-10-16 复测发现
  // 单一 'path' 键会让 write/edit 越界写入直接漏过——file_path 从未被检查）
  const pathKeys = opts.pathKey
    ? (Array.isArray(opts.pathKey) ? opts.pathKey : [opts.pathKey])
    : ['path', 'file_path'];
  const onlyTools = opts.onlyTools || null;
  // root 可为字符串或函数 (action, ctx) => string：DSH 里写范围随会话 cwd 动态变化
  const rootOf = typeof root === 'function' ? root : () => root;
  return function scopeRule(action, ctx) {
    if (onlyTools && !onlyTools.includes(action.name)) return { ok: true };
    const args = action.args || {};
    const paths = pathKeys
      .map((k) => args[k])
      .filter((v) => typeof v === 'string' && v.length > 0);
    if (paths.length === 0) return { ok: true }; // 非写操作，放行
    const rootResolved = path.resolve(String(rootOf(action, ctx) || ''));
    for (const p of paths) {
      // 相对路径按工作区根解析（DSH 文件工具路径相对会话 cwd）；绝对路径原样保留
      const target = path.resolve(rootResolved, p);
      const rel = path.relative(rootResolved, target);
      const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      if (inside) continue;
      return {
        ok: false, ruleId,
        reason: '目标路径 "' + p + '" 在允许目录之外',
        allowedScope: '只允许写入 ' + rootResolved + ' 及其子目录',
        whyBad: '写工作区外文件会污染宿主环境且难以回滚。',
      };
    }
    return { ok: true };
  };
}

export function forbidOverwriteRule(opts = {}) {
  const ruleId = opts.ruleId || 'no-overwrite';
  return function overwriteRule(action) {
    const mode = action.args && action.args.mode;
    if (mode === 'overwrite' || mode === 'replace') {
      return {
        ok: false, ruleId,
        reason: '不允许直接覆盖写入 (mode=' + mode + ')',
        allowedScope: '先读后改，或输出 diff/补丁，或使用幂等写入。',
        whyBad: '直接覆盖无法回滚，排查困难。',
      };
    }
    return { ok: true };
  };
}

export function composeRules(rules) {
  return function composed(action, ctx) {
    for (const rule of rules) {
      const v = rule(action, ctx);
      if (v && v.ok === false) return v;
    }
    return { ok: true };
  };
}
