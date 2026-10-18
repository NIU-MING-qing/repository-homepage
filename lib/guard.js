// reflex-guard/lib/guard.js — 核心状态机：拦截 → 反思 → 重试 → 升级
// 无副作用：只产出「决策」，绝不执行动作；副作用仅由调用方在 decision==='execute' 时产生。

export class Guard {
  constructor(opts = {}) {
    this.rules = opts.rules || [];
    this.maxRetry = opts.maxRetry != null ? opts.maxRetry : 2;
    this.shouldGuard = opts.shouldGuard || (() => true);
    this.logger = opts.logger || null;
    this.attempts = 0;   // 连续失败计数
    this.trace = [];     // 本步审计轨迹
    this.stepCount = 0;
  }

  submit(action, ctx = {}) {
    this.stepCount += 1;
    const base = { ts: new Date().toISOString(), action };

    if (!this.shouldGuard(action, ctx)) {
      this.attempts = 0;
      this._log('bypass', base);
      return { decision: 'execute', action, trace: this.trace.slice() };
    }

    for (const rule of this.rules) {
      let v;
      try {
        v = rule(action, ctx);
      } catch (e) {
        v = { ok: false, ruleId: 'rule-error', reason: '规则执行异常: ' + e.message, allowedScope: '检查规则实现', whyBad: '规则本身抛错，需修复规则而非模型。' };
      }
      if (v && v.ok === false) {
        this.attempts += 1;
        const violation = {
          ts: base.ts, action: base.action,
          attempt: this.attempts,
          ruleId: v.ruleId, reason: v.reason, allowedScope: v.allowedScope, whyBad: v.whyBad,
        };
        this.trace.push(violation);
        this._log('violation', violation);
        if (this.attempts > this.maxRetry) {
          this._log('escalate', violation, 'attempts=' + this.attempts + ' > maxRetry=' + this.maxRetry);
          return { decision: 'escalate', violation, trace: this.trace.slice() };
        }
        return { decision: 'reflect', violation, attempt: this.attempts, trace: this.trace.slice() };
      }
    }

    this.attempts = 0;
    this._log('execute', base);
    return { decision: 'execute', action, trace: this.trace.slice() };
  }

  reset() { this.attempts = 0; this.trace = []; this.stepCount = 0; }

  _log(kind, rec, note) {
    if (this.logger) this.logger({ kind, note, ...rec });
  }
}

export default Guard;
