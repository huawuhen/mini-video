// 轻量参数校验：不引入校验库，路由层用这些小工具拿到干净的值，错误统一成 VALIDATION_FAILED。
import { appError } from './errors.js';

export class Fields {
  constructor(source) {
    this.source = source && typeof source === 'object' ? source : {};
    this.errors = {};
  }

  string(name, { required = false, min = 0, max = 10000, trim = true } = {}) {
    let value = this.source[name];
    if (value === undefined || value === null || value === '') {
      if (required) this.errors[name] = '必填';
      return undefined;
    }
    if (typeof value !== 'string') { this.errors[name] = '必须是文字'; return undefined; }
    if (trim) value = value.trim();
    if (value.length < min || value.length > max) this.errors[name] = `长度需在 ${min}~${max} 之间`;
    return value;
  }

  int(name, { required = false, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    const value = this.source[name];
    if (value === undefined || value === null || value === '') {
      if (required) this.errors[name] = '必填';
      return undefined;
    }
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(n) || n < min || n > max) { this.errors[name] = `需为 ${min}~${max} 的整数`; return undefined; }
    return n;
  }

  oneOf(name, options, { required = false } = {}) {
    const value = this.source[name];
    if (value === undefined || value === null || value === '') {
      if (required) this.errors[name] = '必填';
      return undefined;
    }
    if (!options.includes(value)) { this.errors[name] = '取值不正确'; return undefined; }
    return value;
  }

  stringArray(name, { required = false, maxItems = 50, maxLength = 200 } = {}) {
    const value = this.source[name];
    if (value === undefined || value === null) {
      if (required) this.errors[name] = '必填';
      return undefined;
    }
    if (!Array.isArray(value) || value.length > maxItems || value.some((v) => typeof v !== 'string' || !v || v.length > maxLength)) {
      this.errors[name] = '格式不正确';
      return undefined;
    }
    return [...new Set(value)];
  }

  /** 有错误时抛出 400 VALIDATION_FAILED，details.fields 列出字段（只用于技术详情）。 */
  done() {
    if (Object.keys(this.errors).length) throw appError('VALIDATION_FAILED', undefined, { fields: this.errors });
  }
}
