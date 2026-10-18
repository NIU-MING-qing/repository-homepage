// reflex-guard/lib/reflect.js — 反思提示构造
// 关键：必须带「原因」与「允许范围」，模型才能据此更正，而非盲目重跑。

export function buildReflectPrompt(violation, opts = {}) {
  const attempt = opts.attempt || 0;
  const maxRetry = opts.maxRetry || 0;
  const lines = [
    '[拦截器] 你上一步操作被拒绝，未执行。',
    '- 你的操作: ' + JSON.stringify(violation.action),
    '- 违反规则: ' + violation.ruleId + ' —— ' + violation.reason,
    '- 错误说明: ' + (violation.whyBad || '无'),
    '- 允许范围: ' + (violation.allowedScope || '无'),
  ];
  if (attempt > 0 && maxRetry > 0) {
    lines.push('- 剩余重试次数: ' + Math.max(0, maxRetry - attempt));
  }
  lines.push('请根据以上原因重新生成一个符合规则的操作，不要重复同样的错误。');
  return lines.join('\n');
}

export default buildReflectPrompt;
