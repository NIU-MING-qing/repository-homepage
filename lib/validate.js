// reflex-guard/lib/validate.js — 极简 JSON-Schema 校验器（零依赖）
// 支持：type, required, properties, items, enum, const, additionalProperties:false

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeMatches(v, t) {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'string') return typeof v === 'string';
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'null') return v === null;
  return true;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validate(value, schema, path = '$') {
  const errors = [];
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(path + ': 期望 ' + schema.type + ', 实得 ' + typeName(value));
    return errors;
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(path + ': 不在枚举 ' + JSON.stringify(schema.enum) + ' 内');
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(path + ': 不等于常量 ' + JSON.stringify(schema.const));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of (schema.required || [])) {
      if (!(key in value)) errors.push(path + '.' + key + ': 缺少必填字段');
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) errors.push(...validate(value[key], sub, path + '.' + key));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) errors.push(path + '.' + key + ': 不允许的额外字段');
      }
    }
  }
  if (Array.isArray(value) && schema.type === 'array' && schema.items) {
    value.forEach((item, i) => errors.push(...validate(item, schema.items, path + '[' + i + ']')));
  }
  return errors;
}

export default validate;
