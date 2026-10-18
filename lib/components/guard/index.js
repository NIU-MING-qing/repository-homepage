// reflex-guard/lib/components/guard/index.js — DSH 组件入口
import { apply as applyHost } from '../../index.js';

export const name = 'reflex-guard-guard';

export function apply(ctx, config) {
  return applyHost(ctx, config);
}

export default apply;
