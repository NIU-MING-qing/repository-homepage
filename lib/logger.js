// reflex-guard/lib/logger.js — JSONL 审计日志（用于定位「假阳性」：看 ruleId 是规则错还是模型错）

import fs from 'node:fs';
import os from 'node:os';

export function createJsonlLogger(filePath) {
  const stream = fs.createWriteStream(filePath, { flags: 'a' });
  return {
    log(rec) { stream.write(JSON.stringify(rec) + os.EOL); },
    close() { stream.end(); },
  };
}

export function createConsoleLogger() {
  return {
    log(rec) {
      if (rec.kind === 'violation' || rec.kind === 'escalate') {
        console.error('[reflex-guard]', rec.kind, rec.ruleId, rec.reason);
      }
    },
    close() {},
  };
}

export const noop = () => {};

export default createJsonlLogger;
