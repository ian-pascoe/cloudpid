// src/index.ts
import { existsSync } from "node:fs";

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/chunk-DYPzFuB5.mjs
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __exportAll = (all, symbols) => {
  let target = {};
  for (var name in all) {
    __defProp(target, name, {
      get: all[name],
      enumerable: true
    });
  }
  if (symbols) {
    __defProp(target, Symbol.toStringTag, { value: "Module" });
  }
  return target;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key;i < n; i++) {
      key = keys[i];
      if (!__hasOwnProp.call(to, key) && key !== except) {
        __defProp(to, key, {
          get: ((k) => from[k]).bind(null, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
      }
    }
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
  value: mod,
  enumerable: true
}) : target, mod));

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/dialects-BAIiebX0.mjs
var DRAFT_2020_12_URIS = new Set(["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft/2020-12/schema"]);
var DRAFT_2019_09_URIS = new Set(["https://json-schema.org/draft/2019-09/schema", "http://json-schema.org/draft/2019-09/schema"]);
var DRAFT_07_URIS = new Set(["https://json-schema.org/draft-07/schema", "http://json-schema.org/draft-07/schema"]);
var DRAFT_06_URIS = new Set(["https://json-schema.org/draft-06/schema", "http://json-schema.org/draft-06/schema"]);
function declares2019Dialect($schema) {
  return typeof $schema === "string" && DRAFT_2019_09_URIS.has($schema.replace(/#$/, ""));
}
function declaredDialect(schema, remedy) {
  if (!("$schema" in schema) || typeof schema.$schema !== "string")
    return "2020-12";
  const declared = schema.$schema.replace(/#$/, "");
  if (DRAFT_2020_12_URIS.has(declared))
    return "2020-12";
  if (DRAFT_2019_09_URIS.has(declared))
    return "2019-09";
  if (DRAFT_07_URIS.has(declared) || DRAFT_06_URIS.has(declared))
    return "draft-7";
  throw new Error(`JSON Schema declares an unsupported dialect ("$schema": "${schema.$schema.slice(0, 200)}"). The default validator supports JSON Schema 2020-12, 2019-09, draft-07, and draft-06; ${remedy}`);
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  const values = Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
  return values;
}
function joinValues(array, separator = "|") {
  return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
  if (typeof value === "bigint")
    return value.toString();
  return value;
}

class Cached {
  constructor(getter) {
    this._getter = getter;
    this._value = undefined;
  }
  get value() {
    const getter = this._getter;
    if (getter !== undefined) {
      this._value = getter();
      this._getter = undefined;
    }
    return this._value;
  }
}
function cached(getter) {
  return new Cached(getter);
}
function nullish(input) {
  return input === null || input === undefined;
}
function cleanRegex(source) {
  const start = source.startsWith("^") ? 1 : 0;
  const end = source.endsWith("$") ? source.length - 1 : source.length;
  return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
  const ratio = val / step;
  const roundedRatio = Math.round(ratio);
  const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
  if (Math.abs(ratio - roundedRatio) < tolerance)
    return 0;
  return ratio - roundedRatio;
}
var EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object, key, getter) {
  let value = undefined;
  Object.defineProperty(object, key, {
    get() {
      if (value === EVALUATING) {
        return;
      }
      if (value === undefined) {
        value = EVALUATING;
        value = getter();
      }
      return value;
    },
    set(v) {
      Object.defineProperty(object, key, {
        value: v
      });
    },
    configurable: true
  });
}
function assignProp(target, prop, value) {
  Object.defineProperty(target, prop, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  });
}
function rawShape(def) {
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  return desc?.get ? desc.get.raw : desc?.value;
}
function sourceShape(schema) {
  return rawShape(schema._zod.def) ?? schema._zod.def.shape;
}
function deferProp(target, key, getter) {
  Object.defineProperty(target, key, {
    get() {
      const value = getter();
      assignProp(this, key, value);
      return value;
    },
    enumerable: true,
    configurable: true
  });
}
function putProp(target, key, value) {
  if (key in target)
    assignProp(target, key, value);
  else
    target[key] = value;
}
function mirrorShape(target, source, keys, wrap) {
  const raw = sourceShape(source);
  for (const key of keys) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (!desc.enumerable)
      continue;
    if (desc.get) {
      deferProp(target, key, () => {
        const value = source._zod.def.shape[key];
        return wrap ? wrap(value, key) : value;
      });
    } else
      putProp(target, key, wrap ? wrap(desc.value, key) : desc.value);
  }
}
function mirrorProps(target, source) {
  for (const key of Reflect.ownKeys(source)) {
    const desc = Object.getOwnPropertyDescriptor(source, key);
    if (!desc.enumerable)
      continue;
    if (desc.get)
      deferProp(target, key, () => source[key]);
    else
      putProp(target, key, desc.value);
  }
}
function mergeDefs(...defs) {
  const mergedDescriptors = {};
  for (const def of defs) {
    const descriptors = Object.getOwnPropertyDescriptors(def);
    Object.assign(mergedDescriptors, descriptors);
  }
  return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
  return JSON.stringify(str);
}
function slugify(input) {
  return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__ */ cached(() => {
  if (globalConfig.jitless) {
    return false;
  }
  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {
    return false;
  }
  try {
    const F = Function;
    new F("");
    return true;
  } catch (_) {
    return false;
  }
});
function isPlainObject(o) {
  if (isObject(o) === false)
    return false;
  const ctor = o.constructor;
  if (ctor === undefined)
    return true;
  if (typeof ctor !== "function")
    return true;
  const prot = ctor.prototype;
  if (isObject(prot) === false)
    return false;
  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false;
  }
  return true;
}
function shallowClone(o) {
  if (isPlainObject(o))
    return { ...o };
  if (Array.isArray(o))
    return [...o];
  if (o instanceof Map)
    return new Map(o);
  if (o instanceof Set)
    return new Set(o);
  return o;
}
var propertyKeyTypes = /* @__PURE__ */ new Set(["string", "number", "symbol"]);
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
  const cl = new inst._zod.constr(def ?? inst._zod.def);
  if (!def || params?.parent)
    cl._zod.parent = inst;
  return cl;
}
function normalizeParams(_params) {
  const params = _params;
  if (!params)
    return {};
  if (typeof params === "string")
    return { error: () => params };
  if (params?.message !== undefined) {
    if (params?.error !== undefined)
      throw new Error("Cannot specify both `message` and `error` params");
    params.error = params.message;
  }
  delete params.message;
  if (typeof params.error === "string")
    return { ...params, error: () => params.error };
  return params;
}
function stringifyPrimitive(value) {
  if (typeof value === "bigint")
    return value.toString() + "n";
  if (typeof value === "string")
    return `"${value}"`;
  return `${value}`;
}
function optionalKeys(shape) {
  return Object.keys(shape).filter((k) => {
    return shape[k]._zod.optin !== undefined && shape[k]._zod.optout === "optional";
  });
}
var NUMBER_FORMAT_RANGES = /* @__PURE__ */ (() => ({
  safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
  float32: [-340282346638528860000000000000000000000, 340282346638528860000000000000000000000],
  float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
var BIGINT_FORMAT_RANGES = {
  int64: [/* @__PURE__ */ BigInt("-9223372036854775808"), /* @__PURE__ */ BigInt("9223372036854775807")],
  uint64: [/* @__PURE__ */ BigInt(0), /* @__PURE__ */ BigInt("18446744073709551615")]
};
function pick(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".pick() cannot be used on object schemas containing refinements");
  }
  const newShape = {};
  mirrorShape(newShape, schema, maskedKeys(schema, mask));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function maskedKeys(schema, mask) {
  const raw = sourceShape(schema);
  const keys = [];
  for (const key of Reflect.ownKeys(mask)) {
    if (!Object.getOwnPropertyDescriptor(raw, key)?.enumerable) {
      throw new Error(`Unrecognized key: "${String(key)}"`);
    }
    if (mask[key])
      keys.push(key);
  }
  return keys;
}
function omit(schema, mask) {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(".omit() cannot be used on object schemas containing refinements");
  }
  const omitted = new Set(maskedKeys(schema, mask));
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)).filter((key) => !omitted.has(key)));
  return clone(schema, mergeDefs(currDef, { shape: newShape, checks: [] }));
}
function extend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to extend: expected a plain object");
  }
  const checks = schema._zod.def.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    const existingShape = sourceShape(schema);
    for (const key of Reflect.ownKeys(shape)) {
      if (Object.getOwnPropertyDescriptor(existingShape, key) !== undefined) {
        throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
      }
    }
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function extended(schema, shape) {
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)));
  mirrorProps(newShape, shape);
  return newShape;
}
function safeExtend(schema, shape) {
  if (!isPlainObject(shape)) {
    throw new Error("Invalid input to safeExtend: expected a plain object");
  }
  return clone(schema, mergeDefs(schema._zod.def, { shape: extended(schema, shape) }));
}
function merge(a, b) {
  if (!b?._zod?.def) {
    throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
  }
  if (a._zod.def.checks?.length) {
    throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
  }
  const newShape = {};
  mirrorShape(newShape, a, Reflect.ownKeys(sourceShape(a)));
  mirrorShape(newShape, b, Reflect.ownKeys(sourceShape(b)));
  const def = mergeDefs(a._zod.def, {
    shape: newShape,
    get catchall() {
      return b._zod.def.catchall;
    },
    checks: b._zod.def.checks ?? []
  });
  return clone(a, def);
}
function partial(Class, schema, mask, name = "partial") {
  const currDef = schema._zod.def;
  const checks = currDef.checks;
  const hasChecks = checks && checks.length > 0;
  if (hasChecks) {
    throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
  }
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), Class && ((value, key) => selected && !selected.has(key) ? value : new Class({ type: "optional", innerType: value })));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape, checks: [] }));
}
function required(Class, schema, mask) {
  const selected = mask ? new Set(maskedKeys(schema, mask)) : undefined;
  const newShape = {};
  mirrorShape(newShape, schema, Reflect.ownKeys(sourceShape(schema)), (value, key) => selected && !selected.has(key) ? value : new Class({ type: "nonoptional", innerType: value }));
  return clone(schema, mergeDefs(schema._zod.def, { shape: newShape }));
}
function aborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue !== true) {
      return true;
    }
  }
  return false;
}
function explicitlyAborted(x, startIndex = 0) {
  if (x.aborted === true)
    return true;
  for (let i = startIndex;i < x.issues.length; i++) {
    if (x.issues[i]?.continue === false) {
      return true;
    }
  }
  return false;
}
function prefixIssues(path, issues) {
  return issues.map((iss) => {
    var _a;
    (_a = iss).path ?? (_a.path = []);
    iss.path.unshift(path);
    return iss;
  });
}
function unwrapMessage(message) {
  return typeof message === "string" ? message : message?.message;
}
function sizeCaps(defChecks) {
  const caps = [];
  for (const ch of defChecks ?? []) {
    const d = ch._zod.def;
    if (!/_(length|size)$|_equals$/.test(d.check))
      break;
    const max = d.maximum ?? d.length ?? d.size;
    if (max >= 0)
      caps.push([max, ch]);
  }
  return caps;
}
function attachSchema(issues, start, inst) {
  var _a;
  for (let i = start;i < issues.length; i++) {
    (_a = issues[i]).schema ?? (_a.schema = inst);
  }
}
function finalizeIssue(iss, ctx, config) {
  var _a;
  const traits = iss.inst?._zod?.traits;
  if (traits?.has("$ZodType")) {
    if (traits.has("$ZodCheck"))
      (_a = iss).schema ?? (_a.schema = iss.inst);
    else
      iss.schema = iss.inst;
  }
  const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : undefined;
  const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
  const full = {};
  for (const k of Object.keys(iss)) {
    if (k === "inst" || k === "schema" || k === "continue" || k === "input" || k === "__proto__")
      continue;
    full[k] = iss[k];
  }
  full.path ?? (full.path = []);
  full.message = message;
  if (ctx?.reportInput) {
    full.input = iss.input;
  }
  return full;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
  const units = str.length;
  if (!highSurrogate.test(str))
    return units;
  let count = units;
  for (let i = 0;i < units - 1; i++) {
    if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
      count--;
      i++;
    }
  }
  return count;
}
function getLengthableOrigin(input) {
  if (Array.isArray(input))
    return "array";
  if (typeof input === "string")
    return "string";
  return "unknown";
}
function parsedType(data) {
  const t = typeof data;
  switch (t) {
    case "number": {
      return Number.isNaN(data) ? "nan" : "number";
    }
    case "object": {
      if (data === null) {
        return "null";
      }
      if (Array.isArray(data)) {
        return "array";
      }
      const obj = data;
      if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) {
        return obj.constructor.name;
      }
    }
  }
  return t;
}
function issue(...args) {
  const [iss, input, inst] = args;
  if (typeof iss === "string") {
    return {
      message: iss,
      code: "custom",
      input,
      inst
    };
  }
  return { ...iss };
}
function members(proto, table) {
  for (const key in table) {
    const desc = Object.getOwnPropertyDescriptor(table, key);
    if (desc.get)
      Object.defineProperty(proto, key, { ...desc, enumerable: false });
    else
      defineBound(proto, key, desc.value);
  }
}
function own(inst, key, value, enumerable = true) {
  Object.defineProperty(inst, key, { configurable: true, writable: true, enumerable, value });
  return value;
}
function hide(inst, key, value) {
  return own(inst, key, value, false);
}
function derived(computes, table) {
  for (const key in computes) {
    const compute = computes[key];
    Object.defineProperty(table, key, {
      configurable: true,
      enumerable: true,
      get() {
        return own(this, key, compute(this));
      },
      set(value) {
        own(this, key, value);
      }
    });
  }
  return table;
}
function defineBound(proto, key, fn) {
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      return this == null ? fn : own(this, key, fn.bind(this));
    },
    set(value) {
      own(this, key, value);
    }
  });
}
function claim(inst, sentinel) {
  const proto = Object.getPrototypeOf(inst);
  return sentinel in proto ? undefined : proto;
}
var installing;
var broke = false;
var breaker = {
  configurable: true,
  get() {
    broke = true;
    return;
  }
};
function defineLazyInternal(inst, key, compute) {
  const proto = Object.getPrototypeOf(inst._zod);
  if (key in proto && installing !== inst._zod) {
    installing = undefined;
    return;
  }
  installing = inst._zod;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      Object.defineProperty(this, key, breaker);
      const outer = broke;
      broke = false;
      try {
        const value = compute(this);
        if (broke)
          delete this[key];
        else
          Object.defineProperty(this, key, { configurable: true, writable: true, value });
        broke = broke || outer;
        return value;
      } catch (err) {
        delete this[key];
        broke = broke || outer;
        throw err;
      }
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, value });
    }
  });
}
function installLazyProp(inst, key, make, enumerable) {
  const proto = claim(inst, key);
  if (!proto)
    return;
  Object.defineProperty(proto, key, {
    configurable: true,
    get() {
      const desc = { configurable: true, writable: true, enumerable, value: undefined };
      Object.defineProperty(this, key, desc);
      desc.value = make(this);
      Object.defineProperty(this, key, desc);
      return desc.value;
    },
    set(value) {
      Object.defineProperty(this, key, { configurable: true, writable: true, enumerable, value });
    }
  });
}
var CONSTANT_CATCH = "~constantCatch";
function constantCatch(value) {
  const fn = () => value;
  fn[CONSTANT_CATCH] = true;
  return fn;
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/core.js
var _a;
var NEVER = /* @__PURE__ */ Object.freeze({
  status: "aborted"
});
var _zodDesc = { value: undefined, enumerable: false };
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
  const E = _E;
  if (E) {
    const saved = E.stackTraceLimit;
    if (typeof saved === "number") {
      try {
        E.stackTraceLimit = 0;
      } catch {
        _E = null;
        return new Definition;
      }
      try {
        return new Definition;
      } finally {
        E.stackTraceLimit = saved;
      }
    }
  }
  return new Definition;
}
function $constructor(name, initializer, proto, params) {
  const zodProto = {};
  function Internals(def) {
    this.def = def;
    this.constr = _;
    this.traits = new Set;
  }
  Internals.prototype = zodProto;
  const protoMembers = proto;
  const initialized = protoMembers && new WeakSet;
  function init(inst, def) {
    if (!inst._zod) {
      _zodDesc.value = new Internals(def);
      try {
        Object.defineProperty(inst, "_zod", _zodDesc);
      } finally {
        _zodDesc.value = undefined;
      }
    } else if (inst._zod.traits.has(name)) {
      return;
    }
    inst._zod.traits.add(name);
    initializer(inst, def);
    if (initialized) {
      const own = Object.getPrototypeOf(inst);
      const ctorProto = inst._zod.constr.prototype;
      let up = own;
      while (up && up !== ctorProto)
        up = Object.getPrototypeOf(up);
      const target = up ?? own;
      if (!initialized.has(target)) {
        initialized.add(target);
        members(target, protoMembers);
      }
    }
    const proto = _.prototype;
    for (const k in proto) {
      if (!Object.prototype.hasOwnProperty.call(proto, k))
        continue;
      if (!(k in inst)) {
        inst[k] = proto[k].bind(inst);
      }
    }
  }
  const Parent = params?.Parent ?? Object;

  class Definition extends Parent {
  }
  Object.defineProperty(Definition, "name", { value: name });
  function _(def) {
    const inst = params?.Parent ? newError(Definition) : this;
    init(inst, def);
    const deferred = inst._zod.deferred;
    if (deferred) {
      for (const fn of deferred) {
        fn();
      }
      inst._zod.deferred = undefined;
    }
    const pp = globalThis.__zod_globalConfig?.postProcessor;
    if (pp)
      pp(inst);
    return inst;
  }
  Object.defineProperty(_, "init", { value: init });
  Object.defineProperty(_, Symbol.hasInstance, {
    value: (inst) => {
      if (params?.Parent && inst instanceof params.Parent)
        return true;
      return inst?._zod?.traits?.has(name);
    }
  });
  Object.defineProperty(_, "name", { value: name });
  return _;
}
class $ZodAsyncError extends Error {
  constructor() {
    super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
  }
}

class $ZodEncodeError extends Error {
  constructor(name) {
    super(`Encountered unidirectional transform during encode: ${name}`);
    this.name = "ZodEncodeError";
  }
}
(_a = globalThis).__zod_globalConfig ?? (_a.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
  if (newConfig)
    Object.assign(globalConfig, newConfig);
  return globalConfig;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/errors.js
function _getMessage() {
  const internals = this._zod;
  internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
  return internals.message;
}
function _setMessage(value) {
  this._zod.message = value;
}
var _messageDesc = {
  get: _getMessage,
  set: _setMessage,
  enumerable: true,
  configurable: true
};
var _issuesDesc = { value: undefined, enumerable: false };
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer = (inst, def) => {
  inst.name = "$ZodError";
  _issuesDesc.value = def;
  Object.defineProperty(inst, "issues", _issuesDesc);
  _issuesDesc.value = undefined;
  Object.defineProperty(inst, "message", _messageDesc);
  const proto = Object.getPrototypeOf(inst);
  if (!_installedToString.has(proto)) {
    _installedToString.add(proto);
    Object.defineProperty(proto, "toString", {
      configurable: true,
      enumerable: false,
      get() {
        const value = () => this.message;
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
        return value;
      },
      set(value) {
        Object.defineProperty(this, "toString", { value, configurable: true, writable: true });
      }
    });
  }
};
var $ZodError = $constructor("$ZodError", initializer);
var $ZodRealError = $constructor("$ZodError", initializer, undefined, {
  Parent: Error
});
function node(obj, key, make) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    if (key === "__proto__") {
      Object.defineProperty(obj, key, { value: make(), writable: true, enumerable: true, configurable: true });
    } else {
      obj[key] = make();
    }
  }
  return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
  const fieldErrors = {};
  const formErrors = [];
  for (const sub of error.issues) {
    if (sub.path.length > 0) {
      node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
    } else {
      formErrors.push(mapper(sub));
    }
  }
  return { formErrors, fieldErrors };
}
function formatError(error, mapper = (issue) => issue.message) {
  const fieldErrors = { _errors: [] };
  const processError = (error, path = []) => {
    for (const issue of error.issues) {
      if (issue.code === "invalid_union" && issue.errors.length) {
        issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
      } else if (issue.code === "invalid_key") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else if (issue.code === "invalid_element") {
        processError({ issues: issue.issues }, [...path, ...issue.path]);
      } else {
        const fullpath = [...path, ...issue.path];
        if (fullpath.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < fullpath.length) {
            const el = fullpath[i];
            const terminal = i === fullpath.length - 1;
            if (el === "_errors") {
              if (terminal)
                curr._errors.push(mapper(issue));
              i++;
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(curr, el)) {
              Object.defineProperty(curr, el, {
                value: { _errors: [] },
                enumerable: true,
                writable: true,
                configurable: true
              });
            }
            const node = curr[el];
            if (terminal) {
              node._errors.push(mapper(issue));
            }
            curr = node;
            i++;
          }
        }
      }
    }
  };
  processError(error);
  return fieldErrors;
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
  return { callee: params?.callee ?? callee, Err: params?.Err };
}
var _parse = (_Err) => {
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
    const result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise) {
      throw new $ZodAsyncError;
    }
    if (result.issues.length) {
      const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, _params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _parseAsync = (_Err) => {
  const fn = async (schema, value, _ctx, params) => {
    const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
    let result = schema._zod.run({ value, issues: [] }, ctx);
    if (result instanceof Promise)
      result = await result;
    if (result.issues.length) {
      const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
      captureStackTrace(e, params?.callee ?? fn);
      throw e;
    }
    return result.value;
  };
  return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: false } : { async: false };
  const result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
function failure(Err, issues, ctx) {
  let error;
  return {
    success: false,
    get error() {
      if (!error) {
        error = new Err(issues.map((iss) => finalizeIssue(iss, ctx, config())));
        issues = undefined;
        ctx = undefined;
      }
      return error;
    },
    set error(e) {
      error = e;
      issues = undefined;
      ctx = undefined;
    }
  };
}
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true } : { async: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length ? failure(_Err, result.issues, ctx) : { success: true, data: result.value };
};
var COMPILE_INVALID = /* @__PURE__ */ Symbol.for("zod.compile.invalid");
var COMPILE_FALLBACK = /* @__PURE__ */ Symbol.for("zod.compile.fallback");
var validate = (schema, value, _ctx) => {
  const validator = schema._zod.bag.validator;
  if (validator !== undefined) {
    if (validator(value) !== COMPILE_INVALID)
      return true;
    if (validator.definite === true && _ctx === undefined)
      return false;
  }
  return validateFallback(schema, value, _ctx);
};
function validateFallback(schema, value, _ctx) {
  const ctx = _ctx ? { ..._ctx, async: false, abortEarly: true } : { async: false, abortEarly: true };
  const fallbackRun = schema._zod.bag.fallbackRun;
  let result;
  if (fallbackRun) {
    ctx[COMPILE_FALLBACK] = true;
    result = fallbackRun({ value, issues: [] }, ctx);
  } else {
    result = schema._zod.run({ value, issues: [] }, ctx);
  }
  if (result instanceof Promise) {
    throw new $ZodAsyncError;
  }
  return result.issues.length === 0;
}
var validateAsync = async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, async: true, abortEarly: true } : { async: true, abortEarly: true };
  let result = schema._zod.run({ value, issues: [] }, ctx);
  if (result instanceof Promise)
    result = await result;
  return result.issues.length === 0;
};
var _encode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return parse(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decode = (_Err) => {
  const parse = _parse(_Err);
  const fn = (schema, value, _ctx, _params) => {
    return parse(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _encodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
    return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _decodeAsync = (_Err) => {
  const parseAsync = _parseAsync(_Err);
  const fn = async (schema, value, _ctx, _params) => {
    return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
  };
  return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
  return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
  const ctx = _ctx ? { ..._ctx, direction: "backward" } : { direction: "backward" };
  return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
  return _safeParseAsync(_Err)(schema, value, _ctx);
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/regexes.js
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
  return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
var uuid = (version) => {
  if (!version)
    return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
  return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
var email = /^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji = `^(?=[\\s\\S]*[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\u20E3])[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
  return new RegExp(_emoji, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2,3})?$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
function anchor(source) {
  return new RegExp(`^${source}$`);
}
var date = /* @__PURE__ */ anchor(dateSource);
function timeSource(args) {
  const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
  const regex = typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
  return regex;
}
function time(args) {
  return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
  const opts = ["Z"];
  if (args.offset)
    opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
  const qualified = `${timeSource({ precision: args.precision, seconds: true })}(?:${opts.join("|")})`;
  const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
  return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var anyString = /^[\s\S]{0,}$/;
var integer = /^-?\d+$/;
var number = /^-?\d+(?:\.\d+)?$/;
var boolean = /^(?:true|false)$/i;
var _null = /^null$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/checks.js
var $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
  var _a;
  inst._zod ?? (inst._zod = {});
  inst._zod.def = def;
  (_a = inst._zod).onattach ?? (_a.onattach = []);
});
var _whenHasLength = (payload) => {
  const val = payload.value;
  return !nullish(val) && val.length !== undefined;
};
var numericOriginMap = {
  number: "number",
  bigint: "bigint",
  object: "date"
};
var $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value <= def.value : payload.value < def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_big",
      maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
  $ZodCheck.init(inst, def);
  const origin = numericOriginMap[typeof def.value];
  inst._zod.check = (payload) => {
    if (def.inclusive ? payload.value >= def.value : payload.value > def.value) {
      return;
    }
    payload.issues.push({
      origin: numericOriginMap[typeof payload.value] ?? origin,
      code: "too_small",
      minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
      input: payload.value,
      inclusive: def.inclusive,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    if (typeof payload.value !== typeof def.value)
      throw new Error("Cannot mix number and bigint in multiple_of check.");
    const isMultiple = typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0;
    if (isMultiple)
      return;
    payload.issues.push({
      origin: typeof payload.value,
      code: "not_multiple_of",
      divisor: def.value,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
  $ZodCheck.init(inst, def);
  def.format = def.format || "float64";
  const isInt = def.format?.includes("int");
  const origin = isInt ? "int" : "number";
  const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
  inst._zod.check = (payload) => {
    const input = payload.value;
    if (isInt) {
      if (!Number.isInteger(input)) {
        payload.issues.push({
          expected: origin,
          format: def.format,
          code: "invalid_type",
          continue: false,
          input,
          inst
        });
        return;
      }
      if (!Number.isSafeInteger(input)) {
        if (input > 0) {
          payload.issues.push({
            input,
            code: "too_big",
            maximum: Number.MAX_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        } else {
          payload.issues.push({
            input,
            code: "too_small",
            minimum: Number.MIN_SAFE_INTEGER,
            note: "Integers must be within the safe integer range.",
            inst,
            origin,
            inclusive: true,
            continue: !def.abort
          });
        }
        return;
      }
    }
    if (input < minimum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_small",
        minimum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
    if (input > maximum) {
      payload.issues.push({
        origin: "number",
        input,
        code: "too_big",
        maximum,
        inclusive: true,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units > def.maximum ? codePointLength(input) : units;
    if (length <= def.maximum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_big",
      maximum: def.maximum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units;
    if (length >= def.minimum)
      return;
    const origin = getLengthableOrigin(input);
    payload.issues.push({
      origin,
      code: "too_small",
      minimum: def.minimum,
      inclusive: true,
      input,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
  var _a;
  $ZodCheck.init(inst, def);
  (_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
  inst._zod.check = (payload) => {
    const input = payload.value;
    const units = input.length;
    const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
    if (length === def.length)
      return;
    const origin = getLengthableOrigin(input);
    const tooBig = length > def.length;
    payload.issues.push({
      origin,
      ...tooBig ? { code: "too_big", maximum: def.length } : { code: "too_small", minimum: def.length },
      inclusive: true,
      exact: true,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
  var _a, _b;
  $ZodCheck.init(inst, def);
  if (def.pattern)
    (_a = inst._zod).check ?? (_a.check = (payload) => {
      def.pattern.lastIndex = 0;
      if (def.pattern.test(payload.value))
        return;
      payload.issues.push({
        origin: "string",
        code: "invalid_format",
        format: def.format,
        input: payload.value,
        ...def.pattern ? { pattern: def.pattern.toString() } : {},
        inst,
        continue: !def.abort
      });
    });
  else
    (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    def.pattern.lastIndex = 0;
    if (def.pattern.test(payload.value))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "regex",
      input: payload.value,
      pattern: def.pattern.toString(),
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
  def.pattern ?? (def.pattern = lowercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
  def.pattern ?? (def.pattern = uppercase);
  $ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
  $ZodCheck.init(inst, def);
  const escapedRegex = escapeRegex(def.includes);
  const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
  def.pattern = pattern;
  inst._zod.check = (payload) => {
    if (payload.value.includes(def.includes, def.position))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "includes",
      includes: def.includes,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.startsWith(def.prefix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "starts_with",
      prefix: def.prefix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
  $ZodCheck.init(inst, def);
  const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
  def.pattern ?? (def.pattern = pattern);
  inst._zod.check = (payload) => {
    if (payload.value.endsWith(def.suffix))
      return;
    payload.issues.push({
      origin: "string",
      code: "invalid_format",
      format: "ends_with",
      suffix: def.suffix,
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
  $ZodCheck.init(inst, def);
  inst._zod.check = (payload) => {
    payload.value = def.tx(payload.value);
  };
});

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/doc.js
class Doc {
  constructor(args = [], closed = {}) {
    this.content = [];
    this.indent = 0;
    this.args = args;
    this.closed = closed;
  }
  indented(fn) {
    this.indent += 1;
    try {
      fn(this);
    } finally {
      this.indent -= 1;
    }
  }
  write(arg) {
    if (typeof arg === "function") {
      arg(this, { execution: "sync" });
      arg(this, { execution: "async" });
      return;
    }
    const content = arg;
    const lines = content.split(`
`).filter((x) => x);
    const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
    const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
    for (const line of dedented) {
      this.content.push(line);
    }
  }
  compile() {
    const F = Function;
    const content = this?.content ?? [``];
    const factory = new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {
${content.join(`
`)}
};`);
    return factory(...Object.values(this.closed));
  }
}

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/versions.js
var version = {
  major: 4,
  minor: 6,
  patch: 7
};

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/schemas.js
var $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
  var _a;
  inst ?? (inst = {});
  inst._zod.def = def;
  inst._zod.bag = inst._zod.bag || {};
  inst._zod.version = version;
  const defChecks = inst._zod.def.checks;
  const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
  for (const ch of checks) {
    for (const fn of ch._zod.onattach) {
      fn(inst);
    }
  }
  if (checks.length === 0) {
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred?.push(() => {
      inst._zod.run = inst._zod.parse;
    });
  } else {
    const runChecks = (payload, checks, ctx) => {
      if (payload.memo)
        return payload;
      let isAborted = aborted(payload);
      let asyncResult;
      for (const ch of checks) {
        if (ch._zod.def.when) {
          if (explicitlyAborted(payload))
            continue;
          const shouldRun = ch._zod.def.when(payload);
          if (!shouldRun)
            continue;
        } else if (isAborted) {
          continue;
        }
        const currLen = payload.issues.length;
        const _ = ch._zod.check(payload);
        if (_ instanceof Promise && ctx?.async === false) {
          throw new $ZodAsyncError;
        }
        if (asyncResult || _ instanceof Promise) {
          asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
            await _;
            const nextLen = payload.issues.length;
            if (nextLen === currLen)
              return;
            attachSchema(payload.issues, currLen, inst);
            if (!isAborted)
              isAborted = aborted(payload, currLen);
          });
        } else {
          const nextLen = payload.issues.length;
          if (nextLen === currLen)
            continue;
          attachSchema(payload.issues, currLen, inst);
          if (!isAborted)
            isAborted = aborted(payload, currLen);
        }
      }
      if (asyncResult) {
        return asyncResult.then(() => {
          return payload;
        });
      }
      return payload;
    };
    const handleCanaryResult = (canary, payload, ctx) => {
      if (aborted(canary)) {
        canary.aborted = true;
        return canary;
      }
      const checkResult = runChecks(payload, checks, ctx);
      if (checkResult instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
      }
      return inst._zod.parse(checkResult, ctx);
    };
    inst._zod.run = (payload, ctx) => {
      if (ctx.skipChecks) {
        return inst._zod.parse(payload, ctx);
      }
      if (ctx.direction === "backward") {
        const canary = inst._zod.parse({ value: payload.value, issues: [] }, { ...ctx, skipChecks: true });
        if (canary instanceof Promise) {
          return canary.then((canary) => {
            return handleCanaryResult(canary, payload, ctx);
          });
        }
        return handleCanaryResult(canary, payload, ctx);
      }
      const result = inst._zod.parse(payload, ctx);
      if (result instanceof Promise) {
        if (ctx.async === false)
          throw new $ZodAsyncError;
        return result.then((result) => runChecks(result, checks, ctx));
      }
      return runChecks(result, checks, ctx);
    };
  }
}, {
  get "~standard"() {
    return hide(this, "~standard", standardProps(this));
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  }
});
var toStandardResult = (r, ctx) => r.issues.length ? { issues: r.issues.map((iss) => finalizeIssue(iss, ctx, config())) } : { value: r.value };
async function validateAsync2(inst, value) {
  const ctx = { async: true };
  return toStandardResult(await inst._zod.run({ value, issues: [] }, ctx), ctx);
}
function standardProps(inst) {
  return {
    validate: (value) => {
      const ctx = { async: false };
      try {
        const r = inst._zod.run({ value, issues: [] }, ctx);
        if (!(r instanceof Promise))
          return toStandardResult(r, ctx);
      } catch (_) {}
      return validateAsync2(inst, value);
    },
    vendor: "zod",
    version: 1
  };
}
var $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = def.pattern ?? anyString;
  inst._zod.parse = (payload, _) => {
    if (def.coerce)
      try {
        payload.value = String(payload.value);
      } catch (_) {}
    if (typeof payload.value === "string")
      return payload;
    payload.issues.push({
      expected: "string",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
var $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
  $ZodCheckStringFormat.init(inst, def);
  $ZodString.init(inst, def);
});
var $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
  def.pattern ?? (def.pattern = guid);
  $ZodStringFormat.init(inst, def);
});
var $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
  if (def.version) {
    const versionMap = {
      v1: 1,
      v2: 2,
      v3: 3,
      v4: 4,
      v5: 5,
      v6: 6,
      v7: 7,
      v8: 8
    };
    const v = versionMap[def.version];
    if (v === undefined)
      throw new Error(`Invalid UUID version: "${def.version}"`);
    def.pattern ?? (def.pattern = uuid(v));
  } else
    def.pattern ?? (def.pattern = uuid());
  $ZodStringFormat.init(inst, def);
});
var $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
  def.pattern ?? (def.pattern = email);
  $ZodStringFormat.init(inst, def);
});
var URL_BAD_FORMAT = 1;
var URL_UNPARSEABLE = 2;
function canParseURL(input) {
  try {
    if (typeof URL !== "undefined" && typeof URL.canParse === "function")
      return URL.canParse(input);
    new URL(input);
    return true;
  } catch {
    return false;
  }
}
function validateURL(trimmed, def) {
  if (!("normalize" in def) && !("hostname" in def) && !("protocol" in def)) {
    return canParseURL(trimmed) || URL_UNPARSEABLE;
  }
  return parseURLObject(trimmed, def);
}
function parseURLObject(trimmed, def) {
  if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) {
    return URL_BAD_FORMAT;
  }
  try {
    if (typeof URL !== "undefined") {
      const URLStatic = URL;
      if (typeof URLStatic.parse === "function")
        return URLStatic.parse(trimmed) ?? URL_UNPARSEABLE;
    }
    return new URL(trimmed);
  } catch {
    return URL_UNPARSEABLE;
  }
}
var asciiTabOrNewline = /[\t\n\r]/g;
function stripTabAndNewline(value) {
  return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
  hostname.lastIndex = 0;
  return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
  protocol.lastIndex = 0;
  return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    try {
      const trimmed = payload.value.trim();
      const url = validateURL(trimmed, def);
      if (url === URL_BAD_FORMAT) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid URL format",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === URL_UNPARSEABLE) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          input: payload.value,
          inst,
          continue: !def.abort
        });
        return;
      }
      if (url === true) {
        payload.value = stripTabAndNewline(trimmed);
        return;
      }
      if (def.hostname && !urlHostnameOk(url, def.hostname)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid hostname",
          pattern: def.hostname.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      if (def.protocol && !urlProtocolOk(url, def.protocol)) {
        payload.issues.push({
          code: "invalid_format",
          format: "url",
          note: "Invalid protocol",
          pattern: def.protocol.source,
          input: payload.value,
          inst,
          continue: !def.abort
        });
      }
      payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
      return;
    } catch (_) {
      payload.issues.push({
        code: "invalid_format",
        format: "url",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
  def.pattern ?? (def.pattern = emoji());
  $ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
  if (def.length !== undefined && (!Number.isInteger(def.length) || def.length < 1))
    throw new Error(`Invalid nanoid length: ${def.length}`);
  def.pattern ?? (def.pattern = def.length === undefined ? nanoid : nanoidOfLength(def.length));
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
  def.pattern ?? (def.pattern = cuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
  def.pattern ?? (def.pattern = cuid2);
  $ZodStringFormat.init(inst, def);
});
var $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
  def.pattern ?? (def.pattern = ulid);
  $ZodStringFormat.init(inst, def);
});
var $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
  def.pattern ?? (def.pattern = xid);
  $ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
  def.pattern ?? (def.pattern = ksuid);
  $ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
  def.pattern ?? (def.pattern = datetime(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
  def.pattern ?? (def.pattern = date);
  $ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
  def.pattern ?? (def.pattern = time(def));
  $ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
  def.pattern ?? (def.pattern = duration);
  $ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
  def.pattern ?? (def.pattern = ipv4);
  $ZodStringFormat.init(inst, def);
});
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
  if (!ipv6Alphabet.test(value))
    return false;
  return canParseURL(`http://[${value}]`);
}
var $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
  def.pattern ?? (def.pattern = ipv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidIPv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "ipv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
var $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv4);
  $ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
  const parts = value.split("/");
  if (parts.length !== 2)
    return false;
  const [address, prefix] = parts;
  if (!prefix)
    return false;
  const prefixNum = Number(prefix);
  if (`${prefixNum}` !== prefix)
    return false;
  if (prefixNum < 0 || prefixNum > 128)
    return false;
  return isValidIPv6(address);
}
var $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
  def.pattern ?? (def.pattern = cidrv6);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (!isValidCIDRv6(payload.value)) {
      payload.issues.push({
        code: "invalid_format",
        format: "cidrv6",
        input: payload.value,
        inst,
        continue: !def.abort
      });
    }
  };
});
function isValidBase64(data) {
  if (data === "")
    return true;
  if (/\s/.test(data))
    return false;
  if (data.length % 4 !== 0)
    return false;
  try {
    atob(data);
    return true;
  } catch {
    return false;
  }
}
var base64Charset = /^[0-9a-zA-Z+/]*={0,2}$/;
var $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
  def.pattern ?? (def.pattern = base64Charset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var base64urlCharset = /^[A-Za-z0-9_-]*$/;
function isValidBase64URL(data) {
  if (!base64urlCharset.test(data))
    return false;
  const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return isValidBase64(padded);
}
var $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
  def.pattern ?? (def.pattern = base64urlCharset);
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidBase64URL(payload.value))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "base64url",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
  def.pattern ?? (def.pattern = e164);
  $ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
  try {
    const tokensParts = token.split(".");
    if (tokensParts.length !== 3)
      return false;
    const [header] = tokensParts;
    if (!header)
      return false;
    const parsedHeader = JSON.parse(atob(header));
    if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT")
      return false;
    if (!parsedHeader.alg)
      return false;
    if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm))
      return false;
    return true;
  } catch {
    return false;
  }
}
var $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  inst._zod.check = (payload) => {
    if (isValidJWT(payload.value, def.alg))
      return;
    payload.issues.push({
      code: "invalid_format",
      format: "jwt",
      input: payload.value,
      inst,
      continue: !def.abort
    });
  };
});
var $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = number;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Number(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) {
      return payload;
    }
    const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : undefined : undefined;
    payload.issues.push({
      expected: "number",
      code: "invalid_type",
      input,
      inst,
      ...received ? { received } : {}
    });
    return payload;
  };
});
var $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
  $ZodCheckNumberFormat.init(inst, def);
  $ZodNumber.init(inst, def);
});
var $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = boolean;
  inst._zod.parse = (payload, _ctx) => {
    if (def.coerce)
      try {
        payload.value = Boolean(payload.value);
      } catch (_) {}
    const input = payload.value;
    if (typeof input === "boolean")
      return payload;
    payload.issues.push({
      expected: "boolean",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodNull = /* @__PURE__ */ $constructor("$ZodNull", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.pattern = _null;
  inst._zod.values = new Set([null]);
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (input === null)
      return payload;
    payload.issues.push({
      expected: "null",
      code: "invalid_type",
      input,
      inst
    });
    return payload;
  };
});
var $ZodAny = /* @__PURE__ */ $constructor("$ZodAny", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload) => payload;
});
var $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _ctx) => {
    payload.issues.push({
      expected: "never",
      code: "invalid_type",
      input: payload.value,
      inst
    });
    return payload;
  };
});
function capSize(inst, size) {
  const caps = sizeCaps(inst._zod.def.checks);
  if (!caps.length)
    return;
  const cap = Math.min(...caps.map((c) => c[0]));
  const parse = inst._zod.parse;
  inst._zod.parse = (payload, ctx) => {
    const n = size(payload.value);
    if (n > cap && !ctx?.skipChecks && ctx?.direction !== "backward") {
      for (const [max, ch] of sizeCaps(inst._zod.def.checks)) {
        if (n > max && ch._zod.def.when(payload)) {
          const start = payload.issues.length;
          ch._zod.check(payload);
          payload.issues[start].continue = false;
          attachSchema(payload.issues, start, inst);
          return payload;
        }
      }
    }
    return parse(payload, ctx);
  };
}
var arraySize = (input) => Array.isArray(input) ? input.length : -1;
function handleArrayResult(result, final, index) {
  if (result.issues.length) {
    final.issues.push(...prefixIssues(index, result.issues));
  }
  final.value[index] = result.value;
}
var $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({
        expected: "array",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
    const proms = [];
    const abortEarly = ctx?.abortEarly;
    for (let i = 0;i < input.length; i++) {
      const item = input[i];
      const result = def.element._zod.run({
        value: item,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        proms.push(result.then((result) => handleArrayResult(result, payload, i)));
      } else {
        handleArrayResult(result, payload, i);
        if (abortEarly && result.issues.length !== 0 && aborted(result))
          break;
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
  capSize(inst, arraySize);
});
function handlePropertyResult(result, final, key, input, optin, optout) {
  const isPresent = key in input;
  const isOptionalOut = optout === "optional";
  if (!isPresent && isOptionalOut && optin === "optional") {
    return;
  }
  if (result.issues.length) {
    if (optin !== undefined && isOptionalOut && !isPresent) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!isPresent && optin === undefined) {
    if (!result.issues.length) {
      final.issues.push({
        code: "invalid_type",
        expected: "nonoptional",
        input: undefined,
        path: [key]
      });
    }
    return;
  }
  if (result.value === undefined) {
    if (isPresent || optin === "defaulted" && !isOptionalOut) {
      final.value[key] = undefined;
    }
  } else {
    final.value[key] = result.value;
  }
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
  const keys = Object.keys(def.shape);
  const ownSymbols = Object.getOwnPropertySymbols(def.shape);
  const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
  const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
  for (const k of allKeys) {
    if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) {
      throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
    }
  }
  const okeys = optionalKeys(def.shape);
  return {
    ...def,
    allKeys,
    symbolKeys,
    keySet: new Set(keys),
    numKeys: keys.length,
    optionalKeys: new Set(okeys)
  };
}
function handleCatchall(proms, input, payload, ctx, def, inst, abortEarly) {
  const unrecognized = [];
  const keySet = def.keySet;
  const _catchall = def.catchall._zod;
  const t = _catchall.def.type;
  const optin = _catchall.optin;
  const optout = _catchall.optout;
  let seen = 0;
  for (const key in input) {
    if (abortEarly && payload.issues.length !== seen) {
      if (aborted(payload, seen))
        break;
      seen = payload.issues.length;
    }
    if (keySet.has(key))
      continue;
    if (key === "__proto__") {
      if (t === "never")
        unrecognized.push(key);
      continue;
    }
    if (t === "never") {
      unrecognized.push(key);
      continue;
    }
    const r = _catchall.run({ value: input[key], issues: [] }, ctx);
    if (r instanceof Promise) {
      proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
    } else {
      handlePropertyResult(r, payload, key, input, optin, optout);
    }
  }
  if (unrecognized.length) {
    payload.issues.push({
      code: "unrecognized_keys",
      keys: unrecognized,
      input,
      inst,
      continue: true
    });
  }
  if (!proms.length)
    return payload;
  return Promise.all(proms).then(() => {
    return payload;
  });
}
var $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
  $ZodType.init(inst, def);
  const desc = Object.getOwnPropertyDescriptor(def, "shape");
  const sh = desc?.get ? desc.get.raw : def.shape ?? {};
  if (sh) {
    const get = () => {
      const newSh = { ...sh };
      Object.defineProperty(def, "shape", { value: newSh });
      get.raw = newSh;
      return newSh;
    };
    get.raw = sh;
    Object.defineProperty(def, "shape", { get });
  }
  const _normalized = cached(() => normalizeDef(def));
  defineLazyInternal(inst, "propValues", (zod) => {
    const shape = zod.def.shape;
    const propValues = {};
    for (const key in shape) {
      const field = shape[key]._zod;
      if (field.values) {
        if (!Object.prototype.hasOwnProperty.call(propValues, key)) {
          assignProp(propValues, key, new Set);
        }
        for (const v of field.values)
          propValues[key].add(v);
        if (field.optin !== undefined)
          propValues[key].add(undefined);
      }
    }
    return propValues;
  });
  const isObject2 = isObject;
  const catchall = def.catchall;
  let value;
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
    const proms = [];
    const shape = value.shape;
    const abortEarly = ctx?.abortEarly;
    let seen = payload.issues.length;
    for (const key of value.allKeys) {
      if (abortEarly && payload.issues.length !== seen) {
        if (aborted(payload, seen))
          break;
        seen = payload.issues.length;
      }
      if (key === "__proto__")
        continue;
      const el = shape[key];
      const optin = el._zod.optin;
      const optout = el._zod.optout;
      const r = el._zod.run({ value: input[key], issues: [] }, ctx);
      if (r instanceof Promise) {
        proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
      } else {
        handlePropertyResult(r, payload, key, input, optin, optout);
      }
    }
    if (!catchall) {
      return proms.length ? Promise.all(proms).then(() => payload) : payload;
    }
    return handleCatchall(proms, input, payload, ctx, _normalized.value, inst, abortEarly === true);
  };
});
var $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
  $ZodObject.init(inst, def);
  const superParse = inst._zod.parse;
  const _normalized = cached(() => normalizeDef(def));
  const memo = globalConfig.memoizer;
  const generateFastpass = (shape) => {
    const normalized = _normalized.value;
    const syms = normalized.symbolKeys;
    const doc = new Doc(["payload", "ctx"], { shape, inst, memo, syms });
    const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
    const prefixStr = (id, k) => `
          let ${id}_ab = false;
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
            if (iss.continue !== true) ${id}_ab = true;
          }
          if (${id}_ab && ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }`;
    doc.write(`const input = payload.value;`);
    const ids = Object.create(null);
    let counter = 0;
    for (const key of normalized.allKeys) {
      ids[key] = `key_${counter++}`;
    }
    doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
    for (const key of normalized.allKeys) {
      if (key === "__proto__")
        continue;
      const id = ids[key];
      const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
      const isPresent = `${k} in input`;
      const schema = shape[key];
      const optin = schema?._zod?.optin;
      const isOptionalIn = optin !== undefined;
      const isOptionalOut = schema?._zod?.optout === "optional";
      doc.write(`const ${id} = ${parseStr(k)};`);
      if (isOptionalIn && isOptionalOut) {
        const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
        doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
      } else if (!isOptionalIn) {
        doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
          if (ctx && ctx.abortEarly) {
            payload.value = newResult;
            return payload;
          }
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
      } else {
        doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
      `);
        if (optin === "defaulted") {
          doc.write(`newResult[${k}] = ${id}.value;`);
        } else {
          doc.write(`
        if (${id}.value !== undefined || ${isPresent}) {
          newResult[${k}] = ${id}.value;
        }
      `);
        }
      }
    }
    doc.write(`payload.value = newResult;`);
    doc.write(`return payload;`);
    return doc.compile();
  };
  let fastpass;
  const isObject2 = isObject;
  const jit = !globalConfig.jitless;
  const allowsEval2 = allowsEval;
  const fastEnabled = jit && allowsEval2.value;
  const catchall = def.catchall;
  let value;
  inst._zod.parse = (payload, ctx) => {
    value ?? (value = _normalized.value);
    const input = payload.value;
    if (!isObject2(input)) {
      payload.issues.push({
        expected: "object",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
      if (!fastpass)
        fastpass = generateFastpass(def.shape);
      payload = fastpass(payload, ctx);
      if (!catchall)
        return payload;
      return handleCatchall([], input, payload, ctx, value, inst, ctx?.abortEarly === true);
    }
    return superParse(payload, ctx);
  };
});
function handleUnionResults(results, final, inst, ctx) {
  for (const result of results) {
    if (result.issues.length === 0) {
      final.value = result.value;
      return final;
    }
  }
  const nonaborted = results.filter((r) => !aborted(r));
  if (nonaborted.length === 1) {
    final.value = nonaborted[0].value;
    return nonaborted[0];
  }
  final.issues.push({
    code: "invalid_union",
    input: final.value,
    inst,
    errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
  });
  return final;
}
var $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== undefined) ? "optional" : undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : undefined);
  defineLazyInternal(inst, "values", (zod) => {
    if (zod.def.options.every((o) => o._zod.values)) {
      return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
    }
    return;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    if (zod.def.options.every((o) => o._zod.pattern)) {
      const patterns = zod.def.options.map((o) => o._zod.pattern);
      return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
    }
    return;
  });
  const first = def.options.length === 1 ? def.options[0]._zod.run : null;
  inst._zod.parse = (payload, ctx) => {
    if (first) {
      return first(payload, ctx);
    }
    let async = false;
    const results = [];
    for (const option of def.options) {
      const result = option._zod.run({
        value: payload.value,
        issues: []
      }, ctx);
      if (result instanceof Promise) {
        results.push(result);
        async = true;
      } else {
        if (result.issues.length === 0)
          return result;
        results.push(result);
      }
    }
    if (!async)
      return handleUnionResults(results, payload, inst, ctx);
    return Promise.all(results).then((results) => {
      return handleUnionResults(results, payload, inst, ctx);
    });
  };
});
function discriminatorMap(def) {
  const map = new Map;
  for (const option of def.options) {
    const values = option._zod.propValues?.[def.discriminator];
    if (!values || values.size === 0)
      throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
    for (const value of values) {
      if (map.has(value)) {
        if (value !== undefined)
          throw new Error(`Duplicate discriminator value "${String(value)}"`);
        map.set(value, null);
      } else {
        map.set(value, option);
      }
    }
  }
  return map;
}
var $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
  def.inclusive = false;
  $ZodUnion.init(inst, def);
  const _super = inst._zod.parse;
  defineLazyInternal(inst, "propValues", (zod) => {
    const propValues = {};
    let undefinedCount = 0;
    for (const option of zod.def.options) {
      const pv = option._zod.propValues;
      if (!pv || Object.keys(pv).length === 0)
        throw new Error(`Invalid discriminated union option at index "${zod.def.options.indexOf(option)}"`);
      if (pv[zod.def.discriminator]?.has(undefined))
        undefinedCount++;
      for (const [k, v] of Object.entries(pv)) {
        if (!Object.prototype.hasOwnProperty.call(propValues, k)) {
          assignProp(propValues, k, new Set);
        }
        for (const val of v) {
          propValues[k].add(val);
        }
      }
    }
    if (!zod.def.unionFallback && undefinedCount > 1)
      propValues[zod.def.discriminator]?.delete(undefined);
    return propValues;
  });
  def.options.forEach((option, i) => {
    const propShape = rawShape(option._zod.def);
    if (propShape && !Object.prototype.hasOwnProperty.call(propShape, def.discriminator)) {
      throw new Error(`Invalid discriminated union option at index "${i}"`);
    }
  });
  const disc = cached(() => discriminatorMap(def));
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({
        code: "invalid_type",
        expected: "object",
        input,
        inst
      });
      return payload;
    }
    const value = input?.[def.discriminator];
    const opt = disc.value.get(value);
    if (opt && (value !== undefined || ctx.direction !== "backward")) {
      return opt._zod.run(payload, ctx);
    }
    if (def.unionFallback || ctx.direction === "backward") {
      return _super(payload, ctx);
    }
    payload.issues.push({
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: def.discriminator,
      options: Array.from(disc.value.keys()).filter((value) => disc.value.get(value) !== null),
      input,
      path: [def.discriminator],
      inst
    });
    return payload;
  };
});
var $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    const left = def.left._zod.run({ value: input, issues: [] }, ctx);
    const right = def.right._zod.run({ value: input, issues: [] }, ctx);
    const async = left instanceof Promise || right instanceof Promise;
    if (async) {
      return Promise.all([left, right]).then(([left, right]) => {
        return handleIntersectionResults(payload, left, right);
      });
    }
    return handleIntersectionResults(payload, left, right);
  };
});
function mergeValues(a, b) {
  if (a === b) {
    return { valid: true, data: a };
  }
  if (a instanceof Date && b instanceof Date && +a === +b) {
    return { valid: true, data: a };
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const bKeys = Object.keys(b);
    const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    if (Object.prototype.hasOwnProperty.call(newObj, "__proto__"))
      delete newObj.__proto__;
    for (const key of sharedKeys) {
      if (key === "__proto__")
        continue;
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
        };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return { valid: false, mergeErrorPath: [] };
    }
    const newArray = [];
    for (let index = 0;index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return {
          valid: false,
          mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
        };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  }
  return { valid: false, mergeErrorPath: [] };
}
function handleIntersectionResults(result, left, right) {
  const unrecKeys = new Map;
  let unrecIssue;
  const keyIssues = new Map;
  const collect = (iss, side) => {
    let keys;
    if (iss.code === "unrecognized_keys" && !iss.path?.length) {
      unrecIssue ?? (unrecIssue = iss);
      keys = iss.keys;
    } else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
      const k = String(iss.path[0]);
      if (!keyIssues.has(k))
        keyIssues.set(k, iss);
      keys = [k];
    } else {
      return false;
    }
    for (const k of keys) {
      if (!unrecKeys.has(k))
        unrecKeys.set(k, {});
      unrecKeys.get(k)[side] = true;
    }
    return true;
  };
  for (const iss of left.issues) {
    if (!collect(iss, "l"))
      result.issues.push(iss);
  }
  for (const iss of right.issues) {
    if (!collect(iss, "r"))
      result.issues.push(iss);
  }
  const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
  if (bothKeys.length) {
    const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
    if (aggregated.length)
      result.issues.push({ ...unrecIssue, keys: aggregated });
    for (const k of bothKeys) {
      if (!aggregated.includes(k) && keyIssues.has(k))
        result.issues.push(keyIssues.get(k));
    }
  }
  const merged = mergeValues(left.value, right.value);
  if (!merged.valid) {
    if (aborted(result))
      return result;
    throw new Error(`Unmergable intersection. Error path: ` + `${JSON.stringify(merged.mergeErrorPath)}`);
  }
  result.value = merged.data;
  return result;
}
var $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
  $ZodType.init(inst, def);
  const memo = globalConfig.memoizer;
  memo?.attach(inst);
  inst._zod.parse = (payload, ctx) => {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({
        expected: "record",
        code: "invalid_type",
        input,
        inst
      });
      return payload;
    }
    const proms = [];
    const values = def.keyType._zod.values;
    if (values && !def.partial) {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      const recordKeys = new Set;
      for (const key of values) {
        if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
          recordKeys.add(typeof key === "number" ? key.toString() : key);
          if (key === "__proto__")
            continue;
          const keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
          if (keyResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (keyResult.issues.length) {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
            continue;
          }
          const outKey = keyResult.value;
          if (outKey === "__proto__")
            continue;
          const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
          if (result instanceof Promise) {
            proms.push(result.then((result) => {
              if (result.issues.length) {
                payload.issues.push(...prefixIssues(key, result.issues));
              }
              payload.value[outKey] = result.value;
            }));
          } else {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }
        }
      }
      let unrecognized;
      for (const key in input) {
        if (!recordKeys.has(key)) {
          if (def.mode === "loose") {
            if (key === "__proto__")
              continue;
            payload.value[key] = input[key];
          } else {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          }
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    } else {
      payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
      let unrecognized;
      for (const key of Reflect.ownKeys(input)) {
        if (key === "__proto__")
          continue;
        if (!Object.prototype.propertyIsEnumerable.call(input, key))
          continue;
        let keyResult = def.keyType._zod.run({ value: key, issues: [] }, ctx);
        if (keyResult instanceof Promise) {
          throw new Error("Async schemas not supported in object keys currently");
        }
        const checkNumericKey = typeof key === "string" && number.test(key) && keyResult.issues.length;
        if (checkNumericKey) {
          const retryResult = def.keyType._zod.run({ value: Number(key), issues: [] }, ctx);
          if (retryResult instanceof Promise) {
            throw new Error("Async schemas not supported in object keys currently");
          }
          if (retryResult.issues.length === 0) {
            keyResult = retryResult;
          }
        }
        if (keyResult.issues.length) {
          if (def.mode === "loose") {
            payload.value[key] = input[key];
          } else if (values) {
            unrecognized = unrecognized ?? [];
            unrecognized.push(key);
          } else {
            payload.issues.push({
              code: "invalid_key",
              origin: "record",
              issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
              input: key,
              path: [key],
              inst
            });
          }
          continue;
        }
        const outKey = keyResult.value;
        if (outKey === "__proto__")
          continue;
        const result = def.valueType._zod.run({ value: input[key], issues: [] }, ctx);
        if (result instanceof Promise) {
          proms.push(result.then((result) => {
            if (result.issues.length) {
              payload.issues.push(...prefixIssues(key, result.issues));
            }
            payload.value[outKey] = result.value;
          }));
        } else {
          if (result.issues.length) {
            payload.issues.push(...prefixIssues(key, result.issues));
          }
          payload.value[outKey] = result.value;
        }
      }
      if (unrecognized && unrecognized.length > 0) {
        payload.issues.push({
          code: "unrecognized_keys",
          input,
          inst,
          keys: unrecognized,
          continue: true
        });
      }
    }
    if (proms.length) {
      return Promise.all(proms).then(() => payload);
    }
    return payload;
  };
});
var $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
  $ZodType.init(inst, def);
  const values = getEnumValues(def.entries);
  const valuesSet = new Set(values);
  inst._zod.values = valuesSet;
  defineLazyInternal(inst, "pattern", (zod) => {
    const patternValues = getEnumValues(zod.def.entries).filter((k) => propertyKeyTypes.has(typeof k));
    return new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (valuesSet.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
  $ZodType.init(inst, def);
  const values = new Set(def.values);
  inst._zod.values = values;
  defineLazyInternal(inst, "pattern", (zod) => {
    const vals = zod.def.values;
    return new RegExp(vals.length ? `^(${vals.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$` : "^[^\\s\\S]$");
  });
  inst._zod.parse = (payload, _ctx) => {
    const input = payload.value;
    if (values.has(input)) {
      return payload;
    }
    payload.issues.push({
      code: "invalid_value",
      values: def.values,
      input,
      inst
    });
    return payload;
  };
});
var $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "optional";
  globalConfig.memoizer?.guard(inst);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    const _out = def.transform(payload.value, payload);
    if (ctx.async) {
      const output = _out instanceof Promise ? _out : Promise.resolve(_out);
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    if (_out instanceof Promise) {
      throw new $ZodAsyncError;
    }
    payload.value = _out;
    return payload;
  };
});
function handleOptionalResult(payload, result) {
  payload.value = result.issues.length ? undefined : result.value;
  return payload;
}
var $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  inst._zod.optout = "optional";
  defineLazyInternal(inst, "values", (zod) => {
    const values = zod.def.innerType._zod.values;
    return values ? new Set([...values, undefined]) : undefined;
  });
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === undefined) {
      if (def.innerType._zod.optin !== "defaulted")
        return payload;
      const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
      if (result instanceof Promise)
        return result.then((result) => handleOptionalResult(payload, result));
      return handleOptionalResult(payload, result);
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
  inst._zod.parse = (payload, ctx) => {
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "pattern", (zod) => {
    const pattern = zod.def.innerType._zod.pattern;
    return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : undefined;
  });
  defineLazyInternal(inst, "values", (zod) => {
    return zod.def.innerType._zod.values ? new Set([...zod.def.innerType._zod.values, null]) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    if (payload.value === null)
      return payload;
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
      return payload;
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleDefaultResult(result, def));
    }
    return handleDefaultResult(result, def);
  };
});
function handleDefaultResult(payload, def) {
  if (payload.value === undefined) {
    payload.value = def.defaultValue;
  }
  return payload;
}
var $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
  $ZodType.init(inst, def);
  inst._zod.optin = "defaulted";
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    if (payload.value === undefined) {
      payload.value = def.defaultValue;
    }
    return def.innerType._zod.run(payload, ctx);
  };
});
var $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => {
    const v = zod.def.innerType._zod.values;
    return v ? new Set([...v].filter((x) => x !== undefined)) : undefined;
  });
  inst._zod.parse = (payload, ctx) => {
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleNonOptionalResult(result, inst));
    }
    return handleNonOptionalResult(result, inst);
  };
});
function handleNonOptionalResult(payload, inst) {
  if (!payload.issues.length && payload.value === undefined) {
    payload.issues.push({
      code: "invalid_type",
      expected: "nonoptional",
      input: payload.value,
      inst
    });
  }
  return payload;
}
function handleCatchResult(payload, result, def, ctx) {
  if (!result.issues.length) {
    payload.value = result.value;
    if (result.memo)
      payload.memo = true;
    return payload;
  }
  payload.value = def.catchValue({
    ...result,
    value: payload.value,
    error: {
      issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config()))
    },
    input: payload.value
  });
  return payload;
}
var $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run({ value: payload.value, issues: [] }, ctx);
    if (result instanceof Promise) {
      return result.then((result) => handleCatchResult(payload, result, def, ctx));
    }
    return handleCatchResult(payload, result, def, ctx);
  };
});
var $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      const right = def.out._zod.run(payload, ctx);
      if (right instanceof Promise) {
        return right.then((right) => handlePipeResult(right, def.in, ctx));
      }
      return handlePipeResult(right, def.in, ctx);
    }
    const left = def.in._zod.run(payload, ctx);
    if (left instanceof Promise) {
      return left.then((left) => handlePipeResult(left, def.out, ctx));
    }
    return handlePipeResult(left, def.out, ctx);
  };
});
function handlePipeResult(left, next, ctx) {
  if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
    left.aborted = true;
    return left;
  }
  return next._zod.run({ value: left.value, issues: left.issues }, ctx);
}
var $ZodPreprocess = /* @__PURE__ */ $constructor("$ZodPreprocess", (inst, def) => {
  $ZodPipe.init(inst, def);
});
var $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
  defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
  defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
  defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
  inst._zod.parse = (payload, ctx) => {
    if (ctx.direction === "backward") {
      return def.innerType._zod.run(payload, ctx);
    }
    const result = def.innerType._zod.run(payload, ctx);
    if (result instanceof Promise) {
      return result.then(handleReadonlyResult);
    }
    return handleReadonlyResult(result);
  };
});
function handleReadonlyResult(payload) {
  if (!payload.memo)
    payload.value = Object.freeze(payload.value);
  return payload;
}
var $ZodLazy = /* @__PURE__ */ $constructor("$ZodLazy", (inst, def) => {
  $ZodType.init(inst, def);
  defineLazy(inst._zod, "innerType", () => {
    const d = def;
    if (!d._cachedInner)
      d._cachedInner = def.getter();
    return d._cachedInner;
  });
  defineLazyInternal(inst, "pattern", (zod) => zod.innerType?._zod?.pattern);
  defineLazyInternal(inst, "propValues", (zod) => zod.innerType?._zod?.propValues);
  defineLazyInternal(inst, "optin", (zod) => zod.innerType?._zod?.optin ?? undefined);
  defineLazyInternal(inst, "optout", (zod) => zod.innerType?._zod?.optout ?? undefined);
  inst._zod.parse = (payload, ctx) => {
    const inner = inst._zod.innerType;
    return inner._zod.run(payload, ctx);
  };
});
var $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
  $ZodCheck.init(inst, def);
  $ZodType.init(inst, def);
  inst._zod.parse = (payload, _) => {
    return payload;
  };
  inst._zod.check = (payload) => {
    const input = payload.value;
    const r = def.fn(input);
    if (r instanceof Promise) {
      return r.then((r) => handleRefineResult(r, payload, input, inst));
    }
    handleRefineResult(r, payload, input, inst);
    return;
  };
});
function handleRefineResult(result, payload, input, inst) {
  if (!result) {
    const _iss = {
      code: "custom",
      input,
      inst,
      path: [...inst._zod.def.path ?? []],
      continue: !inst._zod.def.abort
    };
    if (inst._zod.def.params)
      _iss.params = inst._zod.def.params;
    payload.issues.push(issue(_iss));
  }
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/memoizer.js
class $ZodCyclicError extends Error {
  constructor() {
    super(`Cannot parse a reference cycle that closes through a transform`);
    this.name = "ZodCyclicError";
  }
}
var STATE = "~memo";
var NO_ISSUES = [];
function isRef(value) {
  return value !== null && typeof value === "object";
}
function cloneIssues(issues) {
  return issues.map((iss) => iss.path ? { ...iss, path: iss.path.slice() } : { ...iss });
}
var recursive = /* @__PURE__ */ new WeakMap;
var NONE = 0;
var ASSUMED = 1;
var PROVEN = 2;
function isRecursive(inst, stack, resolve) {
  const cached = recursive.get(inst);
  if (cached !== undefined)
    return cached ? PROVEN : NONE;
  if (stack.has(inst))
    return PROVEN;
  stack.add(inst);
  let result = NONE;
  const check = (child) => {
    if (result !== PROVEN && child?._zod) {
      const answer = isRecursive(child, stack, resolve);
      if (answer > result)
        result = answer;
    }
  };
  const shape = (sh, spread) => {
    let answer = NONE;
    for (const key of Reflect.ownKeys(sh)) {
      const desc = Object.getOwnPropertyDescriptor(sh, key);
      if (spread && !desc.enumerable)
        continue;
      const child = desc.get ? ASSUMED : desc.value?._zod ? isRecursive(desc.value, stack, resolve) : NONE;
      if (child > answer)
        answer = child;
    }
    return answer;
  };
  const merge = (answer) => {
    if (answer > result)
      result = answer;
  };
  const def = inst._zod.def;
  const kind = def.type;
  switch (kind) {
    case "object": {
      const raw = rawShape(def);
      merge(raw ? shape(raw, true) : ASSUMED);
      check(def.catchall);
      break;
    }
    case "array":
      check(def.element);
      break;
    case "tuple":
      for (const el of def.items)
        check(el);
      check(def.rest);
      break;
    case "record":
    case "map":
      check(def.keyType);
      check(def.valueType);
      break;
    case "set":
      check(def.valueType);
      break;
    case "union":
      for (const el of def.options)
        check(el);
      break;
    case "intersection":
      check(def.left);
      check(def.right);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "promise":
    case "success":
      check(def.innerType);
      break;
    case "pipe":
      check(def.in);
      check(def.out);
      break;
    case "function":
      check(def.input);
      check(def.output);
      break;
    case "lazy": {
      const inner = def._cachedInner ?? (resolve ? inst._zod.innerType : undefined);
      merge(inner ? isRecursive(inner, stack, false) : ASSUMED);
      break;
    }
    case "template_literal":
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "bigint":
    case "symbol":
    case "undefined":
    case "null":
    case "void":
    case "never":
    case "any":
    case "unknown":
    case "date":
    case "nan":
    case "enum":
    case "literal":
    case "file":
    case "transform":
    case "custom":
      break;
    default: {
      for (const key in def) {
        const desc = Object.getOwnPropertyDescriptor(def, key);
        if (!desc || desc.get)
          continue;
        const value = desc.value;
        if (!value || typeof value !== "object")
          continue;
        if (value._zod)
          check(value);
        else if (Array.isArray(value))
          for (const el of value)
            check(el);
      }
    }
  }
  stack.delete(inst);
  return settle(inst, result);
}
function settle(inst, answer) {
  if (answer !== ASSUMED)
    recursive.set(inst, answer === PROVEN);
  return answer;
}
function bucketFor(state, inst) {
  let bucket = state.buckets.get(inst);
  if (!bucket) {
    bucket = new WeakMap;
    state.buckets.set(inst, bucket);
  }
  return bucket;
}
var handoff;
var open = [];
var memo = {
  alloc(_inst, payload, empty) {
    const bucket = handoff;
    if (!bucket)
      return empty;
    handoff = undefined;
    const entry = { value: empty, issues: null };
    bucket.set(payload.value, entry);
    open.push(entry);
    return empty;
  },
  guard(inst) {
    var _a;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value))
          throw new $ZodCyclicError;
        return base(payload, ctx);
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  },
  attach(inst) {
    var _a;
    let isRecursiveInst;
    let rechecked = false;
    let lastCtx;
    let lastBucket;
    (_a = inst._zod).deferred ?? (_a.deferred = []);
    inst._zod.deferred.push(() => {
      const base = inst._zod.parse;
      const wrapped = (payload, ctx) => {
        if (isRecursiveInst === undefined) {
          const walked = isRecursive(inst, new Set, false);
          if (walked === NONE) {
            inst._zod.parse = base;
            if (inst._zod.run === wrapped)
              inst._zod.run = base;
            return base(payload, ctx);
          }
          if (walked === PROVEN || rechecked)
            isRecursiveInst = true;
          else
            rechecked = true;
        }
        const input = payload.value;
        if (!isRef(input))
          return base(payload, ctx);
        let state = ctx[STATE];
        if (!state) {
          state = { buckets: new WeakMap, backEdges: undefined };
          ctx[STATE] = state;
        }
        let bucket;
        if (lastCtx === ctx) {
          bucket = lastBucket;
        } else {
          bucket = bucketFor(state, inst);
          lastCtx = ctx;
          lastBucket = bucket;
        }
        const hit = bucket.get(input);
        if (hit) {
          payload.value = hit.value;
          if (hit.issues) {
            if (hit.issues.length)
              payload.issues.push(...cloneIssues(hit.issues));
          } else {
            payload.memo = true;
            state.backEdges ?? (state.backEdges = new WeakSet);
            state.backEdges.add(hit.value);
          }
          return payload;
        }
        handoff = bucket;
        const depth = open.length;
        const result = base(payload, ctx);
        handoff = undefined;
        const entry = open.length > depth ? open.pop() : undefined;
        if (result instanceof Promise) {
          return result.then((r) => {
            if (entry)
              entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
            return r;
          });
        }
        if (entry)
          entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
        return result;
      };
      inst._zod.parse = wrapped;
      if (inst._zod.run === base)
        inst._zod.run = wrapped;
    });
  }
};
function memoizer() {
  return memo;
}
function isBackEdge(ctx, value) {
  const backEdges = ctx[STATE]?.backEdges;
  return backEdges !== undefined && isRef(value) && backEdges.has(value);
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/locales/en.js
var error = () => {
  const Sizable = {
    string: { unit: "characters", verb: "to have" },
    file: { unit: "bytes", verb: "to have" },
    array: { unit: "items", verb: "to have" },
    set: { unit: "items", verb: "to have" },
    map: { unit: "entries", verb: "to have" }
  };
  function getSizing(origin) {
    return Sizable[origin] ?? null;
  }
  const FormatDictionary = {
    regex: "input",
    email: "email address",
    url: "URL",
    emoji: "emoji",
    uuid: "UUID",
    uuidv4: "UUIDv4",
    uuidv6: "UUIDv6",
    nanoid: "nanoid",
    guid: "GUID",
    cuid: "cuid",
    cuid2: "cuid2",
    ulid: "ULID",
    xid: "XID",
    ksuid: "KSUID",
    datetime: "ISO datetime",
    date: "ISO date",
    time: "ISO time",
    duration: "ISO duration",
    ipv4: "IPv4 address",
    ipv6: "IPv6 address",
    mac: "MAC address",
    cidrv4: "IPv4 range",
    cidrv6: "IPv6 range",
    base64: "base64-encoded string",
    base64url: "base64url-encoded string",
    json_string: "JSON string",
    e164: "E.164 number",
    currency_code: "currency code",
    credit_card: "credit card number",
    iban: "IBAN",
    jwt: "JWT",
    template_literal: "input"
  };
  const TypeDictionary = {
    nan: "NaN"
  };
  function getTypeName(type, input) {
    if (type === "number" && typeof input === "number" && !Number.isFinite(input)) {
      return String(input);
    }
    return TypeDictionary[type] ?? type;
  }
  return (issue) => {
    switch (issue.code) {
      case "invalid_type": {
        const expected = getTypeName(issue.expected);
        const receivedType = parsedType(issue.input);
        const received = getTypeName(receivedType, issue.input);
        return `Invalid input: expected ${expected}, received ${received}`;
      }
      case "invalid_value":
        if (issue.values.length === 1)
          return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
        return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
      case "too_big": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
        const sizing = getSizing(issue.origin);
        if (sizing)
          return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
        return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
      }
      case "too_small": {
        const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
        const sizing = getSizing(issue.origin);
        if (sizing) {
          return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
        }
        return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
      }
      case "invalid_format": {
        const _issue = issue;
        if (_issue.format === "starts_with") {
          return `Invalid string: must start with "${_issue.prefix}"`;
        }
        if (_issue.format === "ends_with")
          return `Invalid string: must end with "${_issue.suffix}"`;
        if (_issue.format === "includes")
          return `Invalid string: must include "${_issue.includes}"`;
        if (_issue.format === "regex")
          return `Invalid string: must match pattern ${_issue.pattern}`;
        return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
      }
      case "not_multiple_of":
        return `Invalid number: must be a multiple of ${issue.divisor}`;
      case "unrecognized_keys":
        return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
      case "invalid_key":
        return `Invalid key in ${issue.origin}`;
      case "invalid_union":
        if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) {
          const opts = issue.options.map((o) => `'${o}'`).join(" | ");
          return `Invalid discriminator value. Expected ${opts}`;
        }
        if (issue.inclusive === false) {
          return "Invalid input: more than one option matched";
        }
        return "Invalid input";
      case "invalid_element":
        return `Invalid value in ${issue.origin}`;
      default:
        return `Invalid input`;
    }
  };
};
function en_default() {
  return {
    localeError: error()
  };
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/registries.js
var _a2;
class $ZodRegistry {
  constructor() {
    this._map = new WeakMap;
    this._idmap = new Map;
  }
  add(schema, ..._meta) {
    const meta = _meta[0];
    this._map.set(schema, meta);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.set(meta.id, schema);
    }
    return this;
  }
  clear() {
    this._map = new WeakMap;
    this._idmap = new Map;
    return this;
  }
  remove(schema) {
    const meta = this._map.get(schema);
    if (meta && typeof meta === "object" && "id" in meta) {
      this._idmap.delete(meta.id);
    }
    this._map.delete(schema);
    return this;
  }
  get(schema) {
    const p = schema._zod.parent;
    if (p) {
      const pm = { ...this.get(p) ?? {} };
      delete pm.id;
      const f = { ...pm, ...this._map.get(schema) };
      return Object.keys(f).length ? f : undefined;
    }
    return this._map.get(schema);
  }
  has(schema) {
    return this._map.has(schema);
  }
}
function registry() {
  return new $ZodRegistry;
}
(_a2 = globalThis).__zod_globalRegistry ?? (_a2.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/api.js
function snapshotChecks(def) {
  if (def.checks)
    def.checks = [...def.checks];
  return def;
}
function _string(Class, params) {
  return new Class(snapshotChecks({ type: "string", ...normalizeParams(params) }));
}
function _email(Class, params) {
  return new Class({
    type: "string",
    format: "email",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _guid(Class, params) {
  return new Class({
    type: "string",
    format: "guid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuid(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _uuidv4(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v4",
    ...normalizeParams(params)
  });
}
function _uuidv6(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v6",
    ...normalizeParams(params)
  });
}
function _uuidv7(Class, params) {
  return new Class({
    type: "string",
    format: "uuid",
    check: "string_format",
    abort: false,
    version: "v7",
    ...normalizeParams(params)
  });
}
function _url(Class, params) {
  return new Class({
    type: "string",
    format: "url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _emoji2(Class, params) {
  return new Class({
    type: "string",
    format: "emoji",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _nanoid(Class, params) {
  return new Class({
    type: "string",
    format: "nanoid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid(Class, params) {
  return new Class({
    type: "string",
    format: "cuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cuid2(Class, params) {
  return new Class({
    type: "string",
    format: "cuid2",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ulid(Class, params) {
  return new Class({
    type: "string",
    format: "ulid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _xid(Class, params) {
  return new Class({
    type: "string",
    format: "xid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ksuid(Class, params) {
  return new Class({
    type: "string",
    format: "ksuid",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv4(Class, params) {
  return new Class({
    type: "string",
    format: "ipv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _ipv6(Class, params) {
  return new Class({
    type: "string",
    format: "ipv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv4(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv4",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _cidrv6(Class, params) {
  return new Class({
    type: "string",
    format: "cidrv6",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64(Class, params) {
  return new Class({
    type: "string",
    format: "base64",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _base64url(Class, params) {
  return new Class({
    type: "string",
    format: "base64url",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _e164(Class, params) {
  return new Class({
    type: "string",
    format: "e164",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _jwt(Class, params) {
  return new Class({
    type: "string",
    format: "jwt",
    check: "string_format",
    abort: false,
    ...normalizeParams(params)
  });
}
function _isoDateTime(Class, params) {
  return new Class({
    type: "string",
    format: "datetime",
    check: "string_format",
    offset: false,
    local: false,
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDate(Class, params) {
  return new Class({
    type: "string",
    format: "date",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _isoTime(Class, params) {
  return new Class({
    type: "string",
    format: "time",
    check: "string_format",
    precision: null,
    ...normalizeParams(params)
  });
}
function _isoDuration(Class, params) {
  return new Class({
    type: "string",
    format: "duration",
    check: "string_format",
    ...normalizeParams(params)
  });
}
function _number(Class, params) {
  return new Class(snapshotChecks({ type: "number", checks: [], ...normalizeParams(params) }));
}
function _coercedNumber(Class, params) {
  return new Class(snapshotChecks({ type: "number", coerce: true, checks: [], ...normalizeParams(params) }));
}
function _int(Class, params) {
  return new Class({
    type: "number",
    check: "number_format",
    abort: false,
    format: "safeint",
    ...normalizeParams(params)
  });
}
function _boolean(Class, params) {
  return new Class({
    type: "boolean",
    ...normalizeParams(params)
  });
}
function _null2(Class, params) {
  return new Class({
    type: "null",
    ...normalizeParams(params)
  });
}
function _any(Class) {
  return new Class({
    type: "any"
  });
}
function _unknown(Class) {
  return new Class({
    type: "unknown"
  });
}
function _never(Class, params) {
  return new Class({
    type: "never",
    ...normalizeParams(params)
  });
}
function _lt(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _lte(value, params) {
  return new $ZodCheckLessThan({
    check: "less_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _gt(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: false
  });
}
function _gte(value, params) {
  return new $ZodCheckGreaterThan({
    check: "greater_than",
    ...normalizeParams(params),
    value,
    inclusive: true
  });
}
function _multipleOf(value, params) {
  return new $ZodCheckMultipleOf({
    check: "multiple_of",
    ...normalizeParams(params),
    value
  });
}
function _maxLength(maximum, params) {
  const ch = new $ZodCheckMaxLength({
    check: "max_length",
    ...normalizeParams(params),
    maximum
  });
  return ch;
}
function _minLength(minimum, params) {
  return new $ZodCheckMinLength({
    check: "min_length",
    ...normalizeParams(params),
    minimum
  });
}
function _length(length, params) {
  return new $ZodCheckLengthEquals({
    check: "length_equals",
    ...normalizeParams(params),
    length
  });
}
function _regex(pattern, params) {
  return new $ZodCheckRegex({
    check: "string_format",
    format: "regex",
    ...normalizeParams(params),
    pattern
  });
}
function _lowercase(params) {
  return new $ZodCheckLowerCase({
    check: "string_format",
    format: "lowercase",
    ...normalizeParams(params)
  });
}
function _uppercase(params) {
  return new $ZodCheckUpperCase({
    check: "string_format",
    format: "uppercase",
    ...normalizeParams(params)
  });
}
function _includes(includes, params) {
  return new $ZodCheckIncludes({
    check: "string_format",
    format: "includes",
    ...normalizeParams(params),
    includes
  });
}
function _startsWith(prefix, params) {
  return new $ZodCheckStartsWith({
    check: "string_format",
    format: "starts_with",
    ...normalizeParams(params),
    prefix
  });
}
function _endsWith(suffix, params) {
  return new $ZodCheckEndsWith({
    check: "string_format",
    format: "ends_with",
    ...normalizeParams(params),
    suffix
  });
}
function _overwrite(tx) {
  return new $ZodCheckOverwrite({
    check: "overwrite",
    tx
  });
}
function _normalize(form) {
  return _overwrite((input) => input.normalize(form));
}
function _trim() {
  return _overwrite((input) => input.trim());
}
function _toLowerCase() {
  return _overwrite((input) => input.toLowerCase());
}
function _toUpperCase() {
  return _overwrite((input) => input.toUpperCase());
}
function _slugify() {
  return _overwrite((input) => slugify(input));
}
function _array(Class, element, params) {
  return new Class({
    type: "array",
    element,
    ...normalizeParams(params)
  });
}
function _refine(Class, fn, _params) {
  const schema = new Class({
    type: "custom",
    check: "custom",
    fn,
    ...normalizeParams(_params)
  });
  return schema;
}
function _superRefine(fn, params) {
  const ch = _check((payload) => {
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, ch._zod.def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = ch);
        _issue.continue ?? (_issue.continue = !ch._zod.def.abort);
        payload.issues.push(issue(_issue));
      }
    };
    return fn(payload.value, payload);
  }, params);
  return ch;
}
function _check(fn, params) {
  const ch = new $ZodCheck({
    check: "custom",
    ...normalizeParams(params)
  });
  ch._zod.check = fn;
  return ch;
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
  for (const source of sources) {
    for (const key of Reflect.ownKeys(source)) {
      if (Object.prototype.propertyIsEnumerable.call(source, key)) {
        assignProp(target, key, source[key]);
      }
    }
  }
  return target;
}
function initializeContext(params) {
  let target = params?.target ?? "draft-2020-12";
  if (target === "draft-4")
    target = "draft-04";
  if (target === "draft-7")
    target = "draft-07";
  return {
    processors: params.processors ?? {},
    metadataRegistry: params?.metadata ?? globalRegistry,
    target,
    unrepresentable: params?.unrepresentable ?? "throw",
    override: params?.override ?? (() => {}),
    io: params?.io ?? "output",
    counter: 0,
    seen: new Map,
    sharedDefsExtractedFor: undefined,
    sharedEmitDoneFor: undefined,
    cycles: params?.cycles ?? "ref",
    reused: params?.reused ?? "inline",
    intersections: [],
    deferred: [],
    external: params?.external ?? undefined
  };
}
function handleUnrepresentable(schema, ctx, json, params, message) {
  const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({ zodSchema: schema, path: params.path, message }) : ctx.unrepresentable;
  if (result === "any")
    return false;
  if (result === undefined || result === "throw")
    throw new Error(message);
  Object.assign(json, result);
  return true;
}
function processSchema(schema, ctx, _params = { path: [], schemaPath: [] }) {
  var _a;
  const def = schema._zod.def;
  const seen = ctx.seen.get(schema);
  if (seen) {
    seen.count++;
    const isCycle = _params.schemaPath.includes(schema);
    if (isCycle) {
      seen.cycle = _params.path;
    }
    return seen.schema;
  }
  const result = { schema: {}, count: 1, cycle: undefined, path: _params.path };
  ctx.seen.set(schema, result);
  ctx.sharedDefsExtractedFor = undefined;
  ctx.sharedEmitDoneFor = undefined;
  const overrideSchema = schema._zod.toJSONSchema?.();
  if (overrideSchema) {
    result.schema = overrideSchema;
  } else {
    const params = {
      ..._params,
      schemaPath: [..._params.schemaPath, schema],
      path: _params.path
    };
    if (schema._zod.processJSONSchema) {
      schema._zod.processJSONSchema(ctx, result.schema, params);
    } else {
      const _json = result.schema;
      const processor = ctx.processors[def.type];
      if (!processor) {
        throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
      }
      processor(schema, ctx, _json, params);
    }
    const parent = schema._zod.parent;
    if (parent) {
      if (!result.ref)
        result.ref = parent;
      processSchema(parent, ctx, params);
      ctx.seen.get(parent).isParent = true;
    }
  }
  const meta = ctx.metadataRegistry.get(schema);
  if (meta)
    assignProps(result.schema, meta);
  if (ctx.io === "input" && isTransforming(schema)) {
    delete result.schema.examples;
    delete result.schema.default;
  }
  if (ctx.io === "input" && "_prefault" in result.schema)
    (_a = result.schema).default ?? (_a.default = result.schema._prefault);
  delete result.schema._prefault;
  const _result = ctx.seen.get(schema);
  return _result.schema;
}
function encodeJSONPointerSegment(segment) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external)
    return;
  const idToSchema = new Map;
  for (const entry of ctx.seen.entries()) {
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      const existing = idToSchema.get(id);
      if (existing && existing !== entry[0]) {
        throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
      }
      idToSchema.set(id, entry[0]);
    }
  }
  const makeURI = (entry) => {
    const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
    if (ctx.external) {
      const externalId = ctx.external.registry.get(entry[0])?.id;
      const uriGenerator = ctx.external.uri ?? ((id) => id);
      if (externalId) {
        return { ref: uriGenerator(externalId) };
      }
      const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
      entry[1].defId = id;
      return { defId: id, ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}` };
    }
    const uriPrefix = `#`;
    const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
    if (entry[1] === root && !entry[1].schema.id) {
      return { ref: uriPrefix };
    }
    const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
    return { defId, ref: defUriPrefix + encodeJSONPointerSegment(defId) };
  };
  const extractToDef = (entry) => {
    if (entry[1].schema.$ref) {
      return;
    }
    const seen = entry[1];
    const { ref, defId } = makeURI(entry);
    seen.def = { ...seen.schema };
    if (defId)
      seen.defId = defId;
    const schema = seen.schema;
    for (const key in schema) {
      delete schema[key];
    }
    schema.$ref = ref;
  };
  if (ctx.cycles === "throw") {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.cycle) {
        throw new Error("Cycle detected: " + `#/${seen.cycle?.join("/")}/<root>` + '\n\nSet the `cycles` parameter to `"ref"` to resolve cyclical schemas with defs.');
      }
    }
  }
  for (const entry of ctx.seen.entries()) {
    const seen = entry[1];
    if (schema === entry[0]) {
      extractToDef(entry);
      continue;
    }
    if (ctx.external) {
      const ext = ctx.external.registry.get(entry[0])?.id;
      if (schema !== entry[0] && ext) {
        extractToDef(entry);
        continue;
      }
    }
    const id = ctx.metadataRegistry.get(entry[0])?.id;
    if (id) {
      extractToDef(entry);
      continue;
    }
    if (seen.cycle) {
      extractToDef(entry);
      continue;
    }
    if (seen.count > 1) {
      if (ctx.reused === "ref") {
        extractToDef(entry);
      }
    }
  }
  if (ctx.external)
    ctx.sharedDefsExtractedFor = ctx.external;
}
function compactTypeUnion(schema) {
  const options = schema.anyOf;
  if (!Array.isArray(options) || options.length === 0 || schema.type !== undefined)
    return;
  const types = [];
  for (const option of options) {
    if (!option || typeof option !== "object")
      return;
    compactTypeUnion(option);
    const keys = Object.keys(option);
    if (keys.length !== 1 || keys[0] !== "type")
      return;
    const type = option.type;
    for (const member of Array.isArray(type) ? type : [type]) {
      if (typeof member !== "string")
        return;
      if (!types.includes(member))
        types.push(member);
    }
  }
  delete schema.anyOf;
  schema.type = types.length === 1 ? types[0] : types;
}
var FOLDABLE_KEYS = new Set(["type", "properties", "required", "additionalProperties"]);
var UNION_KEYS = ["oneOf", "anyOf"];
function undeclaredConstraint(member) {
  const extra = member.additionalProperties;
  if (extra === undefined || extra === false || typeof extra !== "object" || extra === null)
    return null;
  return Object.keys(extra).length ? extra : null;
}
function foldObjects(members) {
  const objects = [];
  for (const member of members) {
    if (typeof member !== "object" || member.type !== "object")
      return null;
    for (const key in member) {
      if (!FOLDABLE_KEYS.has(key))
        return null;
    }
    objects.push(member);
  }
  const properties = {};
  const required = new Set;
  for (const object of objects) {
    for (const key in object.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, key))
        continue;
      const parts = [];
      for (const other of objects) {
        const part = other.properties?.[key] ?? undeclaredConstraint(other);
        if (part === null || part === undefined)
          continue;
        if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part)))
          parts.push(part);
      }
      const merged = parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts };
      assignProp(properties, key, merged);
    }
    for (const key of object.required ?? [])
      required.add(key);
  }
  const folded = { type: "object", properties };
  if (required.size)
    folded.required = [...required];
  if (objects.every((object) => object.additionalProperties === false)) {
    folded.additionalProperties = false;
  } else {
    const constraints = [];
    for (const object of objects) {
      const constraint = undeclaredConstraint(object);
      if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint)))
        constraints.push(constraint);
    }
    if (constraints.length === 1)
      folded.additionalProperties = constraints[0];
    else if (constraints.length > 1)
      folded.additionalProperties = { allOf: constraints };
  }
  return folded;
}
function foldIntersection(json) {
  const allOf = json.allOf;
  if (!Array.isArray(allOf) || allOf.length < 2)
    return;
  for (const key of FOLDABLE_KEYS)
    if (key in json)
      return;
  const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
  let folded = null;
  if (!unions.length) {
    folded = foldObjects(allOf);
  } else {
    const union = unions[0];
    const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
    if (Object.keys(union).length !== 1)
      return;
    const rest = allOf.filter((m) => m !== union);
    const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
    if (branches.some((b) => !b))
      return;
    folded = { [keyword]: branches };
  }
  if (!folded)
    return;
  delete json.allOf;
  assignProps(json, folded);
}
function finalize(ctx, schema) {
  const root = ctx.seen.get(schema);
  if (!root)
    throw new Error("Unprocessed schema. This is a bug in Zod.");
  const flattenRef = (zodSchema) => {
    const seen = ctx.seen.get(zodSchema);
    if (seen.ref === null)
      return;
    const schema = seen.def ?? seen.schema;
    const _cached = { ...schema };
    const ref = seen.ref;
    seen.ref = null;
    if (ref) {
      flattenRef(ref);
      const refSeen = ctx.seen.get(ref);
      const refSchema = refSeen.schema;
      if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
        schema.allOf = schema.allOf ?? [];
        schema.allOf.push(refSchema);
      } else {
        assignProps(schema, refSchema);
      }
      assignProps(schema, _cached);
      const isParentRef = zodSchema._zod.parent === ref;
      if (isParentRef) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (!(key in _cached)) {
            delete schema[key];
          }
        }
      }
      if (refSchema.$ref && refSeen.def) {
        for (const key in schema) {
          if (key === "$ref" || key === "allOf")
            continue;
          if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) {
            delete schema[key];
          }
        }
      }
    }
    const parent = zodSchema._zod.parent;
    if (parent && parent !== ref) {
      flattenRef(parent);
      const parentSeen = ctx.seen.get(parent);
      if (parentSeen?.schema.$ref) {
        schema.$ref = parentSeen.schema.$ref;
        if (parentSeen.def) {
          for (const key in schema) {
            if (key === "$ref" || key === "allOf")
              continue;
            if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) {
              delete schema[key];
            }
          }
        }
      }
    }
    ctx.override({
      zodSchema,
      jsonSchema: schema,
      path: seen.path ?? []
    });
  };
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of [...ctx.seen.entries()].reverse()) {
      flattenRef(entry[0]);
    }
    if (ctx.target !== "openapi-3.0") {
      for (const entry of ctx.seen.entries()) {
        compactTypeUnion(entry[1].def ?? entry[1].schema);
      }
    }
    for (const rewrite of ctx.deferred)
      rewrite();
    if (ctx.intersections.length) {
      const carriers = new Map;
      for (const seen of ctx.seen.values()) {
        for (const json of [seen.schema, seen.def]) {
          const allOf = json?.allOf;
          if (!Array.isArray(allOf))
            continue;
          const existing = carriers.get(allOf);
          if (existing)
            existing.push(json);
          else
            carriers.set(allOf, [json]);
        }
      }
      for (const allOf of ctx.intersections) {
        for (const json of carriers.get(allOf) ?? [])
          foldIntersection(json);
      }
    }
  }
  const result = {};
  if (ctx.target === "draft-2020-12") {
    result.$schema = "https://json-schema.org/draft/2020-12/schema";
  } else if (ctx.target === "draft-07") {
    result.$schema = "http://json-schema.org/draft-07/schema#";
  } else if (ctx.target === "draft-04") {
    result.$schema = "http://json-schema.org/draft-04/schema#";
  } else if (ctx.target === "openapi-3.0") {}
  if (ctx.external?.uri) {
    const id = ctx.external.registry.get(schema)?.id;
    if (!id)
      throw new Error("Schema is missing an `id` property");
    result.$id = ctx.external.uri(id);
  }
  assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
  const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
  if (rootMetaId !== undefined && result.id === rootMetaId)
    delete result.id;
  const defs = ctx.external?.defs ?? {};
  if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
    for (const entry of ctx.seen.entries()) {
      const seen = entry[1];
      if (seen.def && seen.defId) {
        if (seen.def.id === seen.defId)
          delete seen.def.id;
        assignProp(defs, seen.defId, seen.def);
      }
    }
  }
  if (ctx.external)
    ctx.sharedEmitDoneFor = ctx.external;
  if (ctx.external) {} else {
    if (Object.keys(defs).length > 0) {
      if (ctx.target === "draft-2020-12") {
        result.$defs = defs;
      } else {
        result.definitions = defs;
      }
    }
  }
  try {
    const finalized = JSON.parse(JSON.stringify(result));
    Object.defineProperty(finalized, "~standard", {
      value: {
        ...schema["~standard"],
        jsonSchema: {
          input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
          output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
        }
      },
      enumerable: false,
      writable: false
    });
    return finalized;
  } catch (_err) {
    throw new Error("Error converting schema to JSON.");
  }
}
function isTransforming(_schema, _ctx) {
  const ctx = _ctx ?? { seen: new Set };
  if (ctx.seen.has(_schema))
    return false;
  ctx.seen.add(_schema);
  const def = _schema._zod.def;
  if (def.type === "transform")
    return true;
  if (def.type === "array")
    return isTransforming(def.element, ctx);
  if (def.type === "set")
    return isTransforming(def.valueType, ctx);
  if (def.type === "lazy")
    return isTransforming(def.getter(), ctx);
  if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") {
    return isTransforming(def.innerType, ctx);
  }
  if (def.type === "intersection") {
    return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
  }
  if (def.type === "record" || def.type === "map") {
    return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
  }
  if (def.type === "pipe") {
    if (_schema._zod.traits.has("$ZodCodec"))
      return true;
    return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
  }
  if (def.type === "object") {
    for (const key in def.shape) {
      if (isTransforming(def.shape[key], ctx))
        return true;
    }
    return false;
  }
  if (def.type === "union") {
    for (const option of def.options) {
      if (isTransforming(option, ctx))
        return true;
    }
    return false;
  }
  if (def.type === "tuple") {
    for (const item of def.items) {
      if (isTransforming(item, ctx))
        return true;
    }
    if (def.rest && isTransforming(def.rest, ctx))
      return true;
    return false;
  }
  return false;
}
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
  const ctx = initializeContext({ ...params, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
  const { libraryOptions, target } = params ?? {};
  const ctx = initializeContext({ ...libraryOptions ?? {}, target, io, processors });
  processSchema(schema, ctx);
  extractDefs(ctx, schema);
  return finalize(ctx, schema);
};
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/json-schema-processors.js
var narrowMin = (agg, key, value) => {
  if (agg[key] === undefined || value > agg[key])
    agg[key] = value;
};
var narrowMax = (agg, key, value) => {
  if (agg[key] === undefined || value < agg[key])
    agg[key] = value;
};
var narrowBoth = (agg, value) => {
  narrowMin(agg, "minimum", value);
  narrowMax(agg, "maximum", value);
};
var addDivisor = (agg, value) => {
  agg.multipleOf ?? (agg.multipleOf = []);
  if (!agg.multipleOf.includes(value))
    agg.multipleOf.push(value);
};
var addPattern = (agg, pattern) => {
  agg.patterns ?? (agg.patterns = new Set);
  agg.patterns.add(pattern);
};
var intersectMime = (agg, mime) => {
  agg.mime = agg.mime ? agg.mime.filter((m) => mime.includes(m)) : [...mime];
};
var setFormat = (agg, format) => {
  agg.format = format;
  if (format.includes("int"))
    agg.isInt = true;
};
var minContributor = (agg, def) => narrowMin(agg, "minimum", def.minimum);
var maxContributor = (agg, def) => narrowMax(agg, "maximum", def.maximum);
var formatContributor = (ranges) => (agg, def) => {
  setFormat(agg, def.format);
  const [minimum, maximum] = ranges[def.format];
  narrowMin(agg, "minimum", minimum);
  narrowMax(agg, "maximum", maximum);
};
var contributors = {
  greater_than: (agg, def) => narrowMin(agg, def.inclusive ? "minimum" : "exclusiveMinimum", def.value),
  less_than: (agg, def) => narrowMax(agg, def.inclusive ? "maximum" : "exclusiveMaximum", def.value),
  multiple_of: (agg, def) => addDivisor(agg, def.value),
  number_format: formatContributor(NUMBER_FORMAT_RANGES),
  bigint_format: formatContributor(BIGINT_FORMAT_RANGES),
  min_length: minContributor,
  max_length: maxContributor,
  length_equals: (agg, def) => narrowBoth(agg, def.length),
  min_size: minContributor,
  max_size: maxContributor,
  size_equals: (agg, def) => narrowBoth(agg, def.size),
  string_format: (agg, def) => {
    setFormat(agg, def.format);
    if (def.pattern)
      addPattern(agg, def.pattern);
    if (def.format === "base64" || def.format === "base64url")
      agg.contentEncoding = def.format;
    if (def.local || def.precision === -1)
      agg.laxFormat = true;
  },
  mime_type: (agg, def) => intersectMime(agg, def.mime)
};
function aggregateChecks(schema) {
  const agg = {};
  const def = schema._zod.def;
  const list = schema._zod.traits.has("$ZodCheck") ? [schema, ...def.checks ?? []] : def.checks ?? [];
  for (const ch of list)
    contributors[ch._zod.def.check]?.(agg, ch._zod.def);
  const bag = schema._zod.bag;
  if (bag.minimum !== undefined)
    narrowMin(agg, "minimum", bag.minimum);
  if (bag.exclusiveMinimum !== undefined)
    narrowMin(agg, "exclusiveMinimum", bag.exclusiveMinimum);
  if (bag.maximum !== undefined)
    narrowMax(agg, "maximum", bag.maximum);
  if (bag.exclusiveMaximum !== undefined)
    narrowMax(agg, "exclusiveMaximum", bag.exclusiveMaximum);
  if (bag.multipleOf !== undefined)
    addDivisor(agg, bag.multipleOf);
  if (bag.format !== undefined) {
    agg.format ?? (agg.format = bag.format);
    if (bag.format.includes("int"))
      agg.isInt = true;
  }
  if (bag.mime)
    intersectMime(agg, bag.mime);
  for (const pattern of bag.patterns ?? [])
    addPattern(agg, pattern);
  return agg;
}
var formatMap = {
  guid: "uuid",
  url: "uri",
  datetime: "date-time",
  json_string: "json-string",
  regex: ""
};
var exactPatterns = new Map([
  [base64Charset, base64],
  [base64urlCharset, base64url]
]);
var exactPattern = (p) => exactPatterns.get(p) ?? p;
var stringProcessor = (schema, ctx, _json, _params) => {
  const json = _json;
  json.type = "string";
  const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minLength = minimum;
  if (typeof maximum === "number")
    json.maxLength = maximum;
  if (format) {
    json.format = formatMap[format] ?? format;
    if (json.format === "")
      delete json.format;
    if (format === "time" || laxFormat) {
      delete json.format;
    }
  }
  if (contentEncoding)
    json.contentEncoding = contentEncoding;
  if (patterns && patterns.size > 0) {
    const patternList = [...patterns].map(exactPattern);
    if (patternList.length === 1)
      json.pattern = patternList[0].source;
    else if (patternList.length > 1) {
      json.allOf = [
        ...patternList.map((regex) => ({
          ...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
          pattern: regex.source
        }))
      ];
    }
  }
};
var numberProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const { minimum, maximum, multipleOf, exclusiveMaximum, exclusiveMinimum, isInt } = aggregateChecks(schema);
  json.type = isInt ? "integer" : "number";
  const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
  const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
  const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
  if (exMin) {
    if (legacy) {
      json.minimum = exclusiveMinimum;
      json.exclusiveMinimum = true;
    } else {
      json.exclusiveMinimum = exclusiveMinimum;
    }
  } else if (typeof minimum === "number") {
    json.minimum = minimum;
  }
  if (exMax) {
    if (legacy) {
      json.maximum = exclusiveMaximum;
      json.exclusiveMaximum = true;
    } else {
      json.exclusiveMaximum = exclusiveMaximum;
    }
  } else if (typeof maximum === "number") {
    json.maximum = maximum;
  }
  if (multipleOf) {
    const divisors = new Set;
    for (const divisor of multipleOf) {
      if (Number.isFinite(divisor) && divisor !== 0)
        divisors.add(Math.abs(divisor));
      else
        handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${divisor} cannot be represented in JSON Schema`);
    }
    const [first, ...rest] = divisors;
    if (first !== undefined)
      json.multipleOf = first;
    if (rest.length)
      json.allOf = [...json.allOf ?? [], ...rest.map((m) => ({ multipleOf: m }))];
  }
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var bigintProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "BigInt cannot be represented in JSON Schema");
};
var symbolProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Symbols cannot be represented in JSON Schema");
};
var nullProcessor = (_schema, ctx, json, _params) => {
  if (ctx.target === "openapi-3.0") {
    json.type = "string";
    json.nullable = true;
    json.enum = [null];
  } else {
    json.type = "null";
  }
};
var undefinedProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Undefined cannot be represented in JSON Schema");
};
var voidProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Void cannot be represented in JSON Schema");
};
var neverProcessor = (_schema, _ctx, json, _params) => {
  json.not = {};
};
var anyProcessor = (_schema, _ctx, _json, _params) => {};
var unknownProcessor = (_schema, _ctx, _json, _params) => {};
var dateProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Date cannot be represented in JSON Schema");
};
var enumProcessor = (schema, _ctx, json, _params) => {
  const def = schema._zod.def;
  const values = getEnumValues(def.entries);
  if (values.length === 0) {
    json.not = {};
    return;
  }
  if (values.every((v) => typeof v === "number"))
    json.type = "number";
  if (values.every((v) => typeof v === "string"))
    json.type = "string";
  json.enum = values;
};
var literalProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  if (def.values.length === 0) {
    json.not = {};
    return;
  }
  const vals = [];
  for (const val of def.values) {
    if (val === undefined) {
      if (handleUnrepresentable(schema, ctx, json, params, "Literal `undefined` cannot be represented in JSON Schema"))
        return;
    } else if (typeof val === "bigint") {
      if (handleUnrepresentable(schema, ctx, json, params, "BigInt literals cannot be represented in JSON Schema"))
        return;
      vals.push(Number(val));
    } else {
      vals.push(val);
    }
  }
  if (vals.length === 0) {} else if (vals.length === 1) {
    const val = vals[0];
    json.type = val === null ? "null" : typeof val;
    if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") {
      json.enum = [val];
    } else {
      json.const = val;
    }
  } else {
    if (vals.every((v) => typeof v === "number"))
      json.type = "number";
    if (vals.every((v) => typeof v === "string"))
      json.type = "string";
    if (vals.every((v) => typeof v === "boolean"))
      json.type = "boolean";
    if (vals.every((v) => v === null))
      json.type = "null";
    json.enum = vals;
  }
};
var nanProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "NaN cannot be represented in JSON Schema");
};
var templateLiteralProcessor = (schema, _ctx, json, _params) => {
  const _json = json;
  const pattern = schema._zod.pattern;
  if (!pattern)
    throw new Error("Pattern not found in template literal");
  _json.type = "string";
  _json.pattern = pattern.source;
};
var fileProcessor = (schema, _ctx, json, _params) => {
  const _json = json;
  _json.type = "string";
  _json.format = "binary";
  _json.contentEncoding = "binary";
  const { minimum, maximum, mime } = aggregateChecks(schema);
  if (minimum !== undefined)
    _json.minLength = minimum;
  if (maximum !== undefined)
    _json.maxLength = maximum;
  if (!mime)
    return;
  if (mime.length === 0)
    _json.not = {};
  else if (mime.length === 1)
    _json.contentMediaType = mime[0];
  else
    _json.anyOf = mime.map((m) => ({ contentMediaType: m }));
};
var successProcessor = (_schema, _ctx, json, _params) => {
  json.type = "boolean";
};
var customProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var functionProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Function types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var mapProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Map cannot be represented in JSON Schema");
};
var setProcessor = (schema, ctx, json, params) => {
  handleUnrepresentable(schema, ctx, json, params, "Set cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
  json.type = "array";
  json.items = processSchema(def.element, ctx, {
    ...params,
    path: [...params.path, "items"]
  });
};
function inputOptin(schema) {
  const def = schema._zod.def;
  if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) {
    return inputOptin(def.out);
  }
  if (def.type === "catch") {
    return inputOptin(def.innerType);
  }
  return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  const shape = def.shape;
  const symbolKeys = Object.getOwnPropertySymbols(shape);
  if (symbolKeys.length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) {
    return;
  }
  json.type = "object";
  json.properties = {};
  for (const key in shape) {
    assignProp(json.properties, key, processSchema(shape[key], ctx, {
      ...params,
      path: [...params.path, "properties", key]
    }));
  }
  const requiredKeys = [];
  for (const key of Object.keys(shape)) {
    const field = def.shape[key];
    if (ctx.io === "input" ? inputOptin(field) === undefined : field._zod.optout === undefined) {
      requiredKeys.push(key);
    }
  }
  if (requiredKeys.length > 0) {
    json.required = requiredKeys;
  }
  if (def.catchall?._zod.def.type === "never") {
    json.additionalProperties = false;
  } else if (!def.catchall) {
    if (ctx.io === "output")
      json.additionalProperties = false;
  } else if (def.catchall) {
    json.additionalProperties = processSchema(def.catchall, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
};
var unionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const isExclusive = def.inclusive === false;
  const options = def.options.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, isExclusive ? "oneOf" : "anyOf", i]
  }));
  if (isExclusive) {
    json.oneOf = options;
  } else {
    json.anyOf = options;
  }
};
var intersectionProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const a = processSchema(def.left, ctx, {
    ...params,
    path: [...params.path, "allOf", 0]
  });
  const b = processSchema(def.right, ctx, {
    ...params,
    path: [...params.path, "allOf", 1]
  });
  const isSimpleIntersection = (val) => ("allOf" in val) && Object.keys(val).length === 1;
  const allOf = [
    ...isSimpleIntersection(a) ? a.allOf : [a],
    ...isSimpleIntersection(b) ? b.allOf : [b]
  ];
  json.allOf = allOf;
  ctx.intersections.push(allOf);
};
var tupleProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "array";
  const prefixPath = ctx.target === "draft-2020-12" ? "prefixItems" : "items";
  const restPath = ctx.target === "draft-2020-12" ? "items" : ctx.target === "openapi-3.0" ? "items" : "additionalItems";
  const prefixItems = def.items.map((x, i) => processSchema(x, ctx, {
    ...params,
    path: [...params.path, prefixPath, i]
  }));
  const rest = def.rest ? processSchema(def.rest, ctx, {
    ...params,
    path: [...params.path, restPath, ...ctx.target === "openapi-3.0" ? [def.items.length] : []]
  }) : null;
  let minItems = def.items.length;
  while (minItems > 0) {
    const item = def.items[minItems - 1];
    const optional = ctx.io === "input" ? inputOptin(item) !== undefined : item._zod.optout === "optional";
    if (!optional)
      break;
    minItems--;
  }
  const maxItems = def.items.length;
  const isClosed = !def.rest;
  if (ctx.target === "draft-2020-12") {
    json.prefixItems = prefixItems;
    if (isClosed) {
      json.items = false;
    } else if (rest) {
      json.items = rest;
    }
    if (minItems > 0)
      json.minItems = minItems;
    if (isClosed)
      json.maxItems = maxItems;
  } else if (ctx.target === "openapi-3.0") {
    json.items = {
      anyOf: prefixItems
    };
    if (rest) {
      json.items.anyOf.push(rest);
    }
    if (minItems > 0)
      json.minItems = minItems;
    if (isClosed)
      json.maxItems = maxItems;
  } else {
    json.items = prefixItems;
    if (isClosed) {
      json.additionalItems = false;
    } else if (rest) {
      json.additionalItems = rest;
    }
    if (minItems > 0)
      json.minItems = minItems;
    if (isClosed)
      json.maxItems = maxItems;
  }
  const { minimum, maximum } = aggregateChecks(schema);
  if (typeof minimum === "number")
    json.minItems = minimum;
  if (typeof maximum === "number")
    json.maxItems = maximum;
};
function stringifyKeyNames(bySchema, json, visited) {
  if (json.$ref) {
    if (visited.has(json))
      return json;
    visited.add(json);
    const def = bySchema.get(json)?.def;
    if (!def)
      return json;
    const inlined = stringifyKeyNames(bySchema, def, visited);
    return inlined === def ? json : inlined;
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = json[keyword];
    if (!Array.isArray(branches))
      continue;
    const mapped = branches.map((branch) => stringifyKeyNames(bySchema, branch, visited));
    if (mapped.some((branch, i) => branch !== branches[i]))
      json = { ...json, [keyword]: mapped };
  }
  const types = Array.isArray(json.type) ? json.type : [json.type];
  const numericType = !types.includes("string") && types.some((t) => t === "number" || t === "integer");
  const values = json.enum ?? (json.const !== undefined ? [json.const] : undefined);
  if (!numericType && !values?.some((v) => typeof v === "number"))
    return json;
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, format, id, ...rest } = json;
  if (rest.enum)
    rest.enum = rest.enum.map((v) => typeof v === "number" ? String(v) : v);
  else if (typeof rest.const === "number")
    rest.const = String(rest.const);
  if (!numericType)
    return rest;
  rest.type = "string";
  if (!values)
    rest.pattern = (types.includes("number") ? number : integer).source;
  return rest;
}
var pendingRecords = new WeakMap;
function rewriteKeyNames(ctx) {
  const bySchema = new Map;
  for (const entry of ctx.seen.values()) {
    if (entry.def && !bySchema.has(entry.schema))
      bySchema.set(entry.schema, entry);
  }
  const rewrites = new Map;
  for (const record of pendingRecords.get(ctx) ?? []) {
    const seen = ctx.seen.get(record);
    const names = (seen?.def ?? seen?.schema)?.propertyNames;
    if (!names || names === true || rewrites.has(names))
      continue;
    const rewritten = stringifyKeyNames(bySchema, names, new Set);
    if (rewritten !== names)
      rewrites.set(names, rewritten);
  }
  if (!rewrites.size)
    return;
  for (const entry of ctx.seen.values()) {
    for (const carrier of [entry.schema, entry.def]) {
      const rewritten = carrier && rewrites.get(carrier.propertyNames);
      if (rewritten)
        carrier.propertyNames = rewritten;
    }
  }
}
var recordProcessor = (schema, ctx, _json, params) => {
  const json = _json;
  const def = schema._zod.def;
  json.type = "object";
  const keyType = def.keyType;
  const patterns = aggregateChecks(keyType).patterns;
  if (def.mode === "loose" && patterns && patterns.size > 0) {
    const valueSchema = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "patternProperties", "*"]
    });
    json.patternProperties = {};
    for (const pattern of patterns) {
      assignProp(json.patternProperties, exactPattern(pattern).source, valueSchema);
    }
  } else {
    if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") {
      json.propertyNames = processSchema(def.keyType, ctx, {
        ...params,
        path: [...params.path, "propertyNames"]
      });
      let pending = pendingRecords.get(ctx);
      if (!pending) {
        pending = [];
        pendingRecords.set(ctx, pending);
        ctx.deferred.push(() => rewriteKeyNames(ctx));
      }
      pending.push(schema);
    }
    json.additionalProperties = processSchema(def.valueType, ctx, {
      ...params,
      path: [...params.path, "additionalProperties"]
    });
  }
  const keyValues = keyType._zod.values;
  const omittableOnInput = ctx.io === "input" && inputOptin(def.valueType) !== undefined;
  if (keyValues && !def.partial && !omittableOnInput) {
    const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
    if (validKeyValues.length > 0) {
      json.required = validKeyValues.map(String);
    }
  }
};
var nullableProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  const inner = processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  if (ctx.target === "openapi-3.0") {
    seen.ref = def.innerType;
    json.nullable = true;
  } else {
    json.anyOf = [inner, { type: "null" }];
  }
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
  let unrepresentable = false;
  const serialized = JSON.stringify(value, (_, val) => {
    if (typeof val !== "bigint")
      return val;
    unrepresentable = true;
    return null;
  });
  if (!unrepresentable)
    return JSON.parse(serialized);
  handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
  return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  if (ctx.io !== "input")
    return;
  const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
  if (value !== UNREPRESENTABLE_DEFAULT)
    json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  let catchValue;
  try {
    catchValue = def.catchValue(undefined);
  } catch {
    handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
    return;
  }
  json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  const inIsTransform = def.in._zod.traits.has("$ZodTransform");
  const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
  json.readOnly = true;
};
var promiseProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var optionalProcessor = (schema, ctx, _json, params) => {
  const def = schema._zod.def;
  processSchema(def.innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = def.innerType;
};
var lazyProcessor = (schema, ctx, _json, params) => {
  const innerType = schema._zod.innerType;
  processSchema(innerType, ctx, params);
  const seen = ctx.seen.get(schema);
  seen.ref = innerType;
};
var allProcessors = {
  string: stringProcessor,
  number: numberProcessor,
  boolean: booleanProcessor,
  bigint: bigintProcessor,
  symbol: symbolProcessor,
  null: nullProcessor,
  undefined: undefinedProcessor,
  void: voidProcessor,
  never: neverProcessor,
  any: anyProcessor,
  unknown: unknownProcessor,
  date: dateProcessor,
  enum: enumProcessor,
  literal: literalProcessor,
  nan: nanProcessor,
  template_literal: templateLiteralProcessor,
  file: fileProcessor,
  success: successProcessor,
  custom: customProcessor,
  function: functionProcessor,
  transform: transformProcessor,
  map: mapProcessor,
  set: setProcessor,
  array: arrayProcessor,
  object: objectProcessor,
  union: unionProcessor,
  intersection: intersectionProcessor,
  tuple: tupleProcessor,
  record: recordProcessor,
  nullable: nullableProcessor,
  nonoptional: nonoptionalProcessor,
  default: defaultProcessor,
  prefault: prefaultProcessor,
  catch: catchProcessor,
  pipe: pipeProcessor,
  readonly: readonlyProcessor,
  promise: promiseProcessor,
  optional: optionalProcessor,
  lazy: lazyProcessor
};
function toJSONSchema(input, params) {
  if ("_idmap" in input) {
    const registry = input;
    const ctx = initializeContext({ ...params, processors: allProcessors });
    const defs = {};
    for (const entry of registry._idmap.entries()) {
      const [_, schema] = entry;
      processSchema(schema, ctx);
    }
    const schemas = {};
    const external = {
      registry,
      uri: params?.uri,
      defs
    };
    ctx.external = external;
    for (const entry of registry._idmap.entries()) {
      const [key, schema] = entry;
      extractDefs(ctx, schema);
      assignProp(schemas, key, finalize(ctx, schema));
    }
    if (Object.keys(defs).length > 0) {
      const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
      schemas.__shared = {
        [defsSegment]: defs
      };
    }
    return { schemas };
  }
  const ctx = initializeContext({ ...params, processors: allProcessors });
  processSchema(input, ctx);
  extractDefs(ctx, input);
  return finalize(ctx, input);
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: false,
    get() {
      const value = make(this);
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
      return value;
    },
    set(value) {
      Object.defineProperty(this, key, { value, configurable: true, writable: true });
    }
  });
}
var initializer2 = (inst, issues) => {
  $ZodError.init(inst, issues);
  inst.name = "ZodError";
  const proto = Object.getPrototypeOf(inst);
  if (_installedErrorProtos.has(proto))
    return;
  _installedErrorProtos.add(proto);
  _lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
  _lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
  _lazyMethod(proto, "addIssue", (self) => (issue) => {
    self.issues.push(issue);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  _lazyMethod(proto, "addIssues", (self) => (issues) => {
    self.issues.push(...issues);
    self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
  });
  Object.defineProperty(proto, "isEmpty", {
    configurable: true,
    enumerable: false,
    get() {
      return this.issues.length === 0;
    }
  });
};
var ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer2, undefined, {
  Parent: Error
});

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/parse.js
var parse2 = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
  if (!globalConfig.localeError)
    config(en_default());
}
function _ensureDefaultMemoizer() {
  if (!globalConfig.memoizer)
    config({ memoizer: memoizer() });
}
var ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
  _ensureDefaultLocale();
  $ZodType.init(inst, def);
  inst.def = def;
  inst.type = def.type;
  return inst;
}, {
  check(...chks) {
    const def = this.def;
    return this.clone(mergeDefs(def, {
      checks: [
        ...def.checks ?? [],
        ...chks.map((ch) => typeof ch === "function" ? { _zod: { check: ch, def: { check: "custom" }, onattach: [] } } : ch)
      ]
    }), { parent: true });
  },
  with(...chks) {
    return this.check(...chks);
  },
  clone(def, params) {
    return clone(this, def, params);
  },
  brand() {
    return this;
  },
  register(reg, meta) {
    reg.add(this, meta);
    return this;
  },
  refine(check, params) {
    return this.check(refine(check, params));
  },
  superRefine(refinement, params) {
    return this.check(superRefine(refinement, params));
  },
  overwrite(fn) {
    return this.check(_overwrite(fn));
  },
  optional() {
    return optional(this);
  },
  exactOptional() {
    return exactOptional(this);
  },
  nullable() {
    return nullable(this);
  },
  nullish() {
    return optional(nullable(this));
  },
  nonoptional(params) {
    return nonoptional(this, params);
  },
  array() {
    return array(this);
  },
  or(arg) {
    return union([this, arg]);
  },
  and(arg) {
    return intersection(this, arg);
  },
  transform(tx) {
    return pipe(this, transform(tx));
  },
  default(d) {
    return _default(this, d);
  },
  prefault(d) {
    return prefault(this, d);
  },
  catch(params) {
    return _catch(this, params);
  },
  pipe(target) {
    return pipe(this, target);
  },
  readonly() {
    return readonly(this);
  },
  describe(description) {
    const cl = this.clone();
    globalRegistry.add(cl, { description });
    return cl;
  },
  meta(...args) {
    if (args.length === 0)
      return globalRegistry.get(this);
    const cl = this.clone();
    globalRegistry.add(cl, args[0]);
    return cl;
  },
  isOptional() {
    return this.safeParse(undefined).success;
  },
  isNullable() {
    return this.safeParse(null).success;
  },
  apply(fn, ...args) {
    return args.length === 0 ? fn(this) : fn(this, ...args);
  },
  get "~standard"() {
    return hide(this, "~standard", {
      ...standardProps(this),
      jsonSchema: {
        input: createStandardJSONSchemaMethod(this, "input"),
        output: createStandardJSONSchemaMethod(this, "output")
      }
    });
  },
  set "~standard"(value) {
    own(this, "~standard", value);
  },
  parse: function _parse(data, params) {
    return parse2(this, data, params, { callee: _parse });
  },
  parseAsync: async function _parseAsync(data, params) {
    return await parseAsync(this, data, params, { callee: _parseAsync });
  },
  safeParse(data, params) {
    return safeParse(this, data, params);
  },
  async safeParseAsync(data, params) {
    return safeParseAsync(this, data, params);
  },
  get spa() {
    return this?.safeParseAsync;
  },
  set spa(value) {
    own(this, "spa", value);
  },
  validate(data, params) {
    return validate(this, data, params);
  },
  validateAsync(data, params) {
    return validateAsync(this, data, params);
  },
  encode: function _encode(data, params) {
    return encode(this, data, params, { callee: _encode });
  },
  decode: function _decode(data, params) {
    return decode(this, data, params, { callee: _decode });
  },
  encodeAsync: async function _encodeAsync(data, params) {
    return await encodeAsync(this, data, params, { callee: _encodeAsync });
  },
  decodeAsync: async function _decodeAsync(data, params) {
    return await decodeAsync(this, data, params, { callee: _decodeAsync });
  },
  safeEncode(data, params) {
    return safeEncode(this, data, params);
  },
  safeDecode(data, params) {
    return safeDecode(this, data, params);
  },
  async safeEncodeAsync(data, params) {
    return safeEncodeAsync(this, data, params);
  },
  async safeDecodeAsync(data, params) {
    return safeDecodeAsync(this, data, params);
  },
  toJSONSchema(params) {
    return createToJSONSchemaMethod(this, {})(params);
  },
  get description() {
    return globalRegistry.get(this)?.description;
  },
  get _def() {
    return this._zod.def;
  }
});
var _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
}, /* @__PURE__ */ derived({
  format: (inst) => aggregateChecks(inst).format ?? null,
  minLength: (inst) => aggregateChecks(inst).minimum ?? null,
  maxLength: (inst) => aggregateChecks(inst).maximum ?? null
}, {
  regex(...args) {
    return this.check(_regex(...args));
  },
  includes(...args) {
    return this.check(_includes(...args));
  },
  startsWith(...args) {
    return this.check(_startsWith(...args));
  },
  endsWith(...args) {
    return this.check(_endsWith(...args));
  },
  min(...args) {
    return this.check(_minLength(...args));
  },
  max(...args) {
    return this.check(_maxLength(...args));
  },
  length(...args) {
    return this.check(_length(...args));
  },
  nonempty(...args) {
    return this.check(_minLength(1, ...args));
  },
  lowercase(params) {
    return this.check(_lowercase(params));
  },
  uppercase(params) {
    return this.check(_uppercase(params));
  },
  trim() {
    return this.check(_trim());
  },
  normalize(...args) {
    return this.check(_normalize(...args));
  },
  toLowerCase() {
    return this.check(_toLowerCase());
  },
  toUpperCase() {
    return this.check(_toUpperCase());
  },
  slugify() {
    return this.check(_slugify());
  }
}));
var ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
  $ZodString.init(inst, def);
  _ZodString.init(inst, def);
}, {
  email(params) {
    return this.check(_email(ZodEmail, params));
  },
  url(params) {
    return this.check(_url(ZodURL, params));
  },
  jwt(params) {
    return this.check(_jwt(ZodJWT, params));
  },
  emoji(params) {
    return this.check(_emoji2(ZodEmoji, params));
  },
  guid(params) {
    return this.check(_guid(ZodGUID, params));
  },
  uuid(params) {
    return this.check(_uuid(ZodUUID, params));
  },
  uuidv4(params) {
    return this.check(_uuidv4(ZodUUID, params));
  },
  uuidv6(params) {
    return this.check(_uuidv6(ZodUUID, params));
  },
  uuidv7(params) {
    return this.check(_uuidv7(ZodUUID, params));
  },
  nanoid(params) {
    return this.check(_nanoid(ZodNanoID, params));
  },
  cuid(params) {
    return this.check(_cuid(ZodCUID, params));
  },
  cuid2(params) {
    return this.check(_cuid2(ZodCUID2, params));
  },
  ulid(params) {
    return this.check(_ulid(ZodULID, params));
  },
  base64(params) {
    return this.check(_base64(ZodBase64, params));
  },
  base64url(params) {
    return this.check(_base64url(ZodBase64URL, params));
  },
  xid(params) {
    return this.check(_xid(ZodXID, params));
  },
  ksuid(params) {
    return this.check(_ksuid(ZodKSUID, params));
  },
  ipv4(params) {
    return this.check(_ipv4(ZodIPv4, params));
  },
  ipv6(params) {
    return this.check(_ipv6(ZodIPv6, params));
  },
  cidrv4(params) {
    return this.check(_cidrv4(ZodCIDRv4, params));
  },
  cidrv6(params) {
    return this.check(_cidrv6(ZodCIDRv6, params));
  },
  e164(params) {
    return this.check(_e164(ZodE164, params));
  },
  datetime(params) {
    return this.check(_isoDateTime(ZodISODateTime, params));
  },
  date(params) {
    return this.check(_isoDate(ZodISODate, params));
  },
  time(params) {
    return this.check(_isoTime(ZodISOTime, params));
  },
  duration(params) {
    return this.check(_isoDuration(ZodISODuration, params));
  }
});
function string2(params) {
  return _string(ZodString, params);
}
var ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
  $ZodStringFormat.init(inst, def);
  _ZodString.init(inst, def);
});
var ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
  $ZodISODateTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
  $ZodISODate.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
  $ZodISOTime.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
  $ZodISODuration.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
  $ZodEmail.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function email2(params) {
  return _email(ZodEmail, params);
}
var ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
  $ZodGUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
  $ZodUUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
  $ZodURL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
function url(params) {
  return _url(ZodURL, params);
}
var ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
  $ZodEmoji.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
  $ZodNanoID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
  $ZodCUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
  $ZodCUID2.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
  $ZodULID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
  $ZodXID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
  $ZodKSUID.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
  $ZodIPv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
  $ZodIPv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
  $ZodCIDRv4.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
  $ZodCIDRv6.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
  $ZodBase64.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
  $ZodBase64URL.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
  $ZodE164.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
  $ZodJWT.init(inst, def);
  ZodStringFormat.init(inst, def);
});
var ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
  $ZodNumber.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
  inst.isFinite = true;
}, /* @__PURE__ */ derived({
  minValue: (inst) => {
    const { minimum, exclusiveMinimum } = aggregateChecks(inst);
    return Math.max(minimum ?? Number.NEGATIVE_INFINITY, exclusiveMinimum ?? Number.NEGATIVE_INFINITY);
  },
  maxValue: (inst) => {
    const { maximum, exclusiveMaximum } = aggregateChecks(inst);
    return Math.min(maximum ?? Number.POSITIVE_INFINITY, exclusiveMaximum ?? Number.POSITIVE_INFINITY);
  },
  isInt: (inst) => {
    const { isInt, multipleOf } = aggregateChecks(inst);
    return !!isInt || !!multipleOf?.some(Number.isSafeInteger);
  },
  format: (inst) => aggregateChecks(inst).format ?? null
}, {
  gt(value, params) {
    return this.check(_gt(value, params));
  },
  gte(value, params) {
    return this.check(_gte(value, params));
  },
  min(value, params) {
    return this.check(_gte(value, params));
  },
  lt(value, params) {
    return this.check(_lt(value, params));
  },
  lte(value, params) {
    return this.check(_lte(value, params));
  },
  max(value, params) {
    return this.check(_lte(value, params));
  },
  int(params) {
    return this.check(int(params));
  },
  safe(params) {
    return this.check(int(params));
  },
  positive(params) {
    return this.check(_gt(0, params));
  },
  nonnegative(params) {
    return this.check(_gte(0, params));
  },
  negative(params) {
    return this.check(_lt(0, params));
  },
  nonpositive(params) {
    return this.check(_lte(0, params));
  },
  multipleOf(value, params) {
    return this.check(_multipleOf(value, params));
  },
  step(value, params) {
    return this.check(_multipleOf(value, params));
  },
  finite() {
    return this;
  }
}));
function number2(params) {
  return _number(ZodNumber, params);
}
var ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
  $ZodNumberFormat.init(inst, def);
  ZodNumber.init(inst, def);
});
function int(params) {
  return _int(ZodNumberFormat, params);
}
var ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
  $ZodBoolean.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean2(params) {
  return _boolean(ZodBoolean, params);
}
var ZodNull = /* @__PURE__ */ $constructor("ZodNull", (inst, def) => {
  $ZodNull.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullProcessor(inst, ctx, json, params);
});
function _null3(params) {
  return _null2(ZodNull, params);
}
var ZodAny = /* @__PURE__ */ $constructor("ZodAny", (inst, def) => {
  $ZodAny.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => anyProcessor(inst, ctx, json, params);
});
function any() {
  return _any(ZodAny);
}
var ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
  $ZodUnknown.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
  return _unknown(ZodUnknown);
}
var ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
  $ZodNever.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
  return _never(ZodNever, params);
}
var ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodArray.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
  inst.element = def.element;
}, {
  min(n, params) {
    return this.check(_minLength(n, params));
  },
  nonempty(params) {
    return this.check(_minLength(1, params));
  },
  max(n, params) {
    return this.check(_maxLength(n, params));
  },
  length(n, params) {
    return this.check(_length(n, params));
  },
  unwrap() {
    return this.element;
  }
});
function array(element, params) {
  return _array(ZodArray, element, params);
}
var ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodObjectJIT.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
  installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
  keyof() {
    return _enum(Object.keys(this._zod.def.shape));
  },
  catchall(catchall) {
    return this.clone(mergeDefs(this._zod.def, { catchall }));
  },
  passthrough() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  loose() {
    return this.clone(mergeDefs(this._zod.def, { catchall: unknown() }));
  },
  strict() {
    return this.clone(mergeDefs(this._zod.def, { catchall: never() }));
  },
  strip() {
    return this.clone(mergeDefs(this._zod.def, { catchall: undefined }));
  },
  extend(incoming) {
    return extend(this, incoming);
  },
  safeExtend(incoming) {
    return safeExtend(this, incoming);
  },
  merge(other) {
    return merge(this, other);
  },
  pick(mask) {
    return pick(this, mask);
  },
  omit(mask) {
    return omit(this, mask);
  },
  partial(...args) {
    return partial(ZodOptional, this, args[0]);
  },
  exactPartial(...args) {
    return partial(ZodExactOptional, this, args[0], "exactPartial");
  },
  required(...args) {
    return required(ZodNonOptional, this, args[0]);
  }
});
function object(shape, params) {
  const def = {
    type: "object",
    shape: shape ?? {},
    ...normalizeParams(params)
  };
  return new ZodObject(def);
}
function looseObject(shape, params) {
  return new ZodObject({
    type: "object",
    shape,
    catchall: unknown(),
    ...normalizeParams(params)
  });
}
var ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
  $ZodUnion.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
  inst.options = def.options;
});
function union(options, params) {
  return new ZodUnion({
    type: "union",
    options,
    ...normalizeParams(params)
  });
}
var ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
  ZodUnion.init(inst, def);
  $ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
  return new ZodDiscriminatedUnion({
    type: "union",
    options,
    discriminator,
    ...normalizeParams(params)
  });
}
var ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
  $ZodIntersection.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
  return new ZodIntersection({
    type: "intersection",
    left,
    right
  });
}
var ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodRecord.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
  inst.keyType = def.keyType;
  inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
  if (!valueType || !valueType._zod) {
    return new ZodRecord({
      type: "record",
      keyType: string2(),
      valueType: keyType,
      ...normalizeParams(valueType)
    });
  }
  return new ZodRecord({
    type: "record",
    keyType,
    valueType,
    ...normalizeParams(params)
  });
}
var ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
  $ZodEnum.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
  inst.enum = def.entries;
  inst.options = [...inst._zod.values];
  const keys = new Set(Object.keys(def.entries));
  inst.extract = (values, params) => {
    const newEntries = {};
    for (const value of values) {
      if (keys.has(value)) {
        newEntries[value] = def.entries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
  inst.exclude = (values, params) => {
    const newEntries = { ...def.entries };
    for (const value of values) {
      if (keys.has(value)) {
        delete newEntries[value];
      } else
        throw new Error(`Key ${value} not found in enum`);
    }
    return new ZodEnum({
      ...def,
      checks: [],
      ...normalizeParams(params),
      entries: newEntries
    });
  };
});
function _enum(values, params) {
  const entries = Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values;
  return new ZodEnum({
    type: "enum",
    entries,
    ...normalizeParams(params)
  });
}
var ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
  $ZodLiteral.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
  inst.values = new Set(def.values);
  Object.defineProperty(inst, "value", {
    get() {
      if (def.values.length > 1) {
        throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
      }
      return def.values[0];
    }
  });
});
function literal(value, params) {
  return new ZodLiteral({
    type: "literal",
    values: Array.isArray(value) ? value : [value],
    ...normalizeParams(params)
  });
}
var ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
  _ensureDefaultMemoizer();
  $ZodTransform.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
  inst._zod.parse = (payload, _ctx) => {
    if (_ctx.direction === "backward") {
      throw new $ZodEncodeError(inst.constructor.name);
    }
    payload.addIssue = (issue2) => {
      if (typeof issue2 === "string") {
        payload.issues.push(issue(issue2, payload.value, def));
      } else {
        const _issue = issue2;
        if (_issue.fatal)
          _issue.continue = false;
        _issue.code ?? (_issue.code = "custom");
        if (!("input" in _issue))
          _issue.input = payload.value;
        _issue.inst ?? (_issue.inst = inst);
        payload.issues.push(issue(_issue));
      }
    };
    const output = def.transform(payload.value, payload);
    if (output instanceof Promise) {
      return output.then((output) => {
        payload.value = output;
        return payload;
      });
    }
    payload.value = output;
    return payload;
  };
});
function transform(fn) {
  return new ZodTransform({
    type: "transform",
    transform: fn
  });
}
var ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
  $ZodOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
  return new ZodOptional({
    type: "optional",
    innerType
  });
}
var ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
  $ZodExactOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
  return new ZodExactOptional({
    type: "optional",
    innerType
  });
}
var ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
  $ZodNullable.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
  return new ZodNullable({
    type: "nullable",
    innerType
  });
}
var ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
  $ZodDefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
  return new ZodDefault({
    type: "default",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
  $ZodPrefault.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
  return new ZodPrefault({
    type: "prefault",
    innerType,
    get defaultValue() {
      return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
    }
  });
}
var ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
  $ZodNonOptional.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
  return new ZodNonOptional({
    type: "nonoptional",
    innerType,
    ...normalizeParams(params)
  });
}
var ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
  $ZodCatch.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
  inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
  return new ZodCatch({
    type: "catch",
    innerType,
    catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
  });
}
var ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
  $ZodPipe.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
  inst.in = def.in;
  inst.out = def.out;
});
function pipe(in_, out) {
  return new ZodPipe({
    type: "pipe",
    in: in_,
    out
  });
}
var ZodPreprocess = /* @__PURE__ */ $constructor("ZodPreprocess", (inst, def) => {
  ZodPipe.init(inst, def);
  $ZodPreprocess.init(inst, def);
});
var ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
  $ZodReadonly.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
  return new ZodReadonly({
    type: "readonly",
    innerType
  });
}
var ZodLazy = /* @__PURE__ */ $constructor("ZodLazy", (inst, def) => {
  $ZodLazy.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => lazyProcessor(inst, ctx, json, params);
  inst.unwrap = () => inst._zod.def.getter();
});
function lazy(getter) {
  return new ZodLazy({
    type: "lazy",
    getter
  });
}
var ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
  $ZodCustom.init(inst, def);
  ZodType.init(inst, def);
  inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
  return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
  return _superRefine(fn, params);
}
function preprocess(fn, schema) {
  return new ZodPreprocess({
    type: "pipe",
    in: transform(fn),
    out: schema
  });
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/compat.js
var ZodIssueCode = {
  invalid_type: "invalid_type",
  too_big: "too_big",
  too_small: "too_small",
  invalid_format: "invalid_format",
  not_multiple_of: "not_multiple_of",
  unrecognized_keys: "unrecognized_keys",
  invalid_union: "invalid_union",
  invalid_key: "invalid_key",
  invalid_element: "invalid_element",
  invalid_value: "invalid_value",
  custom: "custom"
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind) {})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/iso.js
function datetime2(params) {
  return _isoDateTime(ZodISODateTime, params);
}
function date2(params) {
  return _isoDate(ZodISODate, params);
}
// ../../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/classic/coerce.js
function number3(params) {
  return _coercedNumber(ZodNumber, params);
}
// ../../node_modules/.bun/@modelcontextprotocol+core@2.4.0/node_modules/@modelcontextprotocol/core/dist/schemas-DscsoNZN.mjs
var LATEST_PROTOCOL_VERSION = "2025-11-25";
var SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
];
var RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";
var PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
var CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
var SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
var CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
var SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
var LOG_LEVEL_META_KEY = "io.modelcontextprotocol/logLevel";
var JSONRPC_VERSION = "2.0";
var JSONValueSchema = lazy(() => union([
  string2(),
  number2(),
  boolean2(),
  _null3(),
  record(string2(), JSONValueSchema),
  array(JSONValueSchema)
]));
var JSONObjectSchema = record(string2(), JSONValueSchema);
var JSONArraySchema = array(JSONValueSchema);
var ProgressTokenSchema = union([string2(), number2().int()]);
var CursorSchema = string2();
var TaskMetadataSchema = object({ ttl: number2().optional() });
var RelatedTaskMetadataSchema = object({ taskId: string2() });
var RequestMetaSchema = looseObject({
  progressToken: ProgressTokenSchema.optional(),
  [RELATED_TASK_META_KEY]: RelatedTaskMetadataSchema.optional()
});
var BaseRequestParamsSchema = object({ _meta: RequestMetaSchema.optional() });
var TaskAugmentedRequestParamsSchema = BaseRequestParamsSchema.extend({ task: TaskMetadataSchema.optional() });
var RequestSchema = object({
  method: string2(),
  params: BaseRequestParamsSchema.loose().optional()
});
var NotificationsParamsSchema = object({ _meta: RequestMetaSchema.optional() });
var NotificationSchema = object({
  method: string2(),
  params: NotificationsParamsSchema.loose().optional()
});
var ResultMetaObjectSchema = looseObject({ get [SERVER_INFO_META_KEY]() {
  return ImplementationSchema.optional().catch(undefined);
} });
var ResultSchema = looseObject({ _meta: ResultMetaObjectSchema.optional() });
var RequestIdSchema = union([string2(), number2().int()]);
var JSONRPCRequestSchema = object({
  jsonrpc: literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  ...RequestSchema.shape
}).strict();
var JSONRPCNotificationSchema = object({
  jsonrpc: literal(JSONRPC_VERSION),
  ...NotificationSchema.shape
}).strict();
var JSONRPCResultResponseSchema = object({
  jsonrpc: literal(JSONRPC_VERSION),
  id: RequestIdSchema,
  result: ResultSchema
}).strict();
var JSONRPCErrorResponseSchema = object({
  jsonrpc: literal(JSONRPC_VERSION),
  id: RequestIdSchema.optional(),
  error: object({
    code: number2().int(),
    message: string2(),
    data: unknown().optional()
  })
}).strict();
var JSONRPCMessageSchema = union([
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  JSONRPCResultResponseSchema,
  JSONRPCErrorResponseSchema
]);
var JSONRPCResponseSchema = union([JSONRPCResultResponseSchema, JSONRPCErrorResponseSchema]);
var EmptyResultSchema = ResultSchema.strict();
var CancelledNotificationParamsSchema = NotificationsParamsSchema.extend({
  requestId: RequestIdSchema.optional(),
  reason: string2().optional()
});
var CancelledNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/cancelled"),
  params: CancelledNotificationParamsSchema
});
var IconSchema = object({
  src: string2(),
  mimeType: string2().optional(),
  sizes: array(string2()).optional(),
  theme: _enum(["light", "dark"]).optional()
});
var IconsSchema = object({ icons: array(IconSchema).optional() });
var BaseMetadataSchema = object({
  name: string2(),
  title: string2().optional()
});
var ImplementationSchema = BaseMetadataSchema.extend({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  version: string2(),
  websiteUrl: string2().optional(),
  description: string2().optional()
});
var FormElicitationCapabilitySchema = intersection(object({ applyDefaults: boolean2().optional() }), JSONObjectSchema);
var ElicitationCapabilitySchema = preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
    return { form: {} };
  return value;
}, intersection(object({
  form: FormElicitationCapabilitySchema.optional(),
  url: JSONObjectSchema.optional()
}), JSONObjectSchema.optional()));
var ClientTasksCapabilitySchema = looseObject({
  list: JSONObjectSchema.optional(),
  cancel: JSONObjectSchema.optional(),
  requests: looseObject({
    sampling: looseObject({ createMessage: JSONObjectSchema.optional() }).optional(),
    elicitation: looseObject({ create: JSONObjectSchema.optional() }).optional()
  }).optional()
});
var ServerTasksCapabilitySchema = looseObject({
  list: JSONObjectSchema.optional(),
  cancel: JSONObjectSchema.optional(),
  requests: looseObject({ tools: looseObject({ call: JSONObjectSchema.optional() }).optional() }).optional()
});
var ClientCapabilitiesSchema = object({
  experimental: record(string2(), JSONObjectSchema).optional(),
  sampling: object({
    context: JSONObjectSchema.optional(),
    tools: JSONObjectSchema.optional()
  }).optional(),
  elicitation: ElicitationCapabilitySchema.optional(),
  roots: object({ listChanged: boolean2().optional() }).optional(),
  tasks: ClientTasksCapabilitySchema.optional(),
  extensions: record(string2(), JSONObjectSchema).optional()
});
var InitializeRequestParamsSchema = BaseRequestParamsSchema.extend({
  protocolVersion: string2(),
  capabilities: ClientCapabilitiesSchema,
  clientInfo: ImplementationSchema
});
var InitializeRequestSchema = RequestSchema.extend({
  method: literal("initialize"),
  params: InitializeRequestParamsSchema
});
var ServerCapabilitiesSchema = object({
  experimental: record(string2(), JSONObjectSchema).optional(),
  logging: JSONObjectSchema.optional(),
  completions: JSONObjectSchema.optional(),
  prompts: object({ listChanged: boolean2().optional() }).optional(),
  resources: object({
    subscribe: boolean2().optional(),
    listChanged: boolean2().optional()
  }).optional(),
  tools: object({ listChanged: boolean2().optional() }).optional(),
  tasks: ServerTasksCapabilitySchema.optional(),
  extensions: record(string2(), JSONObjectSchema).optional()
});
var InitializeResultSchema = ResultSchema.extend({
  protocolVersion: string2(),
  capabilities: ServerCapabilitiesSchema,
  serverInfo: ImplementationSchema,
  instructions: string2().optional()
});
var InitializedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/initialized"),
  params: NotificationsParamsSchema.optional()
});
var DiscoverRequestSchema = RequestSchema.extend({
  method: literal("server/discover"),
  params: BaseRequestParamsSchema.optional()
});
var DiscoverResultSchema = ResultSchema.extend({
  supportedVersions: array(string2()),
  capabilities: ServerCapabilitiesSchema,
  instructions: string2().optional()
});
var PingRequestSchema = RequestSchema.extend({
  method: literal("ping"),
  params: BaseRequestParamsSchema.optional()
});
var ProgressSchema = object({
  progress: number2(),
  total: optional(number2()),
  message: optional(string2())
});
var ProgressNotificationParamsSchema = object({
  ...NotificationsParamsSchema.shape,
  ...ProgressSchema.shape,
  progressToken: ProgressTokenSchema
});
var ProgressNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/progress"),
  params: ProgressNotificationParamsSchema
});
var PaginatedRequestParamsSchema = BaseRequestParamsSchema.extend({ cursor: CursorSchema.optional() });
var PaginatedRequestSchema = RequestSchema.extend({ params: PaginatedRequestParamsSchema.optional() });
var PaginatedResultSchema = ResultSchema.extend({ nextCursor: CursorSchema.optional() });
var ResourceContentsSchema = object({
  uri: string2(),
  mimeType: optional(string2()),
  _meta: record(string2(), unknown()).optional()
});
var TextResourceContentsSchema = ResourceContentsSchema.extend({ text: string2() });
var Base64Schema = string2().refine((val) => {
  try {
    atob(val);
    return true;
  } catch {
    return false;
  }
}, { message: "Invalid Base64 string" });
var BlobResourceContentsSchema = ResourceContentsSchema.extend({ blob: Base64Schema });
var RoleSchema = _enum(["user", "assistant"]);
var AnnotationsSchema = object({
  audience: array(RoleSchema).optional(),
  priority: number2().min(0).max(1).optional(),
  lastModified: datetime2({ offset: true }).optional()
});
var ResourceSchema = object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  uri: string2(),
  description: optional(string2()),
  mimeType: optional(string2()),
  size: optional(number2()),
  annotations: AnnotationsSchema.optional(),
  _meta: optional(looseObject({}))
});
var ResourceTemplateSchema = object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  uriTemplate: string2(),
  description: optional(string2()),
  mimeType: optional(string2()),
  annotations: AnnotationsSchema.optional(),
  _meta: optional(looseObject({}))
});
var ListResourcesRequestSchema = PaginatedRequestSchema.extend({ method: literal("resources/list") });
var ListResourcesResultSchema = PaginatedResultSchema.extend({ resources: array(ResourceSchema) });
var ListResourceTemplatesRequestSchema = PaginatedRequestSchema.extend({ method: literal("resources/templates/list") });
var ListResourceTemplatesResultSchema = PaginatedResultSchema.extend({ resourceTemplates: array(ResourceTemplateSchema) });
var ResourceRequestParamsSchema = BaseRequestParamsSchema.extend({ uri: string2() });
var ReadResourceRequestParamsSchema = ResourceRequestParamsSchema;
var ReadResourceRequestSchema = RequestSchema.extend({
  method: literal("resources/read"),
  params: ReadResourceRequestParamsSchema
});
var ReadResourceResultSchema = ResultSchema.extend({ contents: array(union([TextResourceContentsSchema, BlobResourceContentsSchema])) });
var ResourceListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/resources/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var SubscribeRequestParamsSchema = ResourceRequestParamsSchema;
var SubscribeRequestSchema = RequestSchema.extend({
  method: literal("resources/subscribe"),
  params: SubscribeRequestParamsSchema
});
var UnsubscribeRequestParamsSchema = ResourceRequestParamsSchema;
var UnsubscribeRequestSchema = RequestSchema.extend({
  method: literal("resources/unsubscribe"),
  params: UnsubscribeRequestParamsSchema
});
var SubscriptionFilterSchema = object({
  toolsListChanged: boolean2().optional(),
  promptsListChanged: boolean2().optional(),
  resourcesListChanged: boolean2().optional(),
  resourceSubscriptions: array(string2()).optional()
});
var SubscriptionsListenRequestParamsSchema = BaseRequestParamsSchema.extend({ notifications: SubscriptionFilterSchema });
var SubscriptionsListenRequestSchema = RequestSchema.extend({
  method: literal("subscriptions/listen"),
  params: SubscriptionsListenRequestParamsSchema
});
var SubscriptionsAcknowledgedNotificationParamsSchema = NotificationsParamsSchema.extend({ notifications: SubscriptionFilterSchema });
var SubscriptionsAcknowledgedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/subscriptions/acknowledged"),
  params: SubscriptionsAcknowledgedNotificationParamsSchema
});
var SubscriptionsListenResultMetaSchema = ResultMetaObjectSchema.extend({ [SUBSCRIPTION_ID_META_KEY]: RequestIdSchema });
var SubscriptionsListenResultSchema = ResultSchema.extend({ _meta: SubscriptionsListenResultMetaSchema });
var ResourceUpdatedNotificationParamsSchema = NotificationsParamsSchema.extend({ uri: string2() });
var ResourceUpdatedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/resources/updated"),
  params: ResourceUpdatedNotificationParamsSchema
});
var PromptArgumentSchema = object({
  name: string2(),
  description: optional(string2()),
  required: optional(boolean2())
});
var PromptSchema = object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  description: optional(string2()),
  arguments: optional(array(PromptArgumentSchema)),
  _meta: optional(looseObject({}))
});
var ListPromptsRequestSchema = PaginatedRequestSchema.extend({ method: literal("prompts/list") });
var ListPromptsResultSchema = PaginatedResultSchema.extend({ prompts: array(PromptSchema) });
var GetPromptRequestParamsSchema = BaseRequestParamsSchema.extend({
  name: string2(),
  arguments: record(string2(), string2()).optional()
});
var GetPromptRequestSchema = RequestSchema.extend({
  method: literal("prompts/get"),
  params: GetPromptRequestParamsSchema
});
var TextContentSchema = object({
  type: literal("text"),
  text: string2(),
  annotations: AnnotationsSchema.optional(),
  _meta: record(string2(), unknown()).optional()
});
var ImageContentSchema = object({
  type: literal("image"),
  data: Base64Schema,
  mimeType: string2(),
  annotations: AnnotationsSchema.optional(),
  _meta: record(string2(), unknown()).optional()
});
var AudioContentSchema = object({
  type: literal("audio"),
  data: Base64Schema,
  mimeType: string2(),
  annotations: AnnotationsSchema.optional(),
  _meta: record(string2(), unknown()).optional()
});
var ToolUseContentSchema = object({
  type: literal("tool_use"),
  name: string2(),
  id: string2(),
  input: record(string2(), unknown()),
  _meta: record(string2(), unknown()).optional()
});
var EmbeddedResourceSchema = object({
  type: literal("resource"),
  resource: union([TextResourceContentsSchema, BlobResourceContentsSchema]),
  annotations: AnnotationsSchema.optional(),
  _meta: record(string2(), unknown()).optional()
});
var ResourceLinkSchema = ResourceSchema.extend({ type: literal("resource_link") });
var ContentBlockSchema = union([
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ResourceLinkSchema,
  EmbeddedResourceSchema
]);
var PromptMessageSchema = object({
  role: RoleSchema,
  content: ContentBlockSchema
});
var GetPromptResultSchema = ResultSchema.extend({
  description: string2().optional(),
  messages: array(PromptMessageSchema)
});
var PromptListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/prompts/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ToolAnnotationsSchema = object({
  title: string2().optional(),
  readOnlyHint: boolean2().optional(),
  destructiveHint: boolean2().optional(),
  idempotentHint: boolean2().optional(),
  openWorldHint: boolean2().optional()
});
var ToolExecutionSchema = object({ taskSupport: _enum([
  "required",
  "optional",
  "forbidden"
]).optional() });
var ToolSchema = object({
  ...BaseMetadataSchema.shape,
  ...IconsSchema.shape,
  description: string2().optional(),
  inputSchema: object({
    type: literal("object"),
    properties: record(string2(), JSONValueSchema).optional(),
    required: array(string2()).optional()
  }).catchall(unknown()),
  outputSchema: looseObject({ $schema: string2().optional() }).optional(),
  annotations: ToolAnnotationsSchema.optional(),
  execution: ToolExecutionSchema.optional(),
  _meta: record(string2(), unknown()).optional()
});
var ListToolsRequestSchema = PaginatedRequestSchema.extend({ method: literal("tools/list") });
var ListToolsResultSchema = PaginatedResultSchema.extend({ tools: array(ToolSchema) });
var CallToolResultSchema = ResultSchema.extend({
  content: array(ContentBlockSchema).default([]),
  structuredContent: unknown().optional(),
  isError: boolean2().optional()
});
var CompatibilityCallToolResultSchema = CallToolResultSchema.or(ResultSchema.extend({ toolResult: unknown() }));
var CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  name: string2(),
  arguments: record(string2(), unknown()).optional()
});
var CallToolRequestSchema = RequestSchema.extend({
  method: literal("tools/call"),
  params: CallToolRequestParamsSchema
});
var ToolListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/tools/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var ListChangedOptionsBaseSchema = object({
  autoRefresh: boolean2().default(true),
  debounceMs: number2().int().nonnegative().default(300)
});
var LoggingLevelSchema = _enum([
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency"
]);
var SetLevelRequestParamsSchema = BaseRequestParamsSchema.extend({ level: LoggingLevelSchema });
var SetLevelRequestSchema = RequestSchema.extend({
  method: literal("logging/setLevel"),
  params: SetLevelRequestParamsSchema
});
var LoggingMessageNotificationParamsSchema = NotificationsParamsSchema.extend({
  level: LoggingLevelSchema,
  logger: string2().optional(),
  data: unknown()
});
var LoggingMessageNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/message"),
  params: LoggingMessageNotificationParamsSchema
});
var ModelHintSchema = object({ name: string2().optional() });
var ModelPreferencesSchema = object({
  hints: array(ModelHintSchema).optional(),
  costPriority: number2().min(0).max(1).optional(),
  speedPriority: number2().min(0).max(1).optional(),
  intelligencePriority: number2().min(0).max(1).optional()
});
var ToolChoiceSchema = object({ mode: _enum([
  "auto",
  "required",
  "none"
]).optional() });
var ToolResultContentSchema = object({
  type: literal("tool_result"),
  toolUseId: string2().describe("The unique identifier for the corresponding tool call."),
  content: array(ContentBlockSchema),
  structuredContent: unknown().optional(),
  isError: boolean2().optional(),
  _meta: record(string2(), unknown()).optional()
});
var SamplingContentSchema = discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema
]);
var SamplingMessageContentBlockSchema = discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  AudioContentSchema,
  ToolUseContentSchema,
  ToolResultContentSchema
]);
var SamplingMessageSchema = object({
  role: RoleSchema,
  content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)]),
  _meta: record(string2(), unknown()).optional()
});
var CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  messages: array(SamplingMessageSchema),
  modelPreferences: ModelPreferencesSchema.optional(),
  systemPrompt: string2().optional(),
  includeContext: _enum([
    "none",
    "thisServer",
    "allServers"
  ]).optional(),
  temperature: number2().optional(),
  maxTokens: number2().int(),
  stopSequences: array(string2()).optional(),
  metadata: JSONObjectSchema.optional(),
  tools: array(ToolSchema).optional(),
  toolChoice: ToolChoiceSchema.optional()
});
var CreateMessageRequestSchema = RequestSchema.extend({
  method: literal("sampling/createMessage"),
  params: CreateMessageRequestParamsSchema
});
var CreateMessageResultSchema = ResultSchema.extend({
  model: string2(),
  stopReason: optional(_enum([
    "endTurn",
    "stopSequence",
    "maxTokens"
  ]).or(string2())),
  role: RoleSchema,
  content: SamplingContentSchema
});
var CreateMessageResultWithToolsSchema = ResultSchema.extend({
  model: string2(),
  stopReason: optional(_enum([
    "endTurn",
    "stopSequence",
    "maxTokens",
    "toolUse"
  ]).or(string2())),
  role: RoleSchema,
  content: union([SamplingMessageContentBlockSchema, array(SamplingMessageContentBlockSchema)])
});
var BooleanSchemaSchema = object({
  type: literal("boolean"),
  title: string2().optional(),
  description: string2().optional(),
  default: boolean2().optional()
});
var StringSchemaSchema = object({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  minLength: number2().optional(),
  maxLength: number2().optional(),
  format: _enum([
    "email",
    "uri",
    "date",
    "date-time"
  ]).optional(),
  default: string2().optional()
});
var NumberSchemaSchema = object({
  type: _enum(["number", "integer"]),
  title: string2().optional(),
  description: string2().optional(),
  minimum: number2().optional(),
  maximum: number2().optional(),
  default: number2().optional()
});
var UntitledSingleSelectEnumSchemaSchema = object({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  enum: array(string2()),
  default: string2().optional()
});
var TitledSingleSelectEnumSchemaSchema = object({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  oneOf: array(object({
    const: string2(),
    title: string2()
  })),
  default: string2().optional()
});
var LegacyTitledEnumSchemaSchema = object({
  type: literal("string"),
  title: string2().optional(),
  description: string2().optional(),
  enum: array(string2()),
  enumNames: array(string2()).optional(),
  default: string2().optional()
});
var SingleSelectEnumSchemaSchema = union([UntitledSingleSelectEnumSchemaSchema, TitledSingleSelectEnumSchemaSchema]);
var UntitledMultiSelectEnumSchemaSchema = object({
  type: literal("array"),
  title: string2().optional(),
  description: string2().optional(),
  minItems: number2().optional(),
  maxItems: number2().optional(),
  items: object({
    type: literal("string"),
    enum: array(string2())
  }),
  default: array(string2()).optional()
});
var TitledMultiSelectEnumSchemaSchema = object({
  type: literal("array"),
  title: string2().optional(),
  description: string2().optional(),
  minItems: number2().optional(),
  maxItems: number2().optional(),
  items: object({ anyOf: array(object({
    const: string2(),
    title: string2()
  })) }),
  default: array(string2()).optional()
});
var MultiSelectEnumSchemaSchema = union([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema]);
var EnumSchemaSchema = union([
  LegacyTitledEnumSchemaSchema,
  SingleSelectEnumSchemaSchema,
  MultiSelectEnumSchemaSchema
]);
var PrimitiveSchemaDefinitionSchema = union([
  EnumSchemaSchema,
  BooleanSchemaSchema,
  StringSchemaSchema,
  NumberSchemaSchema
]);
var ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  mode: literal("form").optional(),
  message: string2(),
  requestedSchema: object({
    type: literal("object"),
    properties: record(string2(), PrimitiveSchemaDefinitionSchema),
    required: array(string2()).optional()
  }).catchall(unknown())
});
var ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({
  mode: literal("url"),
  message: string2(),
  elicitationId: string2(),
  url: string2().url()
});
var ElicitRequestParamsSchema = union([ElicitRequestFormParamsSchema, ElicitRequestURLParamsSchema]);
var ElicitRequestSchema = RequestSchema.extend({
  method: literal("elicitation/create"),
  params: ElicitRequestParamsSchema
});
var ElicitationCompleteNotificationParamsSchema = NotificationsParamsSchema.extend({ elicitationId: string2() });
var ElicitationCompleteNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/elicitation/complete"),
  params: ElicitationCompleteNotificationParamsSchema
});
var ElicitResultSchema = ResultSchema.extend({
  action: _enum([
    "accept",
    "decline",
    "cancel"
  ]),
  content: preprocess((val) => val === null ? undefined : val, record(string2(), union([
    string2(),
    number2(),
    boolean2(),
    array(string2())
  ])).optional())
});
var ResourceTemplateReferenceSchema = object({
  type: literal("ref/resource"),
  uri: string2()
});
var PromptReferenceSchema = object({
  type: literal("ref/prompt"),
  name: string2()
});
var CompleteRequestParamsSchema = BaseRequestParamsSchema.extend({
  ref: union([PromptReferenceSchema, ResourceTemplateReferenceSchema]),
  argument: object({
    name: string2(),
    value: string2()
  }),
  context: object({ arguments: record(string2(), string2()).optional() }).optional()
});
var CompleteRequestSchema = RequestSchema.extend({
  method: literal("completion/complete"),
  params: CompleteRequestParamsSchema
});
var CompleteResultSchema = ResultSchema.extend({ completion: looseObject({
  values: array(string2()).max(100),
  total: optional(number2().int()),
  hasMore: optional(boolean2())
}) });
var RootSchema = object({
  uri: string2().startsWith("file://"),
  name: string2().optional(),
  _meta: record(string2(), unknown()).optional()
});
var ListRootsRequestSchema = RequestSchema.extend({
  method: literal("roots/list"),
  params: BaseRequestParamsSchema.optional()
});
var ListRootsResultSchema = ResultSchema.extend({ roots: array(RootSchema) });
var RootsListChangedNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/roots/list_changed"),
  params: NotificationsParamsSchema.optional()
});
var TaskCreationParamsSchema = looseObject({
  ttl: number2().optional(),
  pollInterval: number2().optional()
});
var TaskStatusSchema = _enum([
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled"
]);
var TaskSchema = object({
  taskId: string2(),
  status: TaskStatusSchema,
  ttl: union([number2(), _null3()]),
  createdAt: string2(),
  lastUpdatedAt: string2(),
  pollInterval: optional(number2()),
  statusMessage: optional(string2())
});
var CreateTaskResultSchema = ResultSchema.extend({ task: TaskSchema });
var TaskStatusNotificationParamsSchema = NotificationsParamsSchema.merge(TaskSchema);
var TaskStatusNotificationSchema = NotificationSchema.extend({
  method: literal("notifications/tasks/status"),
  params: TaskStatusNotificationParamsSchema
});
var GetTaskRequestSchema = RequestSchema.extend({
  method: literal("tasks/get"),
  params: BaseRequestParamsSchema.extend({ taskId: string2() })
});
var GetTaskResultSchema = ResultSchema.merge(TaskSchema);
var GetTaskPayloadRequestSchema = RequestSchema.extend({
  method: literal("tasks/result"),
  params: BaseRequestParamsSchema.extend({ taskId: string2() })
});
var GetTaskPayloadResultSchema = ResultSchema.loose();
var ListTasksRequestSchema = PaginatedRequestSchema.extend({ method: literal("tasks/list") });
var ListTasksResultSchema = PaginatedResultSchema.extend({ tasks: array(TaskSchema) });
var CancelTaskRequestSchema = RequestSchema.extend({
  method: literal("tasks/cancel"),
  params: BaseRequestParamsSchema.extend({ taskId: string2() })
});
var CancelTaskResultSchema = ResultSchema.merge(TaskSchema);
var ClientRequestSchema = union([
  PingRequestSchema,
  InitializeRequestSchema,
  DiscoverRequestSchema,
  CompleteRequestSchema,
  SetLevelRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  SubscriptionsListenRequestSchema,
  CallToolRequestSchema,
  ListToolsRequestSchema
]);
var ClientNotificationSchema = union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  InitializedNotificationSchema,
  RootsListChangedNotificationSchema
]);
var ClientResultSchema = union([
  EmptyResultSchema,
  CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema,
  ElicitResultSchema,
  ListRootsResultSchema
]);
var ServerRequestSchema = union([
  PingRequestSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema
]);
var ServerNotificationSchema = union([
  CancelledNotificationSchema,
  ProgressNotificationSchema,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  SubscriptionsAcknowledgedNotificationSchema,
  ElicitationCompleteNotificationSchema
]);
var ServerResultSchema = union([
  EmptyResultSchema,
  InitializeResultSchema,
  DiscoverResultSchema,
  CompleteResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  CallToolResultSchema,
  ListToolsResultSchema,
  SubscriptionsListenResultSchema
]);

// ../../node_modules/.bun/@modelcontextprotocol+core@2.4.0/node_modules/@modelcontextprotocol/core/dist/auth-UMQCo-ad.mjs
var SafeUrlSchema = url().superRefine((val, ctx) => {
  if (!URL.canParse(val)) {
    ctx.addIssue({
      code: ZodIssueCode.custom,
      message: "URL must be parseable",
      fatal: true
    });
    return NEVER;
  }
}).refine((url) => {
  const u = new URL(url);
  return u.protocol !== "javascript:" && u.protocol !== "data:" && u.protocol !== "vbscript:";
}, { message: "URL cannot use javascript:, data:, or vbscript: scheme" });
var OAuthProtectedResourceMetadataSchema = looseObject({
  resource: string2().url(),
  authorization_servers: array(SafeUrlSchema).optional(),
  jwks_uri: string2().url().optional(),
  scopes_supported: array(string2()).optional(),
  bearer_methods_supported: array(string2()).optional(),
  resource_signing_alg_values_supported: array(string2()).optional(),
  resource_name: string2().optional(),
  resource_documentation: string2().optional(),
  resource_policy_uri: string2().url().optional(),
  resource_tos_uri: string2().url().optional(),
  tls_client_certificate_bound_access_tokens: boolean2().optional(),
  authorization_details_types_supported: array(string2()).optional(),
  dpop_signing_alg_values_supported: array(string2()).optional(),
  dpop_bound_access_tokens_required: boolean2().optional()
});
var OAuthMetadataSchema = looseObject({
  issuer: string2(),
  authorization_endpoint: SafeUrlSchema,
  token_endpoint: SafeUrlSchema,
  registration_endpoint: SafeUrlSchema.optional(),
  scopes_supported: array(string2()).optional(),
  response_types_supported: array(string2()),
  response_modes_supported: array(string2()).optional(),
  grant_types_supported: array(string2()).optional(),
  token_endpoint_auth_methods_supported: array(string2()).optional(),
  token_endpoint_auth_signing_alg_values_supported: array(string2()).optional(),
  service_documentation: SafeUrlSchema.optional(),
  revocation_endpoint: SafeUrlSchema.optional(),
  revocation_endpoint_auth_methods_supported: array(string2()).optional(),
  revocation_endpoint_auth_signing_alg_values_supported: array(string2()).optional(),
  introspection_endpoint: string2().optional(),
  introspection_endpoint_auth_methods_supported: array(string2()).optional(),
  introspection_endpoint_auth_signing_alg_values_supported: array(string2()).optional(),
  code_challenge_methods_supported: array(string2()).optional(),
  client_id_metadata_document_supported: boolean2().optional(),
  authorization_response_iss_parameter_supported: boolean2().optional().catch(undefined),
  dpop_signing_alg_values_supported: array(string2()).optional()
});
var OpenIdProviderMetadataSchema = looseObject({
  issuer: string2(),
  authorization_endpoint: SafeUrlSchema,
  token_endpoint: SafeUrlSchema,
  userinfo_endpoint: SafeUrlSchema.optional(),
  jwks_uri: SafeUrlSchema,
  registration_endpoint: SafeUrlSchema.optional(),
  scopes_supported: array(string2()).optional(),
  response_types_supported: array(string2()),
  response_modes_supported: array(string2()).optional(),
  grant_types_supported: array(string2()).optional(),
  acr_values_supported: array(string2()).optional(),
  subject_types_supported: array(string2()),
  id_token_signing_alg_values_supported: array(string2()),
  id_token_encryption_alg_values_supported: array(string2()).optional(),
  id_token_encryption_enc_values_supported: array(string2()).optional(),
  userinfo_signing_alg_values_supported: array(string2()).optional(),
  userinfo_encryption_alg_values_supported: array(string2()).optional(),
  userinfo_encryption_enc_values_supported: array(string2()).optional(),
  request_object_signing_alg_values_supported: array(string2()).optional(),
  request_object_encryption_alg_values_supported: array(string2()).optional(),
  request_object_encryption_enc_values_supported: array(string2()).optional(),
  token_endpoint_auth_methods_supported: array(string2()).optional(),
  token_endpoint_auth_signing_alg_values_supported: array(string2()).optional(),
  display_values_supported: array(string2()).optional(),
  claim_types_supported: array(string2()).optional(),
  claims_supported: array(string2()).optional(),
  service_documentation: string2().optional(),
  claims_locales_supported: array(string2()).optional(),
  ui_locales_supported: array(string2()).optional(),
  claims_parameter_supported: boolean2().optional(),
  request_parameter_supported: boolean2().optional(),
  request_uri_parameter_supported: boolean2().optional(),
  require_request_uri_registration: boolean2().optional(),
  op_policy_uri: SafeUrlSchema.optional(),
  op_tos_uri: SafeUrlSchema.optional(),
  client_id_metadata_document_supported: boolean2().optional(),
  authorization_response_iss_parameter_supported: boolean2().optional().catch(undefined)
});
var OpenIdProviderDiscoveryMetadataSchema = object({
  ...OpenIdProviderMetadataSchema.shape,
  ...OAuthMetadataSchema.pick({ code_challenge_methods_supported: true }).shape
});
var OAuthTokensSchema = object({
  access_token: string2(),
  id_token: string2().optional(),
  token_type: string2(),
  expires_in: number3().optional(),
  scope: string2().optional(),
  refresh_token: string2().optional(),
  issuer: string2().optional().catch(undefined)
}).strip();
var IdJagTokenExchangeResponseSchema = object({
  issued_token_type: literal("urn:ietf:params:oauth:token-type:id-jag"),
  access_token: string2(),
  token_type: string2().optional(),
  expires_in: number2().optional(),
  scope: string2().optional()
}).strip();
var OAuthErrorResponseSchema = object({
  error: string2(),
  error_description: string2().optional(),
  error_uri: string2().optional()
});
var OptionalSafeUrlSchema = SafeUrlSchema.optional().or(literal("").transform(() => {
  return;
}));
var OAuthClientMetadataSchema = object({
  redirect_uris: array(SafeUrlSchema),
  token_endpoint_auth_method: string2().optional(),
  grant_types: array(string2()).optional(),
  response_types: array(string2()).optional(),
  application_type: string2().optional(),
  client_name: string2().optional(),
  client_uri: SafeUrlSchema.optional(),
  logo_uri: OptionalSafeUrlSchema,
  scope: string2().optional(),
  contacts: array(string2()).optional(),
  tos_uri: OptionalSafeUrlSchema,
  policy_uri: string2().optional(),
  jwks_uri: SafeUrlSchema.optional(),
  jwks: any().optional(),
  software_id: string2().optional(),
  software_version: string2().optional(),
  software_statement: string2().optional()
}).strip();
var OAuthClientInformationSchema = object({
  client_id: string2(),
  client_secret: string2().optional(),
  client_id_issued_at: number2().optional(),
  client_secret_expires_at: number2().optional(),
  issuer: string2().optional().catch(undefined)
}).strip();
var OAuthClientInformationFullSchema = OAuthClientMetadataSchema.merge(OAuthClientInformationSchema);
var OAuthClientRegistrationErrorSchema = object({
  error: string2(),
  error_description: string2().optional()
}).strip();
var OAuthTokenRevocationRequestSchema = object({
  token: string2(),
  token_type_hint: string2().optional()
}).strip();

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/src-CeKsbNLO.mjs
var BRANDS = Symbol.for("mcp.sdk.errorBrands");
function stampErrorBrands(instance, ctor) {
  const brands = /* @__PURE__ */ new Set;
  let current = ctor;
  while (typeof current === "function") {
    const brand = current.mcpBrand;
    if (Object.prototype.hasOwnProperty.call(current, "mcpBrand") && typeof brand === "string")
      brands.add(brand);
    current = Object.getPrototypeOf(current);
  }
  if (brands.size === 0)
    return;
  Object.defineProperty(instance, BRANDS, {
    value: brands,
    enumerable: false,
    configurable: true
  });
}
function brandedHasInstance(cls, value) {
  try {
    if (typeof value === "object" && value !== null && Object.prototype.hasOwnProperty.call(cls, "mcpBrand") && typeof cls.mcpBrand === "string" && Object.prototype.hasOwnProperty.call(value, BRANDS)) {
      const carried = value[BRANDS];
      if (carried && typeof carried.has === "function" && carried.has(cls.mcpBrand))
        return true;
    }
  } catch {}
  return Function.prototype[Symbol.hasInstance].call(cls, value);
}
var OAuthErrorCode = /* @__PURE__ */ function(OAuthErrorCode$1) {
  OAuthErrorCode$1["InvalidRequest"] = "invalid_request";
  OAuthErrorCode$1["InvalidClient"] = "invalid_client";
  OAuthErrorCode$1["InvalidGrant"] = "invalid_grant";
  OAuthErrorCode$1["UnauthorizedClient"] = "unauthorized_client";
  OAuthErrorCode$1["UnsupportedGrantType"] = "unsupported_grant_type";
  OAuthErrorCode$1["InvalidScope"] = "invalid_scope";
  OAuthErrorCode$1["AccessDenied"] = "access_denied";
  OAuthErrorCode$1["ServerError"] = "server_error";
  OAuthErrorCode$1["TemporarilyUnavailable"] = "temporarily_unavailable";
  OAuthErrorCode$1["UnsupportedResponseType"] = "unsupported_response_type";
  OAuthErrorCode$1["UnsupportedTokenType"] = "unsupported_token_type";
  OAuthErrorCode$1["InvalidToken"] = "invalid_token";
  OAuthErrorCode$1["MethodNotAllowed"] = "method_not_allowed";
  OAuthErrorCode$1["TooManyRequests"] = "too_many_requests";
  OAuthErrorCode$1["InvalidClientMetadata"] = "invalid_client_metadata";
  OAuthErrorCode$1["InvalidRedirectUri"] = "invalid_redirect_uri";
  OAuthErrorCode$1["InsufficientScope"] = "insufficient_scope";
  OAuthErrorCode$1["InvalidTarget"] = "invalid_target";
  OAuthErrorCode$1["InvalidDpopProof"] = "invalid_dpop_proof";
  OAuthErrorCode$1["UseDpopNonce"] = "use_dpop_nonce";
  return OAuthErrorCode$1;
}({});
var OAuthError = class OAuthError extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.OAuthError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  static isInstance(value) {
    if (typeof this !== "function")
      throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, errorUri) {
    super(message);
    this.code = code;
    this.errorUri = errorUri;
    this.name = "OAuthError";
    stampErrorBrands(this, new.target);
  }
  toResponseObject() {
    const response = {
      error: this.code,
      error_description: this.message
    };
    if (this.errorUri)
      response.error_uri = this.errorUri;
    return response;
  }
  static fromResponse(response) {
    return new OAuthError(response.error, response.error_description ?? response.error, response.error_uri);
  }
};
var SdkErrorCode = /* @__PURE__ */ function(SdkErrorCode$1) {
  SdkErrorCode$1["NotConnected"] = "NOT_CONNECTED";
  SdkErrorCode$1["AlreadyConnected"] = "ALREADY_CONNECTED";
  SdkErrorCode$1["NotInitialized"] = "NOT_INITIALIZED";
  SdkErrorCode$1["CapabilityNotSupported"] = "CAPABILITY_NOT_SUPPORTED";
  SdkErrorCode$1["RequestTimeout"] = "REQUEST_TIMEOUT";
  SdkErrorCode$1["ConnectionClosed"] = "CONNECTION_CLOSED";
  SdkErrorCode$1["SendFailed"] = "SEND_FAILED";
  SdkErrorCode$1["InvalidResult"] = "INVALID_RESULT";
  SdkErrorCode$1["UnsupportedResultType"] = "UNSUPPORTED_RESULT_TYPE";
  SdkErrorCode$1["InputRequiredRoundsExceeded"] = "INPUT_REQUIRED_ROUNDS_EXCEEDED";
  SdkErrorCode$1["ListPaginationExceeded"] = "LIST_PAGINATION_EXCEEDED";
  SdkErrorCode$1["MethodNotSupportedByProtocolVersion"] = "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION";
  SdkErrorCode$1["EraNegotiationFailed"] = "ERA_NEGOTIATION_FAILED";
  SdkErrorCode$1["ClientHttpNotImplemented"] = "CLIENT_HTTP_NOT_IMPLEMENTED";
  SdkErrorCode$1["ClientHttpAuthentication"] = "CLIENT_HTTP_AUTHENTICATION";
  SdkErrorCode$1["ClientHttpForbidden"] = "CLIENT_HTTP_FORBIDDEN";
  SdkErrorCode$1["ClientHttpUnexpectedContent"] = "CLIENT_HTTP_UNEXPECTED_CONTENT";
  SdkErrorCode$1["ClientHttpFailedToOpenStream"] = "CLIENT_HTTP_FAILED_TO_OPEN_STREAM";
  SdkErrorCode$1["ClientHttpFailedToTerminateSession"] = "CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION";
  return SdkErrorCode$1;
}({});
var SdkError = class extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.SdkError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  static isInstance(value) {
    if (typeof this !== "function")
      throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, data, options) {
    super(message, options);
    this.code = code;
    this.data = data;
    this.name = "SdkError";
    stampErrorBrands(this, new.target);
  }
};
var SdkHttpError = class extends SdkError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.SdkHttpError" });
  }
  constructor(code, message, data, options) {
    super(code, message, data, options);
    this.name = "SdkHttpError";
  }
  get status() {
    return this.data.status;
  }
  get statusText() {
    return this.data.statusText;
  }
};
function resourceUrlFromServerUrl(url) {
  const resourceURL = typeof url === "string" ? new URL(url) : new URL(url.href);
  resourceURL.hash = "";
  return resourceURL;
}
function withoutIssuer(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return body;
  const copy = { ...body };
  delete copy.issuer;
  return copy;
}
function checkResourceAllowed({ requestedResource, configuredResource }) {
  const requested = typeof requestedResource === "string" ? new URL(requestedResource) : new URL(requestedResource.href);
  const configured = typeof configuredResource === "string" ? new URL(configuredResource) : new URL(configuredResource.href);
  if (requested.origin !== configured.origin)
    return false;
  if (requested.pathname.length < configured.pathname.length)
    return false;
  const requestedPath = requested.pathname.endsWith("/") ? requested.pathname : requested.pathname + "/";
  const configuredPath = configured.pathname.endsWith("/") ? configured.pathname : configured.pathname + "/";
  return requestedPath.startsWith(configuredPath);
}
var FIRST_MODERN_PROTOCOL_VERSION = "2026-07-28";
var SUPPORTED_MODERN_PROTOCOL_VERSIONS = [FIRST_MODERN_PROTOCOL_VERSION];
function isModernProtocolVersion(version) {
  return version >= FIRST_MODERN_PROTOCOL_VERSION;
}
function legacyProtocolVersions(versions) {
  return versions.filter((version) => !isModernProtocolVersion(version));
}
function modernProtocolVersions(versions) {
  return versions.filter((version) => isModernProtocolVersion(version));
}
function appendTextFallbackForNonObject(result) {
  const sc = result.structuredContent;
  if (sc === undefined)
    return result;
  if (!(typeof sc !== "object" || sc === null || Array.isArray(sc)))
    return result;
  if (result.content?.some((c) => c.type === "text") ?? false)
    return result;
  return {
    ...result,
    content: [...result.content ?? [], {
      type: "text",
      text: JSON.stringify(sc)
    }]
  };
}
var TOOL_RESULT_FOREIGN_FAMILY_KEYS = [
  "task",
  "inputRequests",
  "requestState"
];
function normalizeContentlessToolResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value.content !== undefined || TOOL_RESULT_FOREIGN_FAMILY_KEYS.some((key) => (key in value)))
    return value;
  return {
    ...value,
    content: []
  };
}
function build$1() {
  const JSONValueSchema$1 = lazy(() => union([
    string2(),
    number2(),
    boolean2(),
    _null3(),
    record(string2(), JSONValueSchema$1),
    array(JSONValueSchema$1)
  ]));
  const JSONObjectSchema$1 = record(string2(), JSONValueSchema$1);
  const ProgressTokenSchema$1 = union([string2(), number2().int()]);
  const CursorSchema$1 = string2();
  const TaskMetadataSchema$1 = object({ ttl: number2().optional() });
  const RelatedTaskMetadataSchema$1 = object({ taskId: string2() });
  const RequestMetaSchema$1 = looseObject({
    progressToken: ProgressTokenSchema$1.optional(),
    "io.modelcontextprotocol/related-task": RelatedTaskMetadataSchema$1.optional()
  });
  const BaseRequestParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
  const TaskAugmentedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ task: TaskMetadataSchema$1.optional() });
  const RequestSchema$1 = object({
    method: string2(),
    params: BaseRequestParamsSchema$1.loose().optional()
  });
  const NotificationsParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
  const NotificationSchema$1 = object({
    method: string2(),
    params: NotificationsParamsSchema$1.loose().optional()
  });
  const ResultSchema$1 = looseObject({ _meta: RequestMetaSchema$1.optional() });
  const RequestIdSchema$1 = union([string2(), number2().int()]);
  const EmptyResultSchema$1 = ResultSchema$1.strict();
  const CancelledNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
    requestId: RequestIdSchema$1.optional(),
    reason: string2().optional()
  });
  const CancelledNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/cancelled"),
    params: CancelledNotificationParamsSchema$1
  });
  const IconSchema$1 = object({
    src: string2(),
    mimeType: string2().optional(),
    sizes: array(string2()).optional(),
    theme: _enum(["light", "dark"]).optional()
  });
  const IconsSchema$1 = object({ icons: array(IconSchema$1).optional() });
  const BaseMetadataSchema$1 = object({
    name: string2(),
    title: string2().optional()
  });
  const ImplementationSchema$1 = BaseMetadataSchema$1.extend({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    version: string2(),
    websiteUrl: string2().optional(),
    description: string2().optional()
  });
  const FormElicitationCapabilitySchema = intersection(object({ applyDefaults: boolean2().optional() }), JSONObjectSchema$1);
  const ElicitationCapabilitySchema = preprocess((value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
      return { form: {} };
    return value;
  }, intersection(object({
    form: FormElicitationCapabilitySchema.optional(),
    url: JSONObjectSchema$1.optional()
  }), JSONObjectSchema$1.optional()));
  const ClientTasksCapabilitySchema$1 = looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: looseObject({
      sampling: looseObject({ createMessage: JSONObjectSchema$1.optional() }).optional(),
      elicitation: looseObject({ create: JSONObjectSchema$1.optional() }).optional()
    }).optional()
  });
  const ServerTasksCapabilitySchema$1 = looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: looseObject({ tools: looseObject({ call: JSONObjectSchema$1.optional() }).optional() }).optional()
  });
  const ClientCapabilitiesSchema$1 = object({
    experimental: record(string2(), JSONObjectSchema$1).optional(),
    sampling: object({
      context: JSONObjectSchema$1.optional(),
      tools: JSONObjectSchema$1.optional()
    }).optional(),
    elicitation: ElicitationCapabilitySchema.optional(),
    roots: object({ listChanged: boolean2().optional() }).optional(),
    tasks: ClientTasksCapabilitySchema$1.optional(),
    extensions: record(string2(), JSONObjectSchema$1).optional()
  });
  const InitializeRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
    protocolVersion: string2(),
    capabilities: ClientCapabilitiesSchema$1,
    clientInfo: ImplementationSchema$1
  });
  const InitializeRequestSchema$1 = RequestSchema$1.extend({
    method: literal("initialize"),
    params: InitializeRequestParamsSchema$1
  });
  const ServerCapabilitiesSchema$1 = object({
    experimental: record(string2(), JSONObjectSchema$1).optional(),
    logging: JSONObjectSchema$1.optional(),
    completions: JSONObjectSchema$1.optional(),
    prompts: object({ listChanged: boolean2().optional() }).optional(),
    resources: object({
      subscribe: boolean2().optional(),
      listChanged: boolean2().optional()
    }).optional(),
    tools: object({ listChanged: boolean2().optional() }).optional(),
    tasks: ServerTasksCapabilitySchema$1.optional(),
    extensions: record(string2(), JSONObjectSchema$1).optional()
  });
  const InitializeResultSchema$1 = ResultSchema$1.extend({
    protocolVersion: string2(),
    capabilities: ServerCapabilitiesSchema$1,
    serverInfo: ImplementationSchema$1,
    instructions: string2().optional()
  });
  const InitializedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/initialized"),
    params: NotificationsParamsSchema$1.optional()
  });
  const PingRequestSchema$1 = RequestSchema$1.extend({
    method: literal("ping"),
    params: BaseRequestParamsSchema$1.optional()
  });
  const ProgressSchema$1 = object({
    progress: number2(),
    total: optional(number2()),
    message: optional(string2())
  });
  const ProgressNotificationParamsSchema$1 = object({
    ...NotificationsParamsSchema$1.shape,
    ...ProgressSchema$1.shape,
    progressToken: ProgressTokenSchema$1
  });
  const ProgressNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/progress"),
    params: ProgressNotificationParamsSchema$1
  });
  const PaginatedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ cursor: CursorSchema$1.optional() });
  const PaginatedRequestSchema$1 = RequestSchema$1.extend({ params: PaginatedRequestParamsSchema$1.optional() });
  const PaginatedResultSchema$1 = ResultSchema$1.extend({ nextCursor: CursorSchema$1.optional() });
  const ResourceContentsSchema$1 = object({
    uri: string2(),
    mimeType: optional(string2()),
    _meta: record(string2(), unknown()).optional()
  });
  const TextResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ text: string2() });
  const Base64Schema = string2().refine((val) => {
    try {
      atob(val);
      return true;
    } catch {
      return false;
    }
  }, { message: "Invalid Base64 string" });
  const BlobResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ blob: Base64Schema });
  const RoleSchema$1 = _enum(["user", "assistant"]);
  const AnnotationsSchema$1 = object({
    audience: array(RoleSchema$1).optional(),
    priority: number2().min(0).max(1).optional(),
    lastModified: datetime2({ offset: true }).optional()
  });
  const ResourceSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uri: string2(),
    description: optional(string2()),
    mimeType: optional(string2()),
    size: optional(number2()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: optional(looseObject({}))
  });
  const ResourceTemplateSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uriTemplate: string2(),
    description: optional(string2()),
    mimeType: optional(string2()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: optional(looseObject({}))
  });
  const ListResourcesRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("resources/list") });
  const ListResourcesResultSchema$1 = PaginatedResultSchema$1.extend({ resources: array(ResourceSchema$1) });
  const ListResourceTemplatesRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("resources/templates/list") });
  const ListResourceTemplatesResultSchema$1 = PaginatedResultSchema$1.extend({ resourceTemplates: array(ResourceTemplateSchema$1) });
  const ResourceRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ uri: string2() });
  const ReadResourceRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
  const ReadResourceRequestSchema$1 = RequestSchema$1.extend({
    method: literal("resources/read"),
    params: ReadResourceRequestParamsSchema$1
  });
  const ReadResourceResultSchema$1 = ResultSchema$1.extend({ contents: array(union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1])) });
  const ResourceListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/resources/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const SubscribeRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
  const SubscribeRequestSchema$1 = RequestSchema$1.extend({
    method: literal("resources/subscribe"),
    params: SubscribeRequestParamsSchema$1
  });
  const UnsubscribeRequestParamsSchema$1 = ResourceRequestParamsSchema$1;
  const UnsubscribeRequestSchema$1 = RequestSchema$1.extend({
    method: literal("resources/unsubscribe"),
    params: UnsubscribeRequestParamsSchema$1
  });
  const ResourceUpdatedNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ uri: string2() });
  const ResourceUpdatedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/resources/updated"),
    params: ResourceUpdatedNotificationParamsSchema$1
  });
  const PromptArgumentSchema$1 = object({
    name: string2(),
    description: optional(string2()),
    required: optional(boolean2())
  });
  const PromptSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: optional(string2()),
    arguments: optional(array(PromptArgumentSchema$1)),
    _meta: optional(looseObject({}))
  });
  const ListPromptsRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("prompts/list") });
  const ListPromptsResultSchema$1 = PaginatedResultSchema$1.extend({ prompts: array(PromptSchema$1) });
  const GetPromptRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
    name: string2(),
    arguments: record(string2(), string2()).optional()
  });
  const GetPromptRequestSchema$1 = RequestSchema$1.extend({
    method: literal("prompts/get"),
    params: GetPromptRequestParamsSchema$1
  });
  const TextContentSchema$1 = object({
    type: literal("text"),
    text: string2(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ImageContentSchema$1 = object({
    type: literal("image"),
    data: Base64Schema,
    mimeType: string2(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const AudioContentSchema$1 = object({
    type: literal("audio"),
    data: Base64Schema,
    mimeType: string2(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ToolUseContentSchema$1 = object({
    type: literal("tool_use"),
    name: string2(),
    id: string2(),
    input: record(string2(), unknown()),
    _meta: record(string2(), unknown()).optional()
  });
  const EmbeddedResourceSchema$1 = object({
    type: literal("resource"),
    resource: union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ResourceLinkSchema$1 = ResourceSchema$1.extend({ type: literal("resource_link") });
  const ContentBlockSchema$1 = union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ResourceLinkSchema$1,
    EmbeddedResourceSchema$1
  ]);
  const PromptMessageSchema$1 = object({
    role: RoleSchema$1,
    content: ContentBlockSchema$1
  });
  const GetPromptResultSchema$1 = ResultSchema$1.extend({
    description: string2().optional(),
    messages: array(PromptMessageSchema$1)
  });
  const PromptListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/prompts/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const ToolAnnotationsSchema$1 = object({
    title: string2().optional(),
    readOnlyHint: boolean2().optional(),
    destructiveHint: boolean2().optional(),
    idempotentHint: boolean2().optional(),
    openWorldHint: boolean2().optional()
  });
  const ToolExecutionSchema$1 = object({ taskSupport: _enum([
    "required",
    "optional",
    "forbidden"
  ]).optional() });
  const ToolSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: string2().optional(),
    inputSchema: object({
      type: literal("object"),
      properties: record(string2(), JSONValueSchema$1).optional(),
      required: array(string2()).optional()
    }).catchall(unknown()),
    outputSchema: object({
      type: literal("object"),
      properties: record(string2(), JSONValueSchema$1).optional(),
      required: array(string2()).optional()
    }).catchall(unknown()).optional(),
    annotations: ToolAnnotationsSchema$1.optional(),
    execution: ToolExecutionSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ListToolsRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("tools/list") });
  const ListToolsResultSchema$1 = PaginatedResultSchema$1.extend({ tools: array(ToolSchema$1) });
  const CallToolResultSchema$1 = ResultSchema$1.extend({
    content: array(ContentBlockSchema$1),
    structuredContent: record(string2(), unknown()).optional(),
    isError: boolean2().optional()
  });
  const CallToolRequestParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    name: string2(),
    arguments: record(string2(), unknown()).optional()
  });
  const CallToolRequestSchema$1 = RequestSchema$1.extend({
    method: literal("tools/call"),
    params: CallToolRequestParamsSchema$1
  });
  const ToolListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/tools/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const LoggingLevelSchema$1 = _enum([
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency"
  ]);
  const SetLevelRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ level: LoggingLevelSchema$1 });
  const SetLevelRequestSchema$1 = RequestSchema$1.extend({
    method: literal("logging/setLevel"),
    params: SetLevelRequestParamsSchema$1
  });
  const LoggingMessageNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
    level: LoggingLevelSchema$1,
    logger: string2().optional(),
    data: unknown()
  });
  const LoggingMessageNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/message"),
    params: LoggingMessageNotificationParamsSchema$1
  });
  const ModelHintSchema$1 = object({ name: string2().optional() });
  const ModelPreferencesSchema$1 = object({
    hints: array(ModelHintSchema$1).optional(),
    costPriority: number2().min(0).max(1).optional(),
    speedPriority: number2().min(0).max(1).optional(),
    intelligencePriority: number2().min(0).max(1).optional()
  });
  const ToolChoiceSchema$1 = object({ mode: _enum([
    "auto",
    "required",
    "none"
  ]).optional() });
  const ToolResultContentSchema$1 = object({
    type: literal("tool_result"),
    toolUseId: string2().describe("The unique identifier for the corresponding tool call."),
    content: array(ContentBlockSchema$1),
    structuredContent: object({}).loose().optional(),
    isError: boolean2().optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const SamplingContentSchema$1 = discriminatedUnion("type", [
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1
  ]);
  const SamplingMessageContentBlockSchema$1 = discriminatedUnion("type", [
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ToolUseContentSchema$1,
    ToolResultContentSchema$1
  ]);
  const SamplingMessageSchema$1 = object({
    role: RoleSchema$1,
    content: union([SamplingMessageContentBlockSchema$1, array(SamplingMessageContentBlockSchema$1)]),
    _meta: record(string2(), unknown()).optional()
  });
  const CreateMessageRequestParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    messages: array(SamplingMessageSchema$1),
    modelPreferences: ModelPreferencesSchema$1.optional(),
    systemPrompt: string2().optional(),
    includeContext: _enum([
      "none",
      "thisServer",
      "allServers"
    ]).optional(),
    temperature: number2().optional(),
    maxTokens: number2().int(),
    stopSequences: array(string2()).optional(),
    metadata: JSONObjectSchema$1.optional(),
    tools: array(ToolSchema$1).optional(),
    toolChoice: ToolChoiceSchema$1.optional()
  });
  const CreateMessageRequestSchema$1 = RequestSchema$1.extend({
    method: literal("sampling/createMessage"),
    params: CreateMessageRequestParamsSchema$1
  });
  const CreateMessageResultSchema$1 = ResultSchema$1.extend({
    model: string2(),
    stopReason: optional(_enum([
      "endTurn",
      "stopSequence",
      "maxTokens"
    ]).or(string2())),
    role: RoleSchema$1,
    content: SamplingContentSchema$1
  });
  const CreateMessageResultWithToolsSchema$1 = ResultSchema$1.extend({
    model: string2(),
    stopReason: optional(_enum([
      "endTurn",
      "stopSequence",
      "maxTokens",
      "toolUse"
    ]).or(string2())),
    role: RoleSchema$1,
    content: union([SamplingMessageContentBlockSchema$1, array(SamplingMessageContentBlockSchema$1)])
  });
  const BooleanSchemaSchema$1 = object({
    type: literal("boolean"),
    title: string2().optional(),
    description: string2().optional(),
    default: boolean2().optional()
  });
  const StringSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    minLength: number2().optional(),
    maxLength: number2().optional(),
    format: _enum([
      "email",
      "uri",
      "date",
      "date-time"
    ]).optional(),
    default: string2().optional()
  });
  const NumberSchemaSchema$1 = object({
    type: _enum(["number", "integer"]),
    title: string2().optional(),
    description: string2().optional(),
    minimum: number2().optional(),
    maximum: number2().optional(),
    default: number2().optional()
  });
  const UntitledSingleSelectEnumSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    enum: array(string2()),
    default: string2().optional()
  });
  const TitledSingleSelectEnumSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    oneOf: array(object({
      const: string2(),
      title: string2()
    })),
    default: string2().optional()
  });
  const LegacyTitledEnumSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    enum: array(string2()),
    enumNames: array(string2()).optional(),
    default: string2().optional()
  });
  const SingleSelectEnumSchemaSchema$1 = union([UntitledSingleSelectEnumSchemaSchema$1, TitledSingleSelectEnumSchemaSchema$1]);
  const UntitledMultiSelectEnumSchemaSchema$1 = object({
    type: literal("array"),
    title: string2().optional(),
    description: string2().optional(),
    minItems: number2().optional(),
    maxItems: number2().optional(),
    items: object({
      type: literal("string"),
      enum: array(string2())
    }),
    default: array(string2()).optional()
  });
  const TitledMultiSelectEnumSchemaSchema$1 = object({
    type: literal("array"),
    title: string2().optional(),
    description: string2().optional(),
    minItems: number2().optional(),
    maxItems: number2().optional(),
    items: object({ anyOf: array(object({
      const: string2(),
      title: string2()
    })) }),
    default: array(string2()).optional()
  });
  const MultiSelectEnumSchemaSchema$1 = union([UntitledMultiSelectEnumSchemaSchema$1, TitledMultiSelectEnumSchemaSchema$1]);
  const EnumSchemaSchema$1 = union([
    LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema$1
  ]);
  const PrimitiveSchemaDefinitionSchema$1 = union([
    EnumSchemaSchema$1,
    BooleanSchemaSchema$1,
    StringSchemaSchema$1,
    NumberSchemaSchema$1
  ]);
  const ElicitRequestFormParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    mode: literal("form").optional(),
    message: string2(),
    requestedSchema: object({
      type: literal("object"),
      properties: record(string2(), PrimitiveSchemaDefinitionSchema$1),
      required: array(string2()).optional()
    }).catchall(unknown())
  });
  const ElicitRequestURLParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    mode: literal("url"),
    message: string2(),
    elicitationId: string2(),
    url: string2().url()
  });
  const ElicitRequestParamsSchema$1 = union([ElicitRequestFormParamsSchema$1, ElicitRequestURLParamsSchema$1]);
  const ElicitRequestSchema$1 = RequestSchema$1.extend({
    method: literal("elicitation/create"),
    params: ElicitRequestParamsSchema$1
  });
  const ElicitationCompleteNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ elicitationId: string2() });
  const ElicitationCompleteNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/elicitation/complete"),
    params: ElicitationCompleteNotificationParamsSchema$1
  });
  const ElicitResultSchema$1 = ResultSchema$1.extend({
    action: _enum([
      "accept",
      "decline",
      "cancel"
    ]),
    content: preprocess((val) => val === null ? undefined : val, record(string2(), union([
      string2(),
      number2(),
      boolean2(),
      array(string2())
    ])).optional())
  });
  const ResourceTemplateReferenceSchema$1 = object({
    type: literal("ref/resource"),
    uri: string2()
  });
  const PromptReferenceSchema$1 = object({
    type: literal("ref/prompt"),
    name: string2()
  });
  const CompleteRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({
    ref: union([PromptReferenceSchema$1, ResourceTemplateReferenceSchema$1]),
    argument: object({
      name: string2(),
      value: string2()
    }),
    context: object({ arguments: record(string2(), string2()).optional() }).optional()
  });
  const CompleteRequestSchema$1 = RequestSchema$1.extend({
    method: literal("completion/complete"),
    params: CompleteRequestParamsSchema$1
  });
  const CompleteResultSchema$1 = ResultSchema$1.extend({ completion: looseObject({
    values: array(string2()).max(100),
    total: optional(number2().int()),
    hasMore: optional(boolean2())
  }) });
  const RootSchema$1 = object({
    uri: string2().startsWith("file://"),
    name: string2().optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ListRootsRequestSchema$1 = RequestSchema$1.extend({
    method: literal("roots/list"),
    params: BaseRequestParamsSchema$1.optional()
  });
  const ListRootsResultSchema$1 = ResultSchema$1.extend({ roots: array(RootSchema$1) });
  const RootsListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/roots/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const TaskCreationParamsSchema$1 = looseObject({
    ttl: number2().optional(),
    pollInterval: number2().optional()
  });
  const TaskStatusSchema$1 = _enum([
    "working",
    "input_required",
    "completed",
    "failed",
    "cancelled"
  ]);
  const TaskSchema$1 = object({
    taskId: string2(),
    status: TaskStatusSchema$1,
    ttl: union([number2(), _null3()]),
    createdAt: string2(),
    lastUpdatedAt: string2(),
    pollInterval: optional(number2()),
    statusMessage: optional(string2())
  });
  const CreateTaskResultSchema$1 = ResultSchema$1.extend({ task: TaskSchema$1 });
  const TaskStatusNotificationParamsSchema$1 = NotificationsParamsSchema$1.merge(TaskSchema$1);
  const TaskStatusNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/tasks/status"),
    params: TaskStatusNotificationParamsSchema$1
  });
  const GetTaskRequestSchema$1 = RequestSchema$1.extend({
    method: literal("tasks/get"),
    params: BaseRequestParamsSchema$1.extend({ taskId: string2() })
  });
  const GetTaskResultSchema$1 = ResultSchema$1.merge(TaskSchema$1);
  const GetTaskPayloadRequestSchema$1 = RequestSchema$1.extend({
    method: literal("tasks/result"),
    params: BaseRequestParamsSchema$1.extend({ taskId: string2() })
  });
  const GetTaskPayloadResultSchema$1 = ResultSchema$1.loose();
  const ListTasksRequestSchema$1 = PaginatedRequestSchema$1.extend({ method: literal("tasks/list") });
  const ListTasksResultSchema$1 = PaginatedResultSchema$1.extend({ tasks: array(TaskSchema$1) });
  const CancelTaskRequestSchema$1 = RequestSchema$1.extend({
    method: literal("tasks/cancel"),
    params: BaseRequestParamsSchema$1.extend({ taskId: string2() })
  });
  return {
    JSONValueSchema: JSONValueSchema$1,
    JSONObjectSchema: JSONObjectSchema$1,
    ProgressTokenSchema: ProgressTokenSchema$1,
    CursorSchema: CursorSchema$1,
    TaskMetadataSchema: TaskMetadataSchema$1,
    RelatedTaskMetadataSchema: RelatedTaskMetadataSchema$1,
    RequestMetaSchema: RequestMetaSchema$1,
    BaseRequestParamsSchema: BaseRequestParamsSchema$1,
    TaskAugmentedRequestParamsSchema: TaskAugmentedRequestParamsSchema$1,
    RequestSchema: RequestSchema$1,
    NotificationsParamsSchema: NotificationsParamsSchema$1,
    NotificationSchema: NotificationSchema$1,
    ResultSchema: ResultSchema$1,
    RequestIdSchema: RequestIdSchema$1,
    EmptyResultSchema: EmptyResultSchema$1,
    CancelledNotificationParamsSchema: CancelledNotificationParamsSchema$1,
    CancelledNotificationSchema: CancelledNotificationSchema$1,
    IconSchema: IconSchema$1,
    IconsSchema: IconsSchema$1,
    BaseMetadataSchema: BaseMetadataSchema$1,
    ImplementationSchema: ImplementationSchema$1,
    ClientTasksCapabilitySchema: ClientTasksCapabilitySchema$1,
    ServerTasksCapabilitySchema: ServerTasksCapabilitySchema$1,
    ClientCapabilitiesSchema: ClientCapabilitiesSchema$1,
    InitializeRequestParamsSchema: InitializeRequestParamsSchema$1,
    InitializeRequestSchema: InitializeRequestSchema$1,
    ServerCapabilitiesSchema: ServerCapabilitiesSchema$1,
    InitializeResultSchema: InitializeResultSchema$1,
    InitializedNotificationSchema: InitializedNotificationSchema$1,
    PingRequestSchema: PingRequestSchema$1,
    ProgressSchema: ProgressSchema$1,
    ProgressNotificationParamsSchema: ProgressNotificationParamsSchema$1,
    ProgressNotificationSchema: ProgressNotificationSchema$1,
    PaginatedRequestParamsSchema: PaginatedRequestParamsSchema$1,
    PaginatedRequestSchema: PaginatedRequestSchema$1,
    PaginatedResultSchema: PaginatedResultSchema$1,
    ResourceContentsSchema: ResourceContentsSchema$1,
    TextResourceContentsSchema: TextResourceContentsSchema$1,
    BlobResourceContentsSchema: BlobResourceContentsSchema$1,
    RoleSchema: RoleSchema$1,
    AnnotationsSchema: AnnotationsSchema$1,
    ResourceSchema: ResourceSchema$1,
    ResourceTemplateSchema: ResourceTemplateSchema$1,
    ListResourcesRequestSchema: ListResourcesRequestSchema$1,
    ListResourcesResultSchema: ListResourcesResultSchema$1,
    ListResourceTemplatesRequestSchema: ListResourceTemplatesRequestSchema$1,
    ListResourceTemplatesResultSchema: ListResourceTemplatesResultSchema$1,
    ResourceRequestParamsSchema: ResourceRequestParamsSchema$1,
    ReadResourceRequestParamsSchema: ReadResourceRequestParamsSchema$1,
    ReadResourceRequestSchema: ReadResourceRequestSchema$1,
    ReadResourceResultSchema: ReadResourceResultSchema$1,
    ResourceListChangedNotificationSchema: ResourceListChangedNotificationSchema$1,
    SubscribeRequestParamsSchema: SubscribeRequestParamsSchema$1,
    SubscribeRequestSchema: SubscribeRequestSchema$1,
    UnsubscribeRequestParamsSchema: UnsubscribeRequestParamsSchema$1,
    UnsubscribeRequestSchema: UnsubscribeRequestSchema$1,
    ResourceUpdatedNotificationParamsSchema: ResourceUpdatedNotificationParamsSchema$1,
    ResourceUpdatedNotificationSchema: ResourceUpdatedNotificationSchema$1,
    PromptArgumentSchema: PromptArgumentSchema$1,
    PromptSchema: PromptSchema$1,
    ListPromptsRequestSchema: ListPromptsRequestSchema$1,
    ListPromptsResultSchema: ListPromptsResultSchema$1,
    GetPromptRequestParamsSchema: GetPromptRequestParamsSchema$1,
    GetPromptRequestSchema: GetPromptRequestSchema$1,
    TextContentSchema: TextContentSchema$1,
    ImageContentSchema: ImageContentSchema$1,
    AudioContentSchema: AudioContentSchema$1,
    ToolUseContentSchema: ToolUseContentSchema$1,
    EmbeddedResourceSchema: EmbeddedResourceSchema$1,
    ResourceLinkSchema: ResourceLinkSchema$1,
    ContentBlockSchema: ContentBlockSchema$1,
    PromptMessageSchema: PromptMessageSchema$1,
    GetPromptResultSchema: GetPromptResultSchema$1,
    PromptListChangedNotificationSchema: PromptListChangedNotificationSchema$1,
    ToolAnnotationsSchema: ToolAnnotationsSchema$1,
    ToolExecutionSchema: ToolExecutionSchema$1,
    ToolSchema: ToolSchema$1,
    ListToolsRequestSchema: ListToolsRequestSchema$1,
    ListToolsResultSchema: ListToolsResultSchema$1,
    CallToolResultSchema: CallToolResultSchema$1,
    CallToolRequestParamsSchema: CallToolRequestParamsSchema$1,
    CallToolRequestSchema: CallToolRequestSchema$1,
    ToolListChangedNotificationSchema: ToolListChangedNotificationSchema$1,
    LoggingLevelSchema: LoggingLevelSchema$1,
    SetLevelRequestParamsSchema: SetLevelRequestParamsSchema$1,
    SetLevelRequestSchema: SetLevelRequestSchema$1,
    LoggingMessageNotificationParamsSchema: LoggingMessageNotificationParamsSchema$1,
    LoggingMessageNotificationSchema: LoggingMessageNotificationSchema$1,
    ModelHintSchema: ModelHintSchema$1,
    ModelPreferencesSchema: ModelPreferencesSchema$1,
    ToolChoiceSchema: ToolChoiceSchema$1,
    ToolResultContentSchema: ToolResultContentSchema$1,
    SamplingContentSchema: SamplingContentSchema$1,
    SamplingMessageContentBlockSchema: SamplingMessageContentBlockSchema$1,
    SamplingMessageSchema: SamplingMessageSchema$1,
    CreateMessageRequestParamsSchema: CreateMessageRequestParamsSchema$1,
    CreateMessageRequestSchema: CreateMessageRequestSchema$1,
    CreateMessageResultSchema: CreateMessageResultSchema$1,
    CreateMessageResultWithToolsSchema: CreateMessageResultWithToolsSchema$1,
    BooleanSchemaSchema: BooleanSchemaSchema$1,
    StringSchemaSchema: StringSchemaSchema$1,
    NumberSchemaSchema: NumberSchemaSchema$1,
    UntitledSingleSelectEnumSchemaSchema: UntitledSingleSelectEnumSchemaSchema$1,
    TitledSingleSelectEnumSchemaSchema: TitledSingleSelectEnumSchemaSchema$1,
    LegacyTitledEnumSchemaSchema: LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema: SingleSelectEnumSchemaSchema$1,
    UntitledMultiSelectEnumSchemaSchema: UntitledMultiSelectEnumSchemaSchema$1,
    TitledMultiSelectEnumSchemaSchema: TitledMultiSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema: MultiSelectEnumSchemaSchema$1,
    EnumSchemaSchema: EnumSchemaSchema$1,
    PrimitiveSchemaDefinitionSchema: PrimitiveSchemaDefinitionSchema$1,
    ElicitRequestFormParamsSchema: ElicitRequestFormParamsSchema$1,
    ElicitRequestURLParamsSchema: ElicitRequestURLParamsSchema$1,
    ElicitRequestParamsSchema: ElicitRequestParamsSchema$1,
    ElicitRequestSchema: ElicitRequestSchema$1,
    ElicitationCompleteNotificationParamsSchema: ElicitationCompleteNotificationParamsSchema$1,
    ElicitationCompleteNotificationSchema: ElicitationCompleteNotificationSchema$1,
    ElicitResultSchema: ElicitResultSchema$1,
    ResourceTemplateReferenceSchema: ResourceTemplateReferenceSchema$1,
    PromptReferenceSchema: PromptReferenceSchema$1,
    CompleteRequestParamsSchema: CompleteRequestParamsSchema$1,
    CompleteRequestSchema: CompleteRequestSchema$1,
    CompleteResultSchema: CompleteResultSchema$1,
    RootSchema: RootSchema$1,
    ListRootsRequestSchema: ListRootsRequestSchema$1,
    ListRootsResultSchema: ListRootsResultSchema$1,
    RootsListChangedNotificationSchema: RootsListChangedNotificationSchema$1,
    TaskCreationParamsSchema: TaskCreationParamsSchema$1,
    TaskStatusSchema: TaskStatusSchema$1,
    TaskSchema: TaskSchema$1,
    CreateTaskResultSchema: CreateTaskResultSchema$1,
    TaskStatusNotificationParamsSchema: TaskStatusNotificationParamsSchema$1,
    TaskStatusNotificationSchema: TaskStatusNotificationSchema$1,
    GetTaskRequestSchema: GetTaskRequestSchema$1,
    GetTaskResultSchema: GetTaskResultSchema$1,
    GetTaskPayloadRequestSchema: GetTaskPayloadRequestSchema$1,
    GetTaskPayloadResultSchema: GetTaskPayloadResultSchema$1,
    ListTasksRequestSchema: ListTasksRequestSchema$1,
    ListTasksResultSchema: ListTasksResultSchema$1,
    CancelTaskRequestSchema: CancelTaskRequestSchema$1,
    CancelTaskResultSchema: ResultSchema$1.merge(TaskSchema$1),
    ClientRequestSchema: union([
      PingRequestSchema$1,
      InitializeRequestSchema$1,
      CompleteRequestSchema$1,
      SetLevelRequestSchema$1,
      GetPromptRequestSchema$1,
      ListPromptsRequestSchema$1,
      ListResourcesRequestSchema$1,
      ListResourceTemplatesRequestSchema$1,
      ReadResourceRequestSchema$1,
      SubscribeRequestSchema$1,
      UnsubscribeRequestSchema$1,
      CallToolRequestSchema$1,
      ListToolsRequestSchema$1,
      GetTaskRequestSchema$1,
      GetTaskPayloadRequestSchema$1,
      ListTasksRequestSchema$1,
      CancelTaskRequestSchema$1
    ]),
    ClientNotificationSchema: union([
      CancelledNotificationSchema$1,
      ProgressNotificationSchema$1,
      InitializedNotificationSchema$1,
      RootsListChangedNotificationSchema$1,
      TaskStatusNotificationSchema$1
    ]),
    ClientResultSchema: union([
      EmptyResultSchema$1,
      CreateMessageResultSchema$1,
      CreateMessageResultWithToolsSchema$1,
      ElicitResultSchema$1,
      ListRootsResultSchema$1,
      GetTaskResultSchema$1,
      ListTasksResultSchema$1,
      CreateTaskResultSchema$1
    ]),
    ServerRequestSchema: union([
      PingRequestSchema$1,
      CreateMessageRequestSchema$1,
      ElicitRequestSchema$1,
      ListRootsRequestSchema$1,
      GetTaskRequestSchema$1,
      GetTaskPayloadRequestSchema$1,
      ListTasksRequestSchema$1,
      CancelTaskRequestSchema$1
    ]),
    ServerNotificationSchema: union([
      CancelledNotificationSchema$1,
      ProgressNotificationSchema$1,
      LoggingMessageNotificationSchema$1,
      ResourceUpdatedNotificationSchema$1,
      ResourceListChangedNotificationSchema$1,
      ToolListChangedNotificationSchema$1,
      PromptListChangedNotificationSchema$1,
      TaskStatusNotificationSchema$1,
      ElicitationCompleteNotificationSchema$1
    ]),
    ServerResultSchema: union([
      EmptyResultSchema$1,
      InitializeResultSchema$1,
      CompleteResultSchema$1,
      GetPromptResultSchema$1,
      ListPromptsResultSchema$1,
      ListResourcesResultSchema$1,
      ListResourceTemplatesResultSchema$1,
      ReadResourceResultSchema$1,
      CallToolResultSchema$1,
      ListToolsResultSchema$1,
      GetTaskResultSchema$1,
      ListTasksResultSchema$1,
      CreateTaskResultSchema$1
    ]),
    CallToolResultWireSchema: unknown().superRefine((value, ctx) => {
      if (typeof value !== "object" || value === null || Array.isArray(value) || value.content !== undefined)
        return;
      for (const key of TOOL_RESULT_FOREIGN_FAMILY_KEYS)
        if (key in value) {
          ctx.addIssue({
            code: "custom",
            message: `content is required when the body carries '${key}' — another result family cannot default into an empty tools/call success`
          });
          return;
        }
    }).transform(normalizeContentlessToolResult).pipe(CallToolResultSchema$1)
  };
}
var memo$1;
function buildSchemas2025() {
  return memo$1 ??= build$1();
}
function isNonObjectJsonSchemaRoot(json) {
  return json["type"] !== "object";
}
var REF_REWRITE_DATA_POSITION_KEYS = new Set([
  "const",
  "enum",
  "default",
  "examples"
]);
var REF_REWRITE_NAME_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependencies"
]);
function establishesNewBase(id) {
  return id !== undefined && !(typeof id === "string" && id.startsWith("#"));
}
function wrapOutputSchemaForLegacy(natural) {
  const $schema = typeof natural["$schema"] === "string" ? natural["$schema"] : undefined;
  if (establishesNewBase(natural["$id"]))
    return {
      ...$schema !== undefined && { $schema },
      type: "object",
      properties: { result: natural },
      required: ["result"]
    };
  const convertRecursiveRefs = declares2019Dialect(natural["$schema"]) && natural["$recursiveAnchor"] !== true;
  const rewriteRefs = (node, parentIsNameMap) => {
    if (Array.isArray(node))
      return node.map((item) => rewriteRefs(item, false));
    if (node === null || typeof node !== "object")
      return node;
    if (!parentIsNameMap && establishesNewBase(node["$id"]))
      return node;
    const out = {};
    let convertedRecursion = false;
    for (const [k, v] of Object.entries(node))
      if (parentIsNameMap)
        out[k] = rewriteRefs(v, false);
      else if ((k === "$ref" || k === "$dynamicRef") && typeof v === "string")
        out[k] = v === "#" ? "#/properties/result" : v.startsWith("#/") ? `#/properties/result${v.slice(1)}` : v;
      else if (k === "$recursiveRef" && v === "#" && convertRecursiveRefs)
        convertedRecursion = true;
      else if (REF_REWRITE_DATA_POSITION_KEYS.has(k))
        out[k] = v;
      else if (REF_REWRITE_NAME_MAP_KEYS.has(k))
        out[k] = rewriteRefs(v, true);
      else
        out[k] = rewriteRefs(v, false);
    if (convertedRecursion)
      if ("$ref" in out)
        out["allOf"] = [...Array.isArray(out["allOf"]) ? out["allOf"] : [], { $ref: "#/properties/result" }];
      else
        out["$ref"] = "#/properties/result";
    return out;
  };
  return {
    ...$schema !== undefined && { $schema },
    type: "object",
    properties: { result: rewriteRefs(natural, false) },
    required: ["result"]
  };
}
var requestMethodKeys$1 = {
  ping: null,
  initialize: null,
  "completion/complete": null,
  "logging/setLevel": null,
  "prompts/get": null,
  "prompts/list": null,
  "resources/list": null,
  "resources/templates/list": null,
  "resources/read": null,
  "resources/subscribe": null,
  "resources/unsubscribe": null,
  "tools/call": null,
  "tools/list": null,
  "tasks/get": null,
  "tasks/result": null,
  "tasks/list": null,
  "tasks/cancel": null,
  "sampling/createMessage": null,
  "elicitation/create": null,
  "roots/list": null
};
var notificationMethodKeys$1 = {
  "notifications/cancelled": null,
  "notifications/progress": null,
  "notifications/initialized": null,
  "notifications/roots/list_changed": null,
  "notifications/tasks/status": null,
  "notifications/message": null,
  "notifications/resources/updated": null,
  "notifications/resources/list_changed": null,
  "notifications/tools/list_changed": null,
  "notifications/prompts/list_changed": null,
  "notifications/elicitation/complete": null
};
var resultMethodKeys = {
  ping: null,
  initialize: null,
  "completion/complete": null,
  "logging/setLevel": null,
  "prompts/get": null,
  "prompts/list": null,
  "resources/list": null,
  "resources/templates/list": null,
  "resources/read": null,
  "resources/subscribe": null,
  "resources/unsubscribe": null,
  "tools/call": null,
  "tools/list": null,
  "sampling/createMessage": null,
  "elicitation/create": null,
  "roots/list": null
};
var maps$1;
function registryMaps() {
  if (maps$1)
    return maps$1;
  const s = buildSchemas2025();
  maps$1 = {
    requestSchemas: {
      ping: s.PingRequestSchema,
      initialize: s.InitializeRequestSchema,
      "completion/complete": s.CompleteRequestSchema,
      "logging/setLevel": s.SetLevelRequestSchema,
      "prompts/get": s.GetPromptRequestSchema,
      "prompts/list": s.ListPromptsRequestSchema,
      "resources/list": s.ListResourcesRequestSchema,
      "resources/templates/list": s.ListResourceTemplatesRequestSchema,
      "resources/read": s.ReadResourceRequestSchema,
      "resources/subscribe": s.SubscribeRequestSchema,
      "resources/unsubscribe": s.UnsubscribeRequestSchema,
      "tools/call": s.CallToolRequestSchema,
      "tools/list": s.ListToolsRequestSchema,
      "tasks/get": s.GetTaskRequestSchema,
      "tasks/result": s.GetTaskPayloadRequestSchema,
      "tasks/list": s.ListTasksRequestSchema,
      "tasks/cancel": s.CancelTaskRequestSchema,
      "sampling/createMessage": s.CreateMessageRequestSchema,
      "elicitation/create": s.ElicitRequestSchema,
      "roots/list": s.ListRootsRequestSchema
    },
    notificationSchemas: {
      "notifications/cancelled": s.CancelledNotificationSchema,
      "notifications/progress": s.ProgressNotificationSchema,
      "notifications/initialized": s.InitializedNotificationSchema,
      "notifications/roots/list_changed": s.RootsListChangedNotificationSchema,
      "notifications/tasks/status": s.TaskStatusNotificationSchema,
      "notifications/message": s.LoggingMessageNotificationSchema,
      "notifications/resources/updated": s.ResourceUpdatedNotificationSchema,
      "notifications/resources/list_changed": s.ResourceListChangedNotificationSchema,
      "notifications/tools/list_changed": s.ToolListChangedNotificationSchema,
      "notifications/prompts/list_changed": s.PromptListChangedNotificationSchema,
      "notifications/elicitation/complete": s.ElicitationCompleteNotificationSchema
    },
    resultSchemas: {
      ping: s.EmptyResultSchema,
      initialize: s.InitializeResultSchema,
      "completion/complete": s.CompleteResultSchema,
      "logging/setLevel": s.EmptyResultSchema,
      "prompts/get": s.GetPromptResultSchema,
      "prompts/list": s.ListPromptsResultSchema,
      "resources/list": s.ListResourcesResultSchema,
      "resources/templates/list": s.ListResourceTemplatesResultSchema,
      "resources/read": s.ReadResourceResultSchema,
      "resources/subscribe": s.EmptyResultSchema,
      "resources/unsubscribe": s.EmptyResultSchema,
      "tools/call": s.CallToolResultWireSchema,
      "tools/list": s.ListToolsResultSchema,
      "sampling/createMessage": s.CreateMessageResultWithToolsSchema,
      "elicitation/create": s.ElicitResultSchema,
      "roots/list": s.ListRootsResultSchema
    }
  };
  return maps$1;
}
function hasRequestMethod2025(method) {
  return Object.prototype.hasOwnProperty.call(requestMethodKeys$1, method);
}
function hasNotificationMethod2025(method) {
  return Object.prototype.hasOwnProperty.call(notificationMethodKeys$1, method);
}
function hasResultMethod(method) {
  return Object.prototype.hasOwnProperty.call(resultMethodKeys, method);
}
function getResultSchema(method) {
  return hasResultMethod(method) ? registryMaps().resultSchemas[method] : undefined;
}
function getRequestSchema(method) {
  return hasRequestMethod2025(method) ? registryMaps().requestSchemas[method] : undefined;
}
function getNotificationSchema(method) {
  return hasNotificationMethod2025(method) ? registryMaps().notificationSchemas[method] : undefined;
}
var rev2025RequestMethods = Object.keys(requestMethodKeys$1);
var rev2025NotificationMethods = Object.keys(notificationMethodKeys$1);
function isPlainObject$5(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function triState$1(schema, raw) {
  if (schema === undefined)
    return {
      ok: false,
      reason: "not-in-era"
    };
  const parsed = schema.safeParse(raw);
  return parsed.success ? {
    ok: true,
    value: parsed.data
  } : {
    ok: false,
    reason: "invalid",
    message: String(parsed.error)
  };
}
var NOT_IN_ERA$1 = {
  ok: false,
  reason: "not-in-era"
};
function toolNeedsLegacyWrap(t) {
  return isPlainObject$5(t) && isPlainObject$5(t["outputSchema"]) && isNonObjectJsonSchemaRoot(t["outputSchema"]);
}
function toNeutralResult(value) {
  return value;
}
var rev2025Codec = {
  era: "2025-11-25",
  hasRequestMethod: hasRequestMethod2025,
  hasNotificationMethod: hasNotificationMethod2025,
  validateRequest: (method, raw) => triState$1(getRequestSchema(method), raw),
  validateResult: (method, raw) => triState$1(getResultSchema(method), raw),
  validateNotification: (method, raw) => triState$1(getNotificationSchema(method), raw),
  hasInputRequestMethod: () => false,
  validateInputRequest: () => NOT_IN_ERA$1,
  validateInputResponse: () => NOT_IN_ERA$1,
  samplingResultVariant: (hasTools, raw) => {
    const s = buildSchemas2025();
    return triState$1(hasTools ? s.CreateMessageResultWithToolsSchema : s.CreateMessageResultSchema, raw);
  },
  outboundEnvelope: (_material) => {
    return;
  },
  validateEnvelopeMeta: (_meta) => [],
  projectCallToolResult(result, advertisedOutputSchema) {
    const withText = appendTextFallbackForNonObject(result);
    const sc = withText.structuredContent;
    if (sc === undefined)
      return withText;
    const valueIsNonObject = typeof sc !== "object" || sc === null || Array.isArray(sc);
    const schemaWrapped = advertisedOutputSchema !== undefined && isNonObjectJsonSchemaRoot(advertisedOutputSchema);
    if (!valueIsNonObject && !schemaWrapped)
      return withText;
    return {
      ...withText,
      structuredContent: { result: sc }
    };
  },
  decodeResult(_method, raw) {
    if (isPlainObject$5(raw) && "resultType" in raw) {
      const stripped = { ...raw };
      delete stripped["resultType"];
      return {
        kind: "complete",
        result: toNeutralResult(stripped)
      };
    }
    return {
      kind: "complete",
      result: toNeutralResult(raw)
    };
  },
  encodeResult(method, result) {
    if (method !== "tools/list")
      return result;
    const tools = result.tools;
    if (!Array.isArray(tools) || !tools.some((t) => toolNeedsLegacyWrap(t)))
      return result;
    return {
      ...result,
      tools: tools.map((t) => toolNeedsLegacyWrap(t) ? {
        ...t,
        outputSchema: wrapOutputSchemaForLegacy(t.outputSchema)
      } : t)
    };
  },
  encodeErrorCode: (code) => code === -32002 ? -32602 : code,
  checkInboundEnvelope: (_material) => {
    return;
  }
};
function build() {
  const JSONValueSchema$1 = lazy(() => union([
    string2(),
    number2(),
    boolean2(),
    _null3(),
    record(string2(), JSONValueSchema$1),
    array(JSONValueSchema$1)
  ]));
  const JSONObjectSchema$1 = record(string2(), JSONValueSchema$1);
  const ProgressTokenSchema$1 = union([string2(), number2().int()]);
  const CursorSchema$1 = string2();
  const RequestIdSchema$1 = union([string2(), number2().int()]);
  const RoleSchema$1 = _enum(["user", "assistant"]);
  const LoggingLevelSchema$1 = _enum([
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency"
  ]);
  const Base64Schema = string2().refine((val) => {
    try {
      atob(val);
      return true;
    } catch {
      return false;
    }
  }, { message: "Invalid Base64 string" });
  const TaskMetadataSchema$1 = object({ ttl: number2().optional() });
  const RelatedTaskMetadataSchema$1 = object({ taskId: string2() });
  const RequestMetaSchema$1 = looseObject({
    progressToken: ProgressTokenSchema$1.optional(),
    "io.modelcontextprotocol/related-task": RelatedTaskMetadataSchema$1.optional()
  });
  const BaseRequestParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
  const TaskAugmentedRequestParamsSchema$1 = BaseRequestParamsSchema$1.extend({ task: TaskMetadataSchema$1.optional() });
  const NotificationsParamsSchema$1 = object({ _meta: RequestMetaSchema$1.optional() });
  const NotificationSchema$1 = object({
    method: string2(),
    params: NotificationsParamsSchema$1.loose().optional()
  });
  const IconSchema$1 = object({
    src: string2(),
    mimeType: string2().optional(),
    sizes: array(string2()).optional(),
    theme: _enum(["light", "dark"]).optional()
  });
  const IconsSchema$1 = object({ icons: array(IconSchema$1).optional() });
  const BaseMetadataSchema$1 = object({
    name: string2(),
    title: string2().optional()
  });
  const ImplementationSchema$1 = BaseMetadataSchema$1.extend({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    version: string2(),
    websiteUrl: string2().optional(),
    description: string2().optional()
  });
  const FormElicitationCapabilitySchema = intersection(object({ applyDefaults: boolean2().optional() }), JSONObjectSchema$1);
  const ElicitationCapabilitySchema = preprocess((value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
      return { form: {} };
    return value;
  }, intersection(object({
    form: FormElicitationCapabilitySchema.optional(),
    url: JSONObjectSchema$1.optional()
  }), JSONObjectSchema$1.optional()));
  const ClientTasksCapabilitySchema$1 = looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: looseObject({
      sampling: looseObject({ createMessage: JSONObjectSchema$1.optional() }).optional(),
      elicitation: looseObject({ create: JSONObjectSchema$1.optional() }).optional()
    }).optional()
  });
  const ServerTasksCapabilitySchema$1 = looseObject({
    list: JSONObjectSchema$1.optional(),
    cancel: JSONObjectSchema$1.optional(),
    requests: looseObject({ tools: looseObject({ call: JSONObjectSchema$1.optional() }).optional() }).optional()
  });
  const ClientCapabilitiesSchema$1 = object({
    experimental: record(string2(), JSONObjectSchema$1).optional(),
    sampling: object({
      context: JSONObjectSchema$1.optional(),
      tools: JSONObjectSchema$1.optional()
    }).optional(),
    elicitation: ElicitationCapabilitySchema.optional(),
    roots: object({ listChanged: boolean2().optional() }).optional(),
    tasks: ClientTasksCapabilitySchema$1.optional(),
    extensions: record(string2(), JSONObjectSchema$1).optional()
  });
  const ServerCapabilitiesSchema$1 = object({
    experimental: record(string2(), JSONObjectSchema$1).optional(),
    logging: JSONObjectSchema$1.optional(),
    completions: JSONObjectSchema$1.optional(),
    prompts: object({ listChanged: boolean2().optional() }).optional(),
    resources: object({
      subscribe: boolean2().optional(),
      listChanged: boolean2().optional()
    }).optional(),
    tools: object({ listChanged: boolean2().optional() }).optional(),
    tasks: ServerTasksCapabilitySchema$1.optional(),
    extensions: record(string2(), JSONObjectSchema$1).optional()
  });
  const ProgressSchema$1 = object({
    progress: number2(),
    total: optional(number2()),
    message: optional(string2())
  });
  const ProgressNotificationParamsSchema$1 = object({
    ...NotificationsParamsSchema$1.shape,
    ...ProgressSchema$1.shape,
    progressToken: ProgressTokenSchema$1
  });
  const ProgressNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/progress"),
    params: ProgressNotificationParamsSchema$1
  });
  const LoggingMessageNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({
    level: LoggingLevelSchema$1,
    logger: string2().optional(),
    data: unknown()
  });
  const LoggingMessageNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/message"),
    params: LoggingMessageNotificationParamsSchema$1
  });
  const ResourceContentsSchema$1 = object({
    uri: string2(),
    mimeType: optional(string2()),
    _meta: record(string2(), unknown()).optional()
  });
  const TextResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ text: string2() });
  const BlobResourceContentsSchema$1 = ResourceContentsSchema$1.extend({ blob: Base64Schema });
  const AnnotationsSchema$1 = object({
    audience: array(RoleSchema$1).optional(),
    priority: number2().min(0).max(1).optional(),
    lastModified: datetime2({ offset: true }).optional()
  });
  const ResourceSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uri: string2(),
    description: optional(string2()),
    mimeType: optional(string2()),
    size: optional(number2()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: optional(looseObject({}))
  });
  const ResourceTemplateSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    uriTemplate: string2(),
    description: optional(string2()),
    mimeType: optional(string2()),
    annotations: AnnotationsSchema$1.optional(),
    _meta: optional(looseObject({}))
  });
  const ResourceListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/resources/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const ResourceUpdatedNotificationParamsSchema$1 = NotificationsParamsSchema$1.extend({ uri: string2() });
  const ResourceUpdatedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/resources/updated"),
    params: ResourceUpdatedNotificationParamsSchema$1
  });
  const PromptArgumentSchema$1 = object({
    name: string2(),
    description: optional(string2()),
    required: optional(boolean2())
  });
  const PromptSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: optional(string2()),
    arguments: optional(array(PromptArgumentSchema$1)),
    _meta: optional(looseObject({}))
  });
  const PromptListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/prompts/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const TextContentSchema$1 = object({
    type: literal("text"),
    text: string2(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ImageContentSchema$1 = object({
    type: literal("image"),
    data: Base64Schema,
    mimeType: string2(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const AudioContentSchema$1 = object({
    type: literal("audio"),
    data: Base64Schema,
    mimeType: string2(),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ToolUseContentSchema$1 = object({
    type: literal("tool_use"),
    name: string2(),
    id: string2(),
    input: record(string2(), unknown()),
    _meta: record(string2(), unknown()).optional()
  });
  const EmbeddedResourceSchema$1 = object({
    type: literal("resource"),
    resource: union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]),
    annotations: AnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ResourceLinkSchema$1 = ResourceSchema$1.extend({ type: literal("resource_link") });
  const ContentBlockSchema$1 = union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ResourceLinkSchema$1,
    EmbeddedResourceSchema$1
  ]);
  const PromptMessageSchema$1 = object({
    role: RoleSchema$1,
    content: ContentBlockSchema$1
  });
  const ToolAnnotationsSchema$1 = object({
    title: string2().optional(),
    readOnlyHint: boolean2().optional(),
    destructiveHint: boolean2().optional(),
    idempotentHint: boolean2().optional(),
    openWorldHint: boolean2().optional()
  });
  const ToolListChangedNotificationSchema$1 = NotificationSchema$1.extend({
    method: literal("notifications/tools/list_changed"),
    params: NotificationsParamsSchema$1.optional()
  });
  const ModelHintSchema$1 = object({ name: string2().optional() });
  const ModelPreferencesSchema$1 = object({
    hints: array(ModelHintSchema$1).optional(),
    costPriority: number2().min(0).max(1).optional(),
    speedPriority: number2().min(0).max(1).optional(),
    intelligencePriority: number2().min(0).max(1).optional()
  });
  const ToolChoiceSchema$1 = object({ mode: _enum([
    "auto",
    "required",
    "none"
  ]).optional() });
  const BooleanSchemaSchema$1 = object({
    type: literal("boolean"),
    title: string2().optional(),
    description: string2().optional(),
    default: boolean2().optional()
  });
  const StringSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    minLength: number2().optional(),
    maxLength: number2().optional(),
    format: _enum([
      "email",
      "uri",
      "date",
      "date-time"
    ]).optional(),
    default: string2().optional()
  });
  const NumberSchemaSchema$1 = object({
    type: _enum(["number", "integer"]),
    title: string2().optional(),
    description: string2().optional(),
    minimum: number2().optional(),
    maximum: number2().optional(),
    default: number2().optional()
  });
  const UntitledSingleSelectEnumSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    enum: array(string2()),
    default: string2().optional()
  });
  const TitledSingleSelectEnumSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    oneOf: array(object({
      const: string2(),
      title: string2()
    })),
    default: string2().optional()
  });
  const LegacyTitledEnumSchemaSchema$1 = object({
    type: literal("string"),
    title: string2().optional(),
    description: string2().optional(),
    enum: array(string2()),
    enumNames: array(string2()).optional(),
    default: string2().optional()
  });
  const SingleSelectEnumSchemaSchema$1 = union([UntitledSingleSelectEnumSchemaSchema$1, TitledSingleSelectEnumSchemaSchema$1]);
  const UntitledMultiSelectEnumSchemaSchema$1 = object({
    type: literal("array"),
    title: string2().optional(),
    description: string2().optional(),
    minItems: number2().optional(),
    maxItems: number2().optional(),
    items: object({
      type: literal("string"),
      enum: array(string2())
    }),
    default: array(string2()).optional()
  });
  const TitledMultiSelectEnumSchemaSchema$1 = object({
    type: literal("array"),
    title: string2().optional(),
    description: string2().optional(),
    minItems: number2().optional(),
    maxItems: number2().optional(),
    items: object({ anyOf: array(object({
      const: string2(),
      title: string2()
    })) }),
    default: array(string2()).optional()
  });
  const MultiSelectEnumSchemaSchema$1 = union([UntitledMultiSelectEnumSchemaSchema$1, TitledMultiSelectEnumSchemaSchema$1]);
  const EnumSchemaSchema$1 = union([
    LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema$1
  ]);
  const PrimitiveSchemaDefinitionSchema$1 = union([
    EnumSchemaSchema$1,
    BooleanSchemaSchema$1,
    StringSchemaSchema$1,
    NumberSchemaSchema$1
  ]);
  const ElicitRequestFormParamsSchema$1 = TaskAugmentedRequestParamsSchema$1.extend({
    mode: literal("form").optional(),
    message: string2(),
    requestedSchema: object({
      type: literal("object"),
      properties: record(string2(), PrimitiveSchemaDefinitionSchema$1),
      required: array(string2()).optional()
    }).catchall(unknown())
  });
  const ResourceTemplateReferenceSchema$1 = object({
    type: literal("ref/resource"),
    uri: string2()
  });
  const PromptReferenceSchema$1 = object({
    type: literal("ref/prompt"),
    name: string2()
  });
  const RootSchema$1 = object({
    uri: string2().startsWith("file://"),
    name: string2().optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const sharedClientCapabilityShape = ClientCapabilitiesSchema$1.shape;
  const ClientCapabilities2026Schema = object({
    experimental: sharedClientCapabilityShape.experimental,
    sampling: sharedClientCapabilityShape.sampling,
    elicitation: sharedClientCapabilityShape.elicitation,
    roots: sharedClientCapabilityShape.roots,
    extensions: sharedClientCapabilityShape.extensions
  });
  const sharedServerCapabilityShape = ServerCapabilitiesSchema$1.shape;
  const ServerCapabilities2026Schema = object({
    experimental: sharedServerCapabilityShape.experimental,
    logging: sharedServerCapabilityShape.logging,
    completions: sharedServerCapabilityShape.completions,
    prompts: sharedServerCapabilityShape.prompts,
    resources: sharedServerCapabilityShape.resources,
    tools: sharedServerCapabilityShape.tools,
    extensions: sharedServerCapabilityShape.extensions
  });
  const RequestMetaEnvelopeSchema = looseObject({
    progressToken: ProgressTokenSchema$1.optional(),
    [PROTOCOL_VERSION_META_KEY]: string2(),
    [CLIENT_INFO_META_KEY]: ImplementationSchema$1.optional(),
    [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilities2026Schema,
    [LOG_LEVEL_META_KEY]: LoggingLevelSchema$1.optional()
  });
  const ToolSchema$1 = object({
    ...BaseMetadataSchema$1.shape,
    ...IconsSchema$1.shape,
    description: string2().optional(),
    inputSchema: looseObject({
      $schema: string2().optional(),
      type: literal("object")
    }),
    outputSchema: looseObject({ $schema: string2().optional() }).optional(),
    annotations: ToolAnnotationsSchema$1.optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const ToolResultContentSchema$1 = object({
    type: literal("tool_result"),
    toolUseId: string2(),
    content: array(ContentBlockSchema$1),
    structuredContent: unknown().optional(),
    isError: boolean2().optional(),
    _meta: record(string2(), unknown()).optional()
  });
  const SamplingMessageContentBlockSchema$1 = union([
    TextContentSchema$1,
    ImageContentSchema$1,
    AudioContentSchema$1,
    ToolUseContentSchema$1,
    ToolResultContentSchema$1
  ]);
  const SamplingMessageSchema$1 = object({
    role: RoleSchema$1,
    content: union([SamplingMessageContentBlockSchema$1, array(SamplingMessageContentBlockSchema$1)]),
    _meta: record(string2(), unknown()).optional()
  });
  const ResultTypeSchema = string2();
  const ResultMetaSchema = looseObject({ [SERVER_INFO_META_KEY]: ImplementationSchema$1.optional().catch(undefined) });
  const wireMeta = ResultMetaSchema.optional();
  function wireResult(shape) {
    return looseObject({
      _meta: wireMeta,
      resultType: ResultTypeSchema.default("complete"),
      ...shape
    });
  }
  const ResultSchema$1 = wireResult({});
  const PaginatedResultSchema$1 = wireResult({ nextCursor: CursorSchema$1.optional() });
  const CallToolResultSchema$1 = wireResult({
    content: array(ContentBlockSchema$1),
    structuredContent: unknown().optional(),
    isError: boolean2().optional()
  });
  const ListToolsResultSchema$1 = wireResult({
    ttlMs: number2().int().min(0),
    cacheScope: _enum(["public", "private"]),
    tools: array(ToolSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const ListPromptsResultSchema$1 = wireResult({
    ttlMs: number2().int().min(0),
    cacheScope: _enum(["public", "private"]),
    prompts: array(PromptSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const GetPromptResultSchema$1 = wireResult({
    description: string2().optional(),
    messages: array(PromptMessageSchema$1)
  });
  const ListResourcesResultSchema$1 = wireResult({
    ttlMs: number2().int().min(0),
    cacheScope: _enum(["public", "private"]),
    resources: array(ResourceSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const ListResourceTemplatesResultSchema$1 = wireResult({
    ttlMs: number2().int().min(0),
    cacheScope: _enum(["public", "private"]),
    resourceTemplates: array(ResourceTemplateSchema$1),
    nextCursor: CursorSchema$1.optional()
  });
  const ReadResourceResultSchema$1 = wireResult({
    ttlMs: number2().int().min(0),
    cacheScope: _enum(["public", "private"]),
    contents: array(union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]))
  });
  const CompleteResultSchema$1 = wireResult({ completion: object({
    values: array(string2()).max(100),
    total: number2().int().optional(),
    hasMore: boolean2().optional()
  }).loose() });
  const CacheableResultSchema = wireResult({
    ttlMs: number2().int().min(0),
    cacheScope: _enum(["public", "private"])
  });
  const DiscoverResultSchema$1 = wireResult({
    ttlMs: number2().int().min(0).catch(0),
    cacheScope: _enum(["public", "private"]).catch("private"),
    supportedVersions: array(string2()),
    capabilities: ServerCapabilities2026Schema,
    instructions: string2().optional()
  });
  const CreateMessageRequestParamsSchema$1 = object({
    messages: array(SamplingMessageSchema$1),
    modelPreferences: ModelPreferencesSchema$1.optional(),
    systemPrompt: string2().optional(),
    includeContext: _enum([
      "none",
      "thisServer",
      "allServers"
    ]).optional(),
    temperature: number2().optional(),
    maxTokens: number2().int(),
    stopSequences: array(string2()).optional(),
    metadata: JSONObjectSchema$1.optional(),
    tools: array(ToolSchema$1).optional(),
    toolChoice: ToolChoiceSchema$1.optional()
  });
  const CreateMessageRequestSchema$1 = object({
    method: literal("sampling/createMessage"),
    params: CreateMessageRequestParamsSchema$1
  });
  const ListRootsRequestSchema$1 = object({
    method: literal("roots/list"),
    params: object({ _meta: record(string2(), unknown()).optional() }).optional()
  });
  const CreateMessageResultSchema$1 = object({
    ...SamplingMessageSchema$1.shape,
    model: string2(),
    stopReason: string2().optional()
  });
  const ListRootsResultSchema$1 = object({ roots: array(RootSchema$1) });
  const ElicitResultSchema$1 = object({
    action: _enum([
      "accept",
      "decline",
      "cancel"
    ]),
    content: record(string2(), union([
      string2(),
      number2(),
      boolean2(),
      array(string2())
    ])).optional()
  });
  const ElicitRequestURLParamsSchema$1 = object({
    mode: literal("url"),
    message: string2(),
    url: string2().url()
  });
  const ElicitRequestParamsSchema$1 = union([ElicitRequestFormParamsSchema$1, ElicitRequestURLParamsSchema$1]);
  const ElicitRequestSchema$1 = object({
    method: literal("elicitation/create"),
    params: ElicitRequestParamsSchema$1
  });
  const InputRequestSchema = union([
    CreateMessageRequestSchema$1,
    ListRootsRequestSchema$1,
    ElicitRequestSchema$1
  ]);
  const InputResponseSchema = union([
    CreateMessageResultSchema$1,
    ListRootsResultSchema$1,
    ElicitResultSchema$1
  ]);
  const InputRequestsSchema = record(string2(), InputRequestSchema);
  const InputResponsesSchema = record(string2(), InputResponseSchema);
  const InputRequiredResultSchema = wireResult({
    inputRequests: InputRequestsSchema.optional(),
    requestState: string2().optional()
  });
  const retryParamsShape = {
    inputResponses: InputResponsesSchema.optional(),
    requestState: string2().optional()
  };
  const InputResponseRequestParamsSchema = object({
    _meta: RequestMetaEnvelopeSchema,
    ...retryParamsShape
  });
  const DispatchRequestMetaSchema = looseObject({ progressToken: ProgressTokenSchema$1.optional() });
  function wireRequest(method, paramsShape) {
    return object({
      method: literal(method),
      params: object({
        _meta: RequestMetaEnvelopeSchema,
        ...paramsShape
      })
    });
  }
  function dispatchRequest(method, paramsShape) {
    return object({
      method: literal(method),
      params: object({
        _meta: DispatchRequestMetaSchema.optional(),
        ...paramsShape
      }).optional()
    });
  }
  const callToolParamsShape = {
    name: string2(),
    arguments: record(string2(), unknown()).optional(),
    ...retryParamsShape
  };
  const paginatedParamsShape = { cursor: CursorSchema$1.optional() };
  const CallToolRequestSchema$1 = wireRequest("tools/call", callToolParamsShape);
  const ListToolsRequestSchema$1 = wireRequest("tools/list", paginatedParamsShape);
  const ListPromptsRequestSchema$1 = wireRequest("prompts/list", paginatedParamsShape);
  const GetPromptRequestSchema$1 = wireRequest("prompts/get", {
    name: string2(),
    arguments: record(string2(), string2()).optional(),
    ...retryParamsShape
  });
  const ListResourcesRequestSchema$1 = wireRequest("resources/list", paginatedParamsShape);
  const ListResourceTemplatesRequestSchema$1 = wireRequest("resources/templates/list", paginatedParamsShape);
  const ReadResourceRequestSchema$1 = wireRequest("resources/read", {
    uri: string2(),
    ...retryParamsShape
  });
  const completeParamsShape = {
    ref: union([PromptReferenceSchema$1, ResourceTemplateReferenceSchema$1]),
    argument: object({
      name: string2(),
      value: string2()
    }),
    context: object({ arguments: record(string2(), string2()).optional() }).optional()
  };
  const CompleteRequestSchema$1 = wireRequest("completion/complete", completeParamsShape);
  const DiscoverRequestSchema$1 = wireRequest("server/discover", {});
  const SubscriptionFilterSchema$1 = object({
    toolsListChanged: boolean2().optional(),
    promptsListChanged: boolean2().optional(),
    resourcesListChanged: boolean2().optional(),
    resourceSubscriptions: array(string2()).optional()
  });
  const subscriptionsListenParamsShape = { notifications: SubscriptionFilterSchema$1 };
  const SubscriptionsListenRequestSchema$1 = wireRequest("subscriptions/listen", subscriptionsListenParamsShape);
  const SubscriptionsListenResultMetaSchema$1 = ResultMetaSchema.extend({ "io.modelcontextprotocol/subscriptionId": RequestIdSchema$1 });
  const SubscriptionsListenResultSchema$1 = looseObject({
    _meta: SubscriptionsListenResultMetaSchema$1,
    resultType: ResultTypeSchema.default("complete")
  });
  const dispatchRequestSchemas = {
    "tools/call": dispatchRequest("tools/call", callToolParamsShape),
    "tools/list": dispatchRequest("tools/list", paginatedParamsShape),
    "prompts/get": dispatchRequest("prompts/get", {
      name: string2(),
      arguments: record(string2(), string2()).optional()
    }),
    "prompts/list": dispatchRequest("prompts/list", paginatedParamsShape),
    "resources/list": dispatchRequest("resources/list", paginatedParamsShape),
    "resources/templates/list": dispatchRequest("resources/templates/list", paginatedParamsShape),
    "resources/read": dispatchRequest("resources/read", { uri: string2() }),
    "completion/complete": dispatchRequest("completion/complete", completeParamsShape),
    "server/discover": dispatchRequest("server/discover", {}),
    "subscriptions/listen": dispatchRequest("subscriptions/listen", subscriptionsListenParamsShape)
  };
  function liftedResult(shape) {
    return looseObject({
      _meta: wireMeta,
      ...shape
    });
  }
  const dispatchResultSchemas = {
    "tools/call": liftedResult({
      content: array(ContentBlockSchema$1),
      structuredContent: unknown().optional(),
      isError: boolean2().optional()
    }),
    "tools/list": liftedResult({
      ttlMs: number2().int().min(0),
      cacheScope: _enum(["public", "private"]),
      tools: array(ToolSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "prompts/get": liftedResult({
      description: string2().optional(),
      messages: array(PromptMessageSchema$1)
    }),
    "prompts/list": liftedResult({
      ttlMs: number2().int().min(0),
      cacheScope: _enum(["public", "private"]),
      prompts: array(PromptSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "resources/list": liftedResult({
      ttlMs: number2().int().min(0),
      cacheScope: _enum(["public", "private"]),
      resources: array(ResourceSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "resources/templates/list": liftedResult({
      ttlMs: number2().int().min(0),
      cacheScope: _enum(["public", "private"]),
      resourceTemplates: array(ResourceTemplateSchema$1),
      nextCursor: CursorSchema$1.optional()
    }),
    "resources/read": liftedResult({
      ttlMs: number2().int().min(0),
      cacheScope: _enum(["public", "private"]),
      contents: array(union([TextResourceContentsSchema$1, BlobResourceContentsSchema$1]))
    }),
    "completion/complete": liftedResult({ completion: object({
      values: array(string2()).max(100),
      total: number2().int().optional(),
      hasMore: boolean2().optional()
    }).loose() }),
    "server/discover": liftedResult({
      ttlMs: number2().int().min(0).catch(0),
      cacheScope: _enum(["public", "private"]).catch("private"),
      supportedVersions: array(string2()),
      capabilities: ServerCapabilities2026Schema,
      instructions: string2().optional()
    }),
    "subscriptions/listen": liftedResult({})
  };
  const NotificationMetaSchema = looseObject({ "io.modelcontextprotocol/subscriptionId": RequestIdSchema$1.optional() });
  const SubscriptionsAcknowledgedNotificationSchema$1 = object({
    method: literal("notifications/subscriptions/acknowledged"),
    params: object({
      _meta: NotificationMetaSchema.optional(),
      notifications: SubscriptionFilterSchema$1
    })
  });
  const CancelledNotificationParamsSchema$1 = object({
    _meta: NotificationMetaSchema.optional(),
    requestId: RequestIdSchema$1,
    reason: string2().optional()
  });
  const CancelledNotificationSchema$1 = object({
    method: literal("notifications/cancelled"),
    params: CancelledNotificationParamsSchema$1
  });
  const notificationSchemas2026 = {
    "notifications/cancelled": CancelledNotificationSchema$1,
    "notifications/progress": ProgressNotificationSchema$1,
    "notifications/message": LoggingMessageNotificationSchema$1,
    "notifications/resources/updated": ResourceUpdatedNotificationSchema$1,
    "notifications/resources/list_changed": ResourceListChangedNotificationSchema$1,
    "notifications/tools/list_changed": ToolListChangedNotificationSchema$1,
    "notifications/prompts/list_changed": PromptListChangedNotificationSchema$1,
    "notifications/subscriptions/acknowledged": SubscriptionsAcknowledgedNotificationSchema$1
  };
  const wireResultResponse = (result) => object({
    jsonrpc: literal("2.0"),
    id: union([string2(), number2().int()]),
    result
  }).strict();
  return {
    JSONValueSchema: JSONValueSchema$1,
    JSONObjectSchema: JSONObjectSchema$1,
    ProgressTokenSchema: ProgressTokenSchema$1,
    CursorSchema: CursorSchema$1,
    RequestIdSchema: RequestIdSchema$1,
    RoleSchema: RoleSchema$1,
    LoggingLevelSchema: LoggingLevelSchema$1,
    TaskMetadataSchema: TaskMetadataSchema$1,
    RelatedTaskMetadataSchema: RelatedTaskMetadataSchema$1,
    RequestMetaSchema: RequestMetaSchema$1,
    BaseRequestParamsSchema: BaseRequestParamsSchema$1,
    TaskAugmentedRequestParamsSchema: TaskAugmentedRequestParamsSchema$1,
    NotificationsParamsSchema: NotificationsParamsSchema$1,
    NotificationSchema: NotificationSchema$1,
    IconSchema: IconSchema$1,
    IconsSchema: IconsSchema$1,
    BaseMetadataSchema: BaseMetadataSchema$1,
    ImplementationSchema: ImplementationSchema$1,
    ClientTasksCapabilitySchema: ClientTasksCapabilitySchema$1,
    ServerTasksCapabilitySchema: ServerTasksCapabilitySchema$1,
    ClientCapabilitiesSchema: ClientCapabilitiesSchema$1,
    ServerCapabilitiesSchema: ServerCapabilitiesSchema$1,
    ProgressSchema: ProgressSchema$1,
    ProgressNotificationParamsSchema: ProgressNotificationParamsSchema$1,
    ProgressNotificationSchema: ProgressNotificationSchema$1,
    LoggingMessageNotificationParamsSchema: LoggingMessageNotificationParamsSchema$1,
    LoggingMessageNotificationSchema: LoggingMessageNotificationSchema$1,
    ResourceContentsSchema: ResourceContentsSchema$1,
    TextResourceContentsSchema: TextResourceContentsSchema$1,
    BlobResourceContentsSchema: BlobResourceContentsSchema$1,
    AnnotationsSchema: AnnotationsSchema$1,
    ResourceSchema: ResourceSchema$1,
    ResourceTemplateSchema: ResourceTemplateSchema$1,
    ResourceListChangedNotificationSchema: ResourceListChangedNotificationSchema$1,
    ResourceUpdatedNotificationParamsSchema: ResourceUpdatedNotificationParamsSchema$1,
    ResourceUpdatedNotificationSchema: ResourceUpdatedNotificationSchema$1,
    PromptArgumentSchema: PromptArgumentSchema$1,
    PromptSchema: PromptSchema$1,
    PromptListChangedNotificationSchema: PromptListChangedNotificationSchema$1,
    TextContentSchema: TextContentSchema$1,
    ImageContentSchema: ImageContentSchema$1,
    AudioContentSchema: AudioContentSchema$1,
    ToolUseContentSchema: ToolUseContentSchema$1,
    EmbeddedResourceSchema: EmbeddedResourceSchema$1,
    ResourceLinkSchema: ResourceLinkSchema$1,
    ContentBlockSchema: ContentBlockSchema$1,
    PromptMessageSchema: PromptMessageSchema$1,
    ToolAnnotationsSchema: ToolAnnotationsSchema$1,
    ToolListChangedNotificationSchema: ToolListChangedNotificationSchema$1,
    ModelHintSchema: ModelHintSchema$1,
    ModelPreferencesSchema: ModelPreferencesSchema$1,
    ToolChoiceSchema: ToolChoiceSchema$1,
    BooleanSchemaSchema: BooleanSchemaSchema$1,
    StringSchemaSchema: StringSchemaSchema$1,
    NumberSchemaSchema: NumberSchemaSchema$1,
    UntitledSingleSelectEnumSchemaSchema: UntitledSingleSelectEnumSchemaSchema$1,
    TitledSingleSelectEnumSchemaSchema: TitledSingleSelectEnumSchemaSchema$1,
    LegacyTitledEnumSchemaSchema: LegacyTitledEnumSchemaSchema$1,
    SingleSelectEnumSchemaSchema: SingleSelectEnumSchemaSchema$1,
    UntitledMultiSelectEnumSchemaSchema: UntitledMultiSelectEnumSchemaSchema$1,
    TitledMultiSelectEnumSchemaSchema: TitledMultiSelectEnumSchemaSchema$1,
    MultiSelectEnumSchemaSchema: MultiSelectEnumSchemaSchema$1,
    EnumSchemaSchema: EnumSchemaSchema$1,
    PrimitiveSchemaDefinitionSchema: PrimitiveSchemaDefinitionSchema$1,
    ElicitRequestFormParamsSchema: ElicitRequestFormParamsSchema$1,
    ResourceTemplateReferenceSchema: ResourceTemplateReferenceSchema$1,
    PromptReferenceSchema: PromptReferenceSchema$1,
    RootSchema: RootSchema$1,
    ClientCapabilities2026Schema,
    ServerCapabilities2026Schema,
    RequestMetaEnvelopeSchema,
    ToolSchema: ToolSchema$1,
    ToolResultContentSchema: ToolResultContentSchema$1,
    SamplingMessageContentBlockSchema: SamplingMessageContentBlockSchema$1,
    SamplingMessageSchema: SamplingMessageSchema$1,
    ResultTypeSchema,
    ResultMetaSchema,
    ResultSchema: ResultSchema$1,
    PaginatedResultSchema: PaginatedResultSchema$1,
    CallToolResultSchema: CallToolResultSchema$1,
    ListToolsResultSchema: ListToolsResultSchema$1,
    ListPromptsResultSchema: ListPromptsResultSchema$1,
    GetPromptResultSchema: GetPromptResultSchema$1,
    ListResourcesResultSchema: ListResourcesResultSchema$1,
    ListResourceTemplatesResultSchema: ListResourceTemplatesResultSchema$1,
    ReadResourceResultSchema: ReadResourceResultSchema$1,
    CompleteResultSchema: CompleteResultSchema$1,
    CacheableResultSchema,
    DiscoverResultSchema: DiscoverResultSchema$1,
    CreateMessageRequestParamsSchema: CreateMessageRequestParamsSchema$1,
    CreateMessageRequestSchema: CreateMessageRequestSchema$1,
    ListRootsRequestSchema: ListRootsRequestSchema$1,
    CreateMessageResultSchema: CreateMessageResultSchema$1,
    ListRootsResultSchema: ListRootsResultSchema$1,
    ElicitResultSchema: ElicitResultSchema$1,
    ElicitRequestURLParamsSchema: ElicitRequestURLParamsSchema$1,
    ElicitRequestParamsSchema: ElicitRequestParamsSchema$1,
    ElicitRequestSchema: ElicitRequestSchema$1,
    InputRequestSchema,
    InputResponseSchema,
    InputRequestsSchema,
    InputResponsesSchema,
    InputRequiredResultSchema,
    InputResponseRequestParamsSchema,
    CallToolRequestSchema: CallToolRequestSchema$1,
    ListToolsRequestSchema: ListToolsRequestSchema$1,
    ListPromptsRequestSchema: ListPromptsRequestSchema$1,
    GetPromptRequestSchema: GetPromptRequestSchema$1,
    ListResourcesRequestSchema: ListResourcesRequestSchema$1,
    ListResourceTemplatesRequestSchema: ListResourceTemplatesRequestSchema$1,
    ReadResourceRequestSchema: ReadResourceRequestSchema$1,
    CompleteRequestSchema: CompleteRequestSchema$1,
    DiscoverRequestSchema: DiscoverRequestSchema$1,
    SubscriptionFilterSchema: SubscriptionFilterSchema$1,
    SubscriptionsListenRequestSchema: SubscriptionsListenRequestSchema$1,
    SubscriptionsListenResultMetaSchema: SubscriptionsListenResultMetaSchema$1,
    SubscriptionsListenResultSchema: SubscriptionsListenResultSchema$1,
    dispatchRequestSchemas,
    dispatchResultSchemas,
    NotificationMetaSchema,
    SubscriptionsAcknowledgedNotificationSchema: SubscriptionsAcknowledgedNotificationSchema$1,
    CancelledNotificationParamsSchema: CancelledNotificationParamsSchema$1,
    CancelledNotificationSchema: CancelledNotificationSchema$1,
    notificationSchemas2026,
    JSONRPCResultResponseSchema: wireResultResponse(ResultSchema$1),
    CallToolResultResponseSchema: wireResultResponse(union([CallToolResultSchema$1, InputRequiredResultSchema])),
    ListToolsResultResponseSchema: wireResultResponse(ListToolsResultSchema$1),
    ListPromptsResultResponseSchema: wireResultResponse(ListPromptsResultSchema$1),
    GetPromptResultResponseSchema: wireResultResponse(union([GetPromptResultSchema$1, InputRequiredResultSchema])),
    ListResourcesResultResponseSchema: wireResultResponse(ListResourcesResultSchema$1),
    ListResourceTemplatesResultResponseSchema: wireResultResponse(ListResourceTemplatesResultSchema$1),
    ReadResourceResultResponseSchema: wireResultResponse(union([ReadResourceResultSchema$1, InputRequiredResultSchema])),
    CompleteResultResponseSchema: wireResultResponse(CompleteResultSchema$1),
    DiscoverResultResponseSchema: wireResultResponse(DiscoverResultSchema$1),
    SubscriptionsListenResultResponseSchema: wireResultResponse(SubscriptionsListenResultSchema$1)
  };
}
var memo2;
function buildSchemas2026() {
  return memo2 ??= build();
}
var CACHEABLE_RESULT_METHODS = [
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "server/discover"
];
function isCacheableResultMethod(method) {
  return CACHEABLE_RESULT_METHODS.includes(method);
}
var RESULT_CACHE_HINT_FALLBACK = Symbol("modelcontextprotocol.resultCacheHintFallback");
function cacheHintFallbackOf(result) {
  return result[RESULT_CACHE_HINT_FALLBACK];
}
function isValidCacheTtlMs(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isValidCacheScope(value) {
  return value === "public" || value === "private";
}
var ProtocolErrorCode = /* @__PURE__ */ function(ProtocolErrorCode$1) {
  ProtocolErrorCode$1[ProtocolErrorCode$1["ParseError"] = -32700] = "ParseError";
  ProtocolErrorCode$1[ProtocolErrorCode$1["InvalidRequest"] = -32600] = "InvalidRequest";
  ProtocolErrorCode$1[ProtocolErrorCode$1["MethodNotFound"] = -32601] = "MethodNotFound";
  ProtocolErrorCode$1[ProtocolErrorCode$1["InvalidParams"] = -32602] = "InvalidParams";
  ProtocolErrorCode$1[ProtocolErrorCode$1["InternalError"] = -32603] = "InternalError";
  ProtocolErrorCode$1[ProtocolErrorCode$1["ResourceNotFound"] = -32002] = "ResourceNotFound";
  ProtocolErrorCode$1[ProtocolErrorCode$1["MissingRequiredClientCapability"] = -32021] = "MissingRequiredClientCapability";
  ProtocolErrorCode$1[ProtocolErrorCode$1["UnsupportedProtocolVersion"] = -32022] = "UnsupportedProtocolVersion";
  ProtocolErrorCode$1[ProtocolErrorCode$1["UrlElicitationRequired"] = -32042] = "UrlElicitationRequired";
  return ProtocolErrorCode$1;
}({});
var ProtocolError = class ProtocolError extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.ProtocolError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  static isInstance(value) {
    if (typeof this !== "function")
      throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "ProtocolError";
    stampErrorBrands(this, new.target);
  }
  static fromError(code, message, data) {
    if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
      const errorData = data;
      if (errorData.elicitations)
        return new UrlElicitationRequiredError(errorData.elicitations, message);
    }
    if (code === ProtocolErrorCode.UnsupportedProtocolVersion && data) {
      const errorData = data;
      if (Array.isArray(errorData.supported) && typeof errorData.requested === "string")
        return new UnsupportedProtocolVersionError({
          supported: errorData.supported,
          requested: errorData.requested
        }, message);
    }
    if (code === ProtocolErrorCode.InvalidParams || code === ProtocolErrorCode.ResourceNotFound) {
      const errorData = data;
      if (typeof errorData?.uri === "string" && (code === ProtocolErrorCode.ResourceNotFound || Object.keys(errorData).length === 1))
        return new ResourceNotFoundError(errorData.uri, message);
    }
    if (code === ProtocolErrorCode.MissingRequiredClientCapability && data) {
      const errorData = data;
      if (errorData.requiredCapabilities !== null && typeof errorData.requiredCapabilities === "object" && !Array.isArray(errorData.requiredCapabilities))
        return new MissingRequiredClientCapabilityError({ requiredCapabilities: errorData.requiredCapabilities }, message);
    }
    return new ProtocolError(code, message, data);
  }
};
var ResourceNotFoundError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.ResourceNotFoundError" });
  }
  constructor(uri, message = `Resource not found: ${uri}`) {
    super(ProtocolErrorCode.InvalidParams, message, { uri });
  }
  get uri() {
    return this.data.uri;
  }
};
var UrlElicitationRequiredError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.UrlElicitationRequiredError" });
  }
  constructor(elicitations, message = `URL elicitation${elicitations.length > 1 ? "s" : ""} required`) {
    super(ProtocolErrorCode.UrlElicitationRequired, message, { elicitations });
  }
  get elicitations() {
    return this.data?.elicitations ?? [];
  }
};
var UnsupportedProtocolVersionError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.UnsupportedProtocolVersionError" });
  }
  constructor(data, message = `Unsupported protocol version: ${data.requested}`) {
    super(ProtocolErrorCode.UnsupportedProtocolVersion, message, data);
  }
  get supported() {
    return this.data.supported;
  }
  get requested() {
    return this.data.requested;
  }
};
var MissingRequiredClientCapabilityError = class extends ProtocolError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.MissingRequiredClientCapabilityError" });
  }
  constructor(data, message = `Missing required client capabilities: ${Object.keys(data.requiredCapabilities).join(", ")}`) {
    super(ProtocolErrorCode.MissingRequiredClientCapability, message, data);
  }
  get requiredCapabilities() {
    return this.data.requiredCapabilities;
  }
};
var DEFAULT_CACHE_TTL_MS = 0;
var DEFAULT_CACHE_SCOPE = "private";
var EXTENDED_RESULT_TYPE_METHODS = [
  "tools/call",
  "prompts/get",
  "resources/read"
];
function stampResultType(method, result) {
  const provided = result["resultType"];
  if (provided === undefined)
    return {
      ...result,
      resultType: "complete"
    };
  if (provided === "complete")
    return result;
  if (EXTENDED_RESULT_TYPE_METHODS.includes(method))
    return result;
  throw new ProtocolError(ProtocolErrorCode.InternalError, `Handler for ${method} returned resultType '${String(provided)}', but results of ${method} only support 'complete' on protocol revision 2026-07-28`);
}
function fillCacheFields(method, result) {
  const fallback = cacheHintFallbackOf(result);
  if (result["resultType"] !== "complete" || !isCacheableResultMethod(method))
    return fallback === undefined ? result : stripCacheHintFallback(result);
  const provided = result;
  const ttlMs = isValidCacheTtlMs(provided["ttlMs"]) ? provided["ttlMs"] : resolveTtlMs(fallback);
  const cacheScope = isValidCacheScope(provided["cacheScope"]) ? provided["cacheScope"] : resolveCacheScope(fallback);
  const filled = {
    ...provided,
    ttlMs,
    cacheScope
  };
  delete filled[RESULT_CACHE_HINT_FALLBACK];
  return filled;
}
function isPlainObject$4(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stampServerInfoMeta(result, serverInfo) {
  if (serverInfo === undefined)
    return result;
  const meta = result["_meta"];
  if (meta === undefined)
    return {
      ...result,
      _meta: { [SERVER_INFO_META_KEY]: serverInfo }
    };
  if (!isPlainObject$4(meta))
    return result;
  if (meta[SERVER_INFO_META_KEY] !== undefined)
    return result;
  return {
    ...result,
    _meta: {
      ...meta,
      [SERVER_INFO_META_KEY]: serverInfo
    }
  };
}
function resolveTtlMs(fallback) {
  return fallback !== undefined && isValidCacheTtlMs(fallback.ttlMs) ? fallback.ttlMs : DEFAULT_CACHE_TTL_MS;
}
function resolveCacheScope(fallback) {
  return fallback !== undefined && isValidCacheScope(fallback.cacheScope) ? fallback.cacheScope : DEFAULT_CACHE_SCOPE;
}
function stripCacheHintFallback(result) {
  const copy = { ...result };
  delete copy[RESULT_CACHE_HINT_FALLBACK];
  return copy;
}
var INPUT_REQUEST_METHODS_2026 = [
  "elicitation/create",
  "sampling/createMessage",
  "roots/list"
];
var maps;
function inputSchemaMaps() {
  if (maps)
    return maps;
  const s = buildSchemas2026();
  maps = {
    request: {
      "elicitation/create": object({
        method: literal("elicitation/create"),
        params: s.ElicitRequestParamsSchema
      }),
      "sampling/createMessage": object({
        method: literal("sampling/createMessage"),
        params: s.CreateMessageRequestParamsSchema
      }),
      "roots/list": object({
        method: literal("roots/list"),
        params: looseObject({}).optional()
      })
    },
    response: {
      "elicitation/create": s.ElicitResultSchema,
      "sampling/createMessage": s.CreateMessageResultSchema,
      "roots/list": s.ListRootsResultSchema
    }
  };
  return maps;
}
function isInputRequestMethod2026(method) {
  return INPUT_REQUEST_METHODS_2026.includes(method);
}
function getInputRequestSchema2026(method) {
  return isInputRequestMethod2026(method) ? inputSchemaMaps().request[method] : undefined;
}
function getInputResponseSchema2026(method) {
  return isInputRequestMethod2026(method) ? inputSchemaMaps().response[method] : undefined;
}
var requestMethodKeys = {
  "tools/call": null,
  "tools/list": null,
  "prompts/get": null,
  "prompts/list": null,
  "resources/list": null,
  "resources/templates/list": null,
  "resources/read": null,
  "completion/complete": null,
  "server/discover": null,
  "subscriptions/listen": null
};
var notificationMethodKeys = {
  "notifications/cancelled": null,
  "notifications/progress": null,
  "notifications/message": null,
  "notifications/resources/updated": null,
  "notifications/resources/list_changed": null,
  "notifications/tools/list_changed": null,
  "notifications/prompts/list_changed": null,
  "notifications/subscriptions/acknowledged": null
};
function hasRequestMethod2026(method) {
  return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
}
function hasNotificationMethod2026(method) {
  return Object.prototype.hasOwnProperty.call(notificationMethodKeys, method);
}
function hasResultMethod2026(method) {
  return Object.prototype.hasOwnProperty.call(requestMethodKeys, method);
}
function getRequestSchema2026(method) {
  return hasRequestMethod2026(method) ? buildSchemas2026().dispatchRequestSchemas[method] : undefined;
}
function getResultSchema2026(method) {
  return hasResultMethod2026(method) ? buildSchemas2026().dispatchResultSchemas[method] : undefined;
}
function getNotificationSchema2026(method) {
  return hasNotificationMethod2026(method) ? buildSchemas2026().notificationSchemas2026[method] : undefined;
}
var rev2026RequestMethods = Object.keys(requestMethodKeys);
var rev2026NotificationMethods = Object.keys(notificationMethodKeys);
function isPlainObject$3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function triState(schema, raw) {
  if (schema === undefined)
    return {
      ok: false,
      reason: "not-in-era"
    };
  const parsed = schema.safeParse(raw);
  return parsed.success ? {
    ok: true,
    value: parsed.data
  } : {
    ok: false,
    reason: "invalid",
    message: String(parsed.error)
  };
}
var NOT_IN_ERA = {
  ok: false,
  reason: "not-in-era"
};
var REQUIRED_ENVELOPE_KEYS = [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY];
function enforceDeletedFields(method, result) {
  let next = result;
  let copied = false;
  const copy = () => {
    if (!copied) {
      next = { ...next };
      copied = true;
    }
    return next;
  };
  const tools = result.tools;
  if (method === "tools/list" && Array.isArray(tools) && tools.some((tool) => isPlainObject$3(tool) && ("execution" in tool)))
    copy().tools = tools.map((tool) => {
      if (!isPlainObject$3(tool) || !("execution" in tool))
        return tool;
      const rest = { ...tool };
      delete rest["execution"];
      return rest;
    });
  const capabilities = result.capabilities;
  if (isPlainObject$3(capabilities) && "tasks" in capabilities) {
    const rest = { ...capabilities };
    delete rest["tasks"];
    copy().capabilities = rest;
  }
  return next;
}
var rev2026Codec = {
  era: "2026-07-28",
  hasRequestMethod: hasRequestMethod2026,
  hasNotificationMethod: hasNotificationMethod2026,
  hasInputRequestMethod: (method) => getInputRequestSchema2026(method) !== undefined,
  validateRequest: (method, raw) => triState(getRequestSchema2026(method), raw),
  validateResult: (method, raw) => triState(getResultSchema2026(method), raw),
  validateNotification: (method, raw) => triState(getNotificationSchema2026(method), raw),
  validateInputRequest: (method, raw) => triState(getInputRequestSchema2026(method), raw),
  validateInputResponse: (method, raw) => triState(getInputResponseSchema2026(method), raw),
  samplingResultVariant: () => NOT_IN_ERA,
  outboundEnvelope(material) {
    return {
      [PROTOCOL_VERSION_META_KEY]: material.protocolVersion,
      [CLIENT_INFO_META_KEY]: material.clientInfo,
      [CLIENT_CAPABILITIES_META_KEY]: material.clientCapabilities,
      ...material.logLevel !== undefined && { [LOG_LEVEL_META_KEY]: material.logLevel }
    };
  },
  validateEnvelopeMeta(meta) {
    const issues = [];
    for (const key of REQUIRED_ENVELOPE_KEYS)
      if (!(key in meta))
        issues.push({
          key,
          problem: "missing"
        });
    const parsed = buildSchemas2026().RequestMetaEnvelopeSchema.safeParse(meta);
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String);
        const key = path.length > 0 ? path.join(".") : "_meta";
        if (path.length === 1 && issues.some((existing) => existing.key === key && existing.problem === "missing"))
          continue;
        issues.push({
          key,
          problem: issue.message
        });
      }
    return issues;
  },
  projectCallToolResult: (result) => appendTextFallbackForNonObject(result),
  inputRequestSchema: getInputRequestSchema2026,
  decodeResult(method, raw) {
    if (!isPlainObject$3(raw))
      return {
        kind: "invalid",
        error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: not an object`, { method })
      };
    const rawResultType = raw["resultType"];
    if (rawResultType === undefined)
      return {
        kind: "invalid",
        error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: missing required resultType — servers implementing protocol revision 2026-07-28 MUST include it (the absent-means-complete bridge applies only to earlier-revision servers)`, {
          method,
          violation: "missing-resultType"
        })
      };
    if (typeof rawResultType !== "string")
      return {
        kind: "invalid",
        error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: non-string resultType`, {
          method,
          resultType: rawResultType
        })
      };
    if (rawResultType === "input_required") {
      const rawInputRequests = raw["inputRequests"];
      const inputRequests = isPlainObject$3(rawInputRequests) ? rawInputRequests : {};
      const requestState = raw["requestState"];
      const metaParse = raw["_meta"] === undefined ? undefined : buildSchemas2026().ResultMetaSchema.safeParse(raw["_meta"]);
      const meta = metaParse?.success ? metaParse.data : undefined;
      if (Object.keys(inputRequests).length === 0 && typeof requestState !== "string")
        return {
          kind: "invalid",
          error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: input_required carries neither inputRequests nor requestState (every input_required result must include at least one of the two)`, {
            method,
            violation: "input-required-missing-both"
          })
        };
      return {
        kind: "input_required",
        inputRequests,
        ...typeof requestState === "string" && { requestState },
        ...meta !== undefined && { _meta: meta }
      };
    }
    if (rawResultType !== "complete")
      return {
        kind: "invalid",
        error: new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${rawResultType}' for ${method}`, {
          resultType: rawResultType,
          method
        })
      };
    const wireResultSchemas = getWireResultSchemas();
    const wireSchema = Object.hasOwn(wireResultSchemas, method) ? wireResultSchemas[method] : undefined;
    if (wireSchema !== undefined) {
      const parsed = wireSchema.safeParse(raw);
      if (!parsed.success)
        return {
          kind: "invalid",
          error: new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${method}: ${parsed.error}`, { method })
        };
    }
    const lifted = { ...raw };
    delete lifted["resultType"];
    return {
      kind: "complete",
      result: lifted
    };
  },
  encodeResult(method, result, serverInfo) {
    return stampServerInfoMeta(fillCacheFields(method, stampResultType(method, enforceDeletedFields(method, result))), serverInfo);
  },
  encodeErrorCode: (code) => code === -32002 ? -32602 : code,
  checkInboundEnvelope(material) {
    if (material.envelope === undefined)
      return "Request is missing the required _meta envelope for protocol revision 2026-07-28 (io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientCapabilities)";
    const parsed = buildSchemas2026().RequestMetaEnvelopeSchema.safeParse(material.envelope);
    if (!parsed.success)
      return `Invalid _meta envelope for protocol revision 2026-07-28: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`;
  }
};
var wireResultSchemasMemo;
function getWireResultSchemas() {
  if (wireResultSchemasMemo)
    return wireResultSchemasMemo;
  const s = buildSchemas2026();
  wireResultSchemasMemo = {
    "tools/call": s.CallToolResultSchema,
    "tools/list": s.ListToolsResultSchema,
    "prompts/get": s.GetPromptResultSchema,
    "prompts/list": s.ListPromptsResultSchema,
    "resources/list": s.ListResourcesResultSchema,
    "resources/templates/list": s.ListResourceTemplatesResultSchema,
    "resources/read": s.ReadResourceResultSchema,
    "completion/complete": s.CompleteResultSchema,
    "server/discover": s.DiscoverResultSchema
  };
  return wireResultSchemasMemo;
}
var MODERN_WIRE_REVISION = "2026-07-28";
function codecForVersion(version) {
  return version !== undefined && isModernProtocolVersion(version) ? rev2026Codec : rev2025Codec;
}
function classifiedWireEra(classification) {
  if (classification.revision !== undefined)
    return codecForVersion(classification.revision).era;
  return classification.era === "modern" ? rev2026Codec.era : rev2025Codec.era;
}
function isSpecRequestMethod(method) {
  return ALL_CODECS.some((codec) => codec.hasRequestMethod(method));
}
function isSpecNotificationMethod(method) {
  return ALL_CODECS.some((codec) => codec.hasNotificationMethod(method));
}
function isExtensionReusedRequestMethod(method) {
  return method === "tasks/get" || method === "tasks/cancel";
}
var ALL_CODECS = [rev2025Codec, rev2026Codec];
var schemas_exports = /* @__PURE__ */ __exportAll({
  AnnotationsSchema: () => AnnotationsSchema,
  AudioContentSchema: () => AudioContentSchema,
  BaseMetadataSchema: () => BaseMetadataSchema,
  BaseRequestParamsSchema: () => BaseRequestParamsSchema,
  BlobResourceContentsSchema: () => BlobResourceContentsSchema,
  BooleanSchemaSchema: () => BooleanSchemaSchema,
  CallToolRequestParamsSchema: () => CallToolRequestParamsSchema,
  CallToolRequestSchema: () => CallToolRequestSchema,
  CallToolResultSchema: () => CallToolResultSchema,
  CancelTaskRequestSchema: () => CancelTaskRequestSchema,
  CancelTaskResultSchema: () => CancelTaskResultSchema,
  CancelledNotificationParamsSchema: () => CancelledNotificationParamsSchema,
  CancelledNotificationSchema: () => CancelledNotificationSchema,
  ClientCapabilitiesSchema: () => ClientCapabilitiesSchema,
  ClientNotificationSchema: () => ClientNotificationSchema,
  ClientRequestSchema: () => ClientRequestSchema,
  ClientResultSchema: () => ClientResultSchema,
  ClientTasksCapabilitySchema: () => ClientTasksCapabilitySchema,
  CompatibilityCallToolResultSchema: () => CompatibilityCallToolResultSchema,
  CompleteRequestParamsSchema: () => CompleteRequestParamsSchema,
  CompleteRequestSchema: () => CompleteRequestSchema,
  CompleteResultSchema: () => CompleteResultSchema,
  ContentBlockSchema: () => ContentBlockSchema,
  CreateMessageRequestParamsSchema: () => CreateMessageRequestParamsSchema,
  CreateMessageRequestSchema: () => CreateMessageRequestSchema,
  CreateMessageResultSchema: () => CreateMessageResultSchema,
  CreateMessageResultWithToolsSchema: () => CreateMessageResultWithToolsSchema,
  CreateTaskResultSchema: () => CreateTaskResultSchema,
  CursorSchema: () => CursorSchema,
  DiscoverRequestSchema: () => DiscoverRequestSchema,
  DiscoverResultSchema: () => DiscoverResultSchema,
  ElicitRequestFormParamsSchema: () => ElicitRequestFormParamsSchema,
  ElicitRequestParamsSchema: () => ElicitRequestParamsSchema,
  ElicitRequestSchema: () => ElicitRequestSchema,
  ElicitRequestURLParamsSchema: () => ElicitRequestURLParamsSchema,
  ElicitResultSchema: () => ElicitResultSchema,
  ElicitationCompleteNotificationParamsSchema: () => ElicitationCompleteNotificationParamsSchema,
  ElicitationCompleteNotificationSchema: () => ElicitationCompleteNotificationSchema,
  EmbeddedResourceSchema: () => EmbeddedResourceSchema,
  EmptyResultSchema: () => EmptyResultSchema,
  EnumSchemaSchema: () => EnumSchemaSchema,
  GetPromptRequestParamsSchema: () => GetPromptRequestParamsSchema,
  GetPromptRequestSchema: () => GetPromptRequestSchema,
  GetPromptResultSchema: () => GetPromptResultSchema,
  GetTaskPayloadRequestSchema: () => GetTaskPayloadRequestSchema,
  GetTaskPayloadResultSchema: () => GetTaskPayloadResultSchema,
  GetTaskRequestSchema: () => GetTaskRequestSchema,
  GetTaskResultSchema: () => GetTaskResultSchema,
  IconSchema: () => IconSchema,
  IconsSchema: () => IconsSchema,
  ImageContentSchema: () => ImageContentSchema,
  ImplementationSchema: () => ImplementationSchema,
  InitializeRequestParamsSchema: () => InitializeRequestParamsSchema,
  InitializeRequestSchema: () => InitializeRequestSchema,
  InitializeResultSchema: () => InitializeResultSchema,
  InitializedNotificationSchema: () => InitializedNotificationSchema,
  JSONArraySchema: () => JSONArraySchema,
  JSONObjectSchema: () => JSONObjectSchema,
  JSONRPCErrorResponseSchema: () => JSONRPCErrorResponseSchema,
  JSONRPCMessageSchema: () => JSONRPCMessageSchema,
  JSONRPCNotificationSchema: () => JSONRPCNotificationSchema,
  JSONRPCRequestSchema: () => JSONRPCRequestSchema,
  JSONRPCResponseSchema: () => JSONRPCResponseSchema,
  JSONRPCResultResponseSchema: () => JSONRPCResultResponseSchema,
  JSONValueSchema: () => JSONValueSchema,
  LegacyTitledEnumSchemaSchema: () => LegacyTitledEnumSchemaSchema,
  ListChangedOptionsBaseSchema: () => ListChangedOptionsBaseSchema,
  ListPromptsRequestSchema: () => ListPromptsRequestSchema,
  ListPromptsResultSchema: () => ListPromptsResultSchema,
  ListResourceTemplatesRequestSchema: () => ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema: () => ListResourceTemplatesResultSchema,
  ListResourcesRequestSchema: () => ListResourcesRequestSchema,
  ListResourcesResultSchema: () => ListResourcesResultSchema,
  ListRootsRequestSchema: () => ListRootsRequestSchema,
  ListRootsResultSchema: () => ListRootsResultSchema,
  ListTasksRequestSchema: () => ListTasksRequestSchema,
  ListTasksResultSchema: () => ListTasksResultSchema,
  ListToolsRequestSchema: () => ListToolsRequestSchema,
  ListToolsResultSchema: () => ListToolsResultSchema,
  LoggingLevelSchema: () => LoggingLevelSchema,
  LoggingMessageNotificationParamsSchema: () => LoggingMessageNotificationParamsSchema,
  LoggingMessageNotificationSchema: () => LoggingMessageNotificationSchema,
  ModelHintSchema: () => ModelHintSchema,
  ModelPreferencesSchema: () => ModelPreferencesSchema,
  MultiSelectEnumSchemaSchema: () => MultiSelectEnumSchemaSchema,
  NotificationSchema: () => NotificationSchema,
  NotificationsParamsSchema: () => NotificationsParamsSchema,
  NumberSchemaSchema: () => NumberSchemaSchema,
  PaginatedRequestParamsSchema: () => PaginatedRequestParamsSchema,
  PaginatedRequestSchema: () => PaginatedRequestSchema,
  PaginatedResultSchema: () => PaginatedResultSchema,
  PingRequestSchema: () => PingRequestSchema,
  PrimitiveSchemaDefinitionSchema: () => PrimitiveSchemaDefinitionSchema,
  ProgressNotificationParamsSchema: () => ProgressNotificationParamsSchema,
  ProgressNotificationSchema: () => ProgressNotificationSchema,
  ProgressSchema: () => ProgressSchema,
  ProgressTokenSchema: () => ProgressTokenSchema,
  PromptArgumentSchema: () => PromptArgumentSchema,
  PromptListChangedNotificationSchema: () => PromptListChangedNotificationSchema,
  PromptMessageSchema: () => PromptMessageSchema,
  PromptReferenceSchema: () => PromptReferenceSchema,
  PromptSchema: () => PromptSchema,
  ReadResourceRequestParamsSchema: () => ReadResourceRequestParamsSchema,
  ReadResourceRequestSchema: () => ReadResourceRequestSchema,
  ReadResourceResultSchema: () => ReadResourceResultSchema,
  RelatedTaskMetadataSchema: () => RelatedTaskMetadataSchema,
  RequestIdSchema: () => RequestIdSchema,
  RequestMetaSchema: () => RequestMetaSchema,
  RequestSchema: () => RequestSchema,
  ResourceContentsSchema: () => ResourceContentsSchema,
  ResourceLinkSchema: () => ResourceLinkSchema,
  ResourceListChangedNotificationSchema: () => ResourceListChangedNotificationSchema,
  ResourceRequestParamsSchema: () => ResourceRequestParamsSchema,
  ResourceSchema: () => ResourceSchema,
  ResourceTemplateReferenceSchema: () => ResourceTemplateReferenceSchema,
  ResourceTemplateSchema: () => ResourceTemplateSchema,
  ResourceUpdatedNotificationParamsSchema: () => ResourceUpdatedNotificationParamsSchema,
  ResourceUpdatedNotificationSchema: () => ResourceUpdatedNotificationSchema,
  ResultMetaObjectSchema: () => ResultMetaObjectSchema,
  ResultSchema: () => ResultSchema,
  RoleSchema: () => RoleSchema,
  RootSchema: () => RootSchema,
  RootsListChangedNotificationSchema: () => RootsListChangedNotificationSchema,
  SamplingContentSchema: () => SamplingContentSchema,
  SamplingMessageContentBlockSchema: () => SamplingMessageContentBlockSchema,
  SamplingMessageSchema: () => SamplingMessageSchema,
  ServerCapabilitiesSchema: () => ServerCapabilitiesSchema,
  ServerNotificationSchema: () => ServerNotificationSchema,
  ServerRequestSchema: () => ServerRequestSchema,
  ServerResultSchema: () => ServerResultSchema,
  ServerTasksCapabilitySchema: () => ServerTasksCapabilitySchema,
  SetLevelRequestParamsSchema: () => SetLevelRequestParamsSchema,
  SetLevelRequestSchema: () => SetLevelRequestSchema,
  SingleSelectEnumSchemaSchema: () => SingleSelectEnumSchemaSchema,
  StringSchemaSchema: () => StringSchemaSchema,
  SubscribeRequestParamsSchema: () => SubscribeRequestParamsSchema,
  SubscribeRequestSchema: () => SubscribeRequestSchema,
  SubscriptionFilterSchema: () => SubscriptionFilterSchema,
  SubscriptionsAcknowledgedNotificationParamsSchema: () => SubscriptionsAcknowledgedNotificationParamsSchema,
  SubscriptionsAcknowledgedNotificationSchema: () => SubscriptionsAcknowledgedNotificationSchema,
  SubscriptionsListenRequestParamsSchema: () => SubscriptionsListenRequestParamsSchema,
  SubscriptionsListenRequestSchema: () => SubscriptionsListenRequestSchema,
  SubscriptionsListenResultMetaSchema: () => SubscriptionsListenResultMetaSchema,
  SubscriptionsListenResultSchema: () => SubscriptionsListenResultSchema,
  TaskAugmentedRequestParamsSchema: () => TaskAugmentedRequestParamsSchema,
  TaskCreationParamsSchema: () => TaskCreationParamsSchema,
  TaskMetadataSchema: () => TaskMetadataSchema,
  TaskSchema: () => TaskSchema,
  TaskStatusNotificationParamsSchema: () => TaskStatusNotificationParamsSchema,
  TaskStatusNotificationSchema: () => TaskStatusNotificationSchema,
  TaskStatusSchema: () => TaskStatusSchema,
  TextContentSchema: () => TextContentSchema,
  TextResourceContentsSchema: () => TextResourceContentsSchema,
  TitledMultiSelectEnumSchemaSchema: () => TitledMultiSelectEnumSchemaSchema,
  TitledSingleSelectEnumSchemaSchema: () => TitledSingleSelectEnumSchemaSchema,
  ToolAnnotationsSchema: () => ToolAnnotationsSchema,
  ToolChoiceSchema: () => ToolChoiceSchema,
  ToolExecutionSchema: () => ToolExecutionSchema,
  ToolListChangedNotificationSchema: () => ToolListChangedNotificationSchema,
  ToolResultContentSchema: () => ToolResultContentSchema,
  ToolSchema: () => ToolSchema,
  ToolUseContentSchema: () => ToolUseContentSchema,
  UnsubscribeRequestParamsSchema: () => UnsubscribeRequestParamsSchema,
  UnsubscribeRequestSchema: () => UnsubscribeRequestSchema,
  UntitledMultiSelectEnumSchemaSchema: () => UntitledMultiSelectEnumSchemaSchema,
  UntitledSingleSelectEnumSchemaSchema: () => UntitledSingleSelectEnumSchemaSchema
});
var isJSONRPCRequest = (value) => JSONRPCRequestSchema.safeParse(value).success;
var isJSONRPCNotification = (value) => JSONRPCNotificationSchema.safeParse(value).success;
var isJSONRPCResultResponse = (value) => JSONRPCResultResponseSchema.safeParse(value).success;
var isJSONRPCErrorResponse = (value) => JSONRPCErrorResponseSchema.safeParse(value).success;
var isInputRequiredResult = (value) => typeof value === "object" && value !== null && !Array.isArray(value) && value.resultType === "input_required";
var isInitializeRequest = (value) => InitializeRequestSchema.safeParse(value).success;
var isInitializedNotification = (value) => InitializedNotificationSchema.safeParse(value).success;
var MCP_PARAM_HEADER_PREFIX = "Mcp-Param-";
var X_MCP_HEADER_KEY = "x-mcp-header";
var RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
var PERMITTED_X_MCP_HEADER_TYPES = new Set([
  "string",
  "integer",
  "boolean"
]);
function scanXMcpHeaderDeclarations(inputSchema) {
  const declarations = [];
  const seenLower = /* @__PURE__ */ new Map;
  let numberFault;
  const visit = (node, path, reachable) => {
    if (node === null || typeof node !== "object")
      return;
    const schema = node;
    if (X_MCP_HEADER_KEY in schema) {
      if (!reachable || path.length === 0)
        return `${pathName(path)}: x-mcp-header is only permitted on properties statically reachable via a chain of 'properties' keys (not under items, additionalProperties, oneOf/anyOf/allOf/not, if/then/else, or $ref)`;
      const raw = schema[X_MCP_HEADER_KEY];
      if (typeof raw !== "string" || raw.length === 0)
        return `${pathName(path)}: x-mcp-header MUST be a non-empty string`;
      if (!RFC9110_TOKEN.test(raw))
        return `${pathName(path)}: x-mcp-header '${raw}' is not a valid RFC 9110 token (no spaces, control characters or HTTP delimiters)`;
      const type = typeof schema.type === "string" ? schema.type : undefined;
      if (type === undefined || !PERMITTED_X_MCP_HEADER_TYPES.has(type)) {
        const fault$1 = `${pathName(path)}: x-mcp-header is only permitted on primitive-typed properties (string, integer, boolean); got ${type ?? "<none>"}`;
        if (type !== "number")
          return fault$1;
        numberFault ??= fault$1;
      }
      const lower = raw.toLowerCase();
      const prior = seenLower.get(lower);
      if (prior !== undefined)
        return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
      seenLower.set(lower, raw);
      declarations.push({
        path,
        headerName: raw,
        type
      });
    }
    const properties = schema.properties;
    if (properties !== null && typeof properties === "object")
      for (const [key, child] of Object.entries(properties)) {
        const fault$1 = visit(child, [...path, key], reachable);
        if (fault$1 !== undefined)
          return fault$1;
      }
    for (const k of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
      const sub = schema[k];
      if (sub === undefined)
        continue;
      const branches = Array.isArray(sub) ? sub : sub !== null && typeof sub === "object" && OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(k) ? Object.values(sub) : [sub];
      for (const branch of branches) {
        const fault$1 = visit(branch, [...path, `<${k}>`], false);
        if (fault$1 !== undefined)
          return fault$1;
      }
    }
  };
  const fault = visit(inputSchema, [], true);
  if (fault !== undefined)
    return {
      valid: false,
      reason: numberFault ?? fault
    };
  return numberFault === undefined ? {
    valid: true,
    declarations
  } : {
    valid: false,
    reason: numberFault,
    declarations
  };
}
var NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions"
];
var OBJECT_VALUED_SUBSCHEMA_KEYWORDS = new Set([
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions"
]);
function pathName(path) {
  return path.length === 0 ? "<root>" : path.join(".");
}
var BASE64_SENTINEL_PREFIX = "=?base64?";
var BASE64_SENTINEL_SUFFIX = "?=";
function mcpParamPrimitiveToString(value) {
  if (typeof value === "string")
    return value;
  if (typeof value === "boolean")
    return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return;
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      return;
    return String(value);
  }
}
function needsBase64(s) {
  if (s.length === 0)
    return true;
  if (s.startsWith(BASE64_SENTINEL_PREFIX) && s.endsWith(BASE64_SENTINEL_SUFFIX))
    return true;
  if (s !== s.trim())
    return true;
  for (let i = 0;i < s.length; i++) {
    const c = s.codePointAt(i);
    if (c === 9 || c >= 32 && c <= 126)
      continue;
    return true;
  }
  return false;
}
function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes)
    bin += String.fromCodePoint(b);
  return btoa(bin);
}
function encodeMcpParamValue(value) {
  return needsBase64(value) ? `${BASE64_SENTINEL_PREFIX}${utf8ToBase64(value)}${BASE64_SENTINEL_SUFFIX}` : value;
}
function valueAtPath(root, path) {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== "object")
      return;
    node = node[key];
  }
  return node;
}
function buildMcpParamHeaders(declarations, args) {
  const out = {};
  for (const decl of declarations) {
    const raw = valueAtPath(args, decl.path);
    if (raw === undefined || raw === null)
      continue;
    const stringValue = mcpParamPrimitiveToString(raw);
    if (stringValue === undefined)
      continue;
    out[`${MCP_PARAM_HEADER_PREFIX}${decl.headerName}`] = encodeMcpParamValue(stringValue);
  }
  return out;
}
var HEADER_MISMATCH_ERROR_CODE = -32020;
var INBOUND_VALIDATION_LADDER = [
  {
    rung: "http-method",
    order: 1,
    evaluatedAt: "edge",
    codes: [-32000],
    conformance: [],
    rationale: "The modern era is POST-only; GET/DELETE are body-less 2025-era session operations and are method-routed to legacy serving (405 when legacy serving is not configured), before any body is read."
  },
  {
    rung: "jsonrpc-shape",
    order: 2,
    evaluatedAt: "edge",
    codes: [ProtocolErrorCode.InvalidRequest],
    conformance: ["server-stateless"],
    rationale: "The body must be a JSON-RPC request or notification: posted responses and batch arrays containing a modern or invalid element are rejected before classification (element-wise batch rule); all-legacy arrays stay legacy traffic."
  },
  {
    rung: "era-classification",
    order: 3,
    evaluatedAt: "edge",
    codes: [HEADER_MISMATCH_ERROR_CODE, ProtocolErrorCode.UnsupportedProtocolVersion],
    conformance: [
      "server-stateless",
      "http-header-validation",
      "http-custom-header-server-validation"
    ],
    rationale: "Body-primary era classification with the protocol-version header as a cross-check; a header/body disagreement is rejected with -32020 (HeaderMismatch), and an envelope-less request on a modern-only endpoint is answered with the unsupported-protocol-version error naming the supported revisions."
  },
  {
    rung: "envelope",
    order: 4,
    evaluatedAt: "edge",
    codes: [ProtocolErrorCode.InvalidParams],
    conformance: ["server-stateless"],
    rationale: "A present envelope claim with a malformed envelope — and a missing envelope on a request whose protocol-version header names a modern revision — is an invalid-params rejection naming the offending or missing key(s); never a silent fall back to legacy handling. This is the only place an invalid-params rejection maps to HTTP 400."
  },
  {
    rung: "method-registry",
    order: 5,
    evaluatedAt: "dispatch",
    codes: [ProtocolErrorCode.MethodNotFound],
    conformance: ["server-stateless"],
    rationale: "Method existence outranks parameter validity: a method absent from the negotiated revision’s registry (or with no handler installed) answers method-not-found before params or capabilities are looked at."
  },
  {
    rung: "request-params",
    order: 6,
    evaluatedAt: "dispatch",
    codes: [ProtocolErrorCode.InvalidParams],
    conformance: [],
    rationale: "Per-method params validation; emitted in-band by the dispatch layer (HTTP 200), never via the ladder status table."
  },
  {
    rung: "standard-header-validation",
    order: 7,
    evaluatedAt: "pre-dispatch",
    codes: [HEADER_MISMATCH_ERROR_CODE],
    conformance: ["http-header-validation"],
    rationale: "SEP-2243 standard `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers — presence, sentinel decoding, and `Mcp-Name` ↔ body cross-check — are validated by the HTTP entry on a modern-classified request after the supported-revision gate and before dispatch. The spec requires `MCP-Protocol-Version` and `Mcp-Method` on every modern *request* POST (`Mcp-Name` only for the methods that mirror `params.name` / `params.uri` / `params.taskId`, see `MCP_NAME_HEADER_SOURCE`) and names them in that order, so a request missing several is answered by the earliest. Notification POSTs are exempt: the presence half runs on requests only, so a modern-enveloped notification is dispatched even with no standard headers at all. The classifier’s own header-mismatch cells (protocol-version, `Mcp-Method` mismatch) stay on the edge `era-classification` rung; this rung carries the entry-layer presence/`Mcp-Name` half — including the missing `MCP-Protocol-Version` cell, which cannot live on the edge rung without breaking body-primary classification. Evaluated before the capability gate, the factory call, and the `Mcp-Param-*` rung so a request that fails several rungs is answered by the standard-header rung first. The documented order (after method-registry 5 and request-params 6) is NOT the observed precedence: serveModern evaluates this rung immediately after the supported-revision gate, so a request that also fails a dispatch rung is answered here before the dispatch rungs (5–6) are consulted."
  },
  {
    rung: "client-capabilities",
    order: 8,
    evaluatedAt: "pre-dispatch",
    codes: [ProtocolErrorCode.MissingRequiredClientCapability],
    conformance: ["server-stateless"],
    rationale: "The capability requirement is checked by the HTTP entry, pre-dispatch, against the validated envelope the classifier produced — pinning the spec-mandated HTTP 400 independently of how dispatch- and handler-produced errors are mapped. The documented order (after method resolution and params validation) is preserved observably only while the requirement table is empty: once a served method gains a requirement entry, a request that is missing the capability and would also fail a dispatch rung is answered by this gate first, so the entry must consult the method registry before the gate if the documented precedence is to stay observable."
  },
  {
    rung: "param-header-validation",
    order: 9,
    evaluatedAt: "pre-dispatch",
    codes: [HEADER_MISMATCH_ERROR_CODE],
    conformance: ["http-custom-header-server-validation"],
    rationale: "SEP-2243 `Mcp-Param-*` headers are validated against the named tool’s `x-mcp-header` declarations and the body `arguments` after the tool registry is known and before dispatch reaches the handler; a missing/disagreeing/malformed header is rejected 400 / -32020 with the same shape as the standard-header cross-checks. The documented order (after method resolution and params validation) is preserved observably only when the body `arguments` would otherwise validate: the check runs pre-dispatch, so a `tools/call` that fails BOTH this rung and a dispatch-time rung (e.g. order-6 `request-params`, -32602) is answered by this gate first with 400 / -32020, not by the earlier-ordered rung."
  }
];
var LADDER_ERROR_HTTP_STATUS = {
  [ProtocolErrorCode.ParseError]: 400,
  [ProtocolErrorCode.InvalidRequest]: 400,
  [ProtocolErrorCode.MethodNotFound]: 404,
  [ProtocolErrorCode.UnsupportedProtocolVersion]: 400,
  [ProtocolErrorCode.MissingRequiredClientCapability]: 400,
  [HEADER_MISMATCH_ERROR_CODE]: 400
};
var MCP_NAME_HEADER_SOURCE = {
  "tools/call": "name",
  "prompts/get": "name",
  "resources/read": "uri",
  "tasks/get": "taskId",
  "tasks/update": "taskId",
  "tasks/cancel": "taskId"
};
function mcpNameSource(method, params) {
  const field = Object.hasOwn(MCP_NAME_HEADER_SOURCE, method) ? MCP_NAME_HEADER_SOURCE[method] : undefined;
  if (field === undefined)
    return;
  const raw = isPlainObject$2(params) ? params[field] : undefined;
  return {
    field,
    value: typeof raw === "string" ? raw : undefined
  };
}
function isPlainObject$2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parseSchema(schema, data) {
  return safeParse(schema, data);
}
function shapeKeys(schemas) {
  return new Set(schemas.flatMap((schema) => Object.keys(schema.shape)));
}
function isStandardSchema(schema) {
  if (schema == null)
    return false;
  const schemaType = typeof schema;
  if (schemaType !== "object" && schemaType !== "function")
    return false;
  if (!("~standard" in schema))
    return false;
  return typeof schema["~standard"]?.validate === "function";
}
var warnedZodFallback = false;
var JSON_SCHEMA_CONVERSION_TARGET = "draft-2020-12";
function standardSchemaToJsonSchema(schema, io = "input") {
  const std = schema["~standard"];
  let result;
  if (std.jsonSchema)
    result = std.jsonSchema[io]({ target: JSON_SCHEMA_CONVERSION_TARGET });
  else if (std.vendor === "zod") {
    if (!("_zod" in schema))
      throw new Error("Schema appears to be from zod 3, which the SDK cannot convert to JSON Schema. Upgrade to zod >=4.2.0, or wrap your JSON Schema with fromJsonSchema().");
    if (!warnedZodFallback) {
      warnedZodFallback = true;
      console.warn("[mcp-sdk] Your zod version does not implement `~standard.jsonSchema` (added in zod 4.2.0). Falling back to z.toJSONSchema(). Upgrade to zod >=4.2.0 to silence this warning.");
    }
    result = toJSONSchema(schema, {
      target: JSON_SCHEMA_CONVERSION_TARGET,
      io
    });
  } else
    throw new Error(`Schema library "${std.vendor}" does not implement StandardJSONSchemaV1 (\`~standard.jsonSchema\`). Upgrade to a version that does, or wrap your JSON Schema with fromJsonSchema().`);
  if (io === "output") {
    if (result.type !== undefined)
      return result;
    return isProvablyObjectShapedRoot(result) ? {
      type: "object",
      ...result
    } : result;
  }
  if (result.type !== undefined && result.type !== "object")
    throw new Error(`MCP tool and prompt schemas must describe objects (got type: ${JSON.stringify(result.type)}). Wrap your schema in z.object({...}) or equivalent.`);
  return {
    type: "object",
    ...result
  };
}
var LOCAL_DEFINITION_REF = /^#\/(\$defs|definitions)\/([^/~%]+)$/;
function isProvablyObjectShapedRoot(schema, root = schema) {
  if ("properties" in schema || "patternProperties" in schema || "additionalProperties" in schema || "required" in schema)
    return true;
  const ref = typeof schema.$ref === "string" && LOCAL_DEFINITION_REF.exec(schema.$ref);
  if (ref && root[ref[1]]?.[ref[2]]?.type === "object")
    return true;
  for (const key of [
    "oneOf",
    "anyOf",
    "allOf"
  ]) {
    const members = schema[key];
    if (Array.isArray(members) && members.length > 0)
      return members.every((m) => m !== null && typeof m === "object" && (m.type === "object" || isProvablyObjectShapedRoot(m, "$id" in m ? {} : root)));
  }
  return false;
}
function formatIssue(issue) {
  if (!issue.path?.length)
    return issue.message;
  return `${issue.path.map((p) => String(typeof p === "object" ? p.key : p)).join(".")}: ${issue.message}`;
}
async function validateStandardSchema(schema, data) {
  const result = await schema["~standard"].validate(data);
  if (result.issues && result.issues.length > 0)
    return {
      success: false,
      error: result.issues.map((i) => formatIssue(i)).join(", ")
    };
  return {
    success: true,
    data: result.value
  };
}
function zodEmittedPattern(schema) {
  const jsonSchema = toJSONSchema(schema, {
    target: JSON_SCHEMA_CONVERSION_TARGET,
    io: "input"
  });
  return typeof jsonSchema.pattern === "string" ? jsonSchema.pattern : undefined;
}
var DATETIME_FRACTION_DIGITS = /\\\.\\d\{(\d+)\}/;
function datetimeReferenceSchemas(pattern) {
  const fractionDigits = DATETIME_FRACTION_DIGITS.exec(pattern);
  const precisions = [
    undefined,
    -1,
    0
  ];
  if (fractionDigits)
    precisions.push(Number(fractionDigits[1]));
  return [false, true].flatMap((local) => [false, true].flatMap((offset) => precisions.map((precision) => datetime2({
    local,
    offset,
    precision
  }))));
}
function referencePatternsForFormat(format, pattern) {
  let referenceSchemas;
  switch (format) {
    case "email":
      referenceSchemas = [email2()];
      break;
    case "uri":
      referenceSchemas = [url()];
      break;
    case "date":
      referenceSchemas = [date2()];
      break;
    case "date-time":
      referenceSchemas = datetimeReferenceSchemas(pattern);
      break;
  }
  return new Set(referenceSchemas.map((schema) => zodEmittedPattern(schema)).filter((emitted) => emitted !== undefined));
}
function isLibraryFormatPattern(format, pattern, vendor) {
  if (vendor !== "zod")
    return true;
  return referencePatternsForFormat(format, pattern).has(pattern);
}
function isJsonObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function convertStandardElicitationSchema(schema) {
  try {
    return standardSchemaToJsonSchema(schema, "input");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema must describe an object with flat primitive properties: ${detail}`);
  }
}
var ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS = new Set([
  "$comment",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly"
]);
function isAnnotationOnlyJsonSchemaKeyword(key) {
  return ANNOTATION_ONLY_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith("x-");
}
var ROOT_KEYS = new Set(["$schema", ...Object.keys(ElicitRequestFormParamsSchema.shape.requestedSchema.shape)]);
var PROPERTY_KEYS_BY_TYPE = {
  string: shapeKeys([
    StringSchemaSchema,
    UntitledSingleSelectEnumSchemaSchema,
    TitledSingleSelectEnumSchemaSchema,
    LegacyTitledEnumSchemaSchema
  ]),
  number: shapeKeys([NumberSchemaSchema]),
  integer: shapeKeys([NumberSchemaSchema]),
  boolean: shapeKeys([BooleanSchemaSchema]),
  array: shapeKeys([UntitledMultiSelectEnumSchemaSchema, TitledMultiSelectEnumSchemaSchema])
};
var SUPPORTED_STRING_FORMATS = new Set(StringSchemaSchema.shape.format.unwrap().options);
function walkProperty(node, path, vendor, unsupported) {
  if (!isJsonObject(node))
    return node;
  const allowedKeys = typeof node.type === "string" && Object.hasOwn(PROPERTY_KEYS_BY_TYPE, node.type) ? PROPERTY_KEYS_BY_TYPE[node.type] : undefined;
  if (allowedKeys === undefined)
    return node;
  const pruned = {};
  for (const [key, value] of Object.entries(node))
    if (allowedKeys.has(key) || isAnnotationOnlyJsonSchemaKeyword(key))
      pruned[key] = value;
    else if (key === "pattern" && node.type === "string" && typeof node.format === "string") {
      if (!SUPPORTED_STRING_FORMATS.has(node.format))
        pruned[key] = value;
      else if (typeof value !== "string" || !isLibraryFormatPattern(node.format, value, vendor))
        unsupported.push(`${path}.${key}`);
    } else
      unsupported.push(`${path}.${key}`);
  return pruned;
}
function walkRequestedSchema(converted, vendor) {
  const pruned = {};
  const unsupported = [];
  for (const [key, value] of Object.entries(converted))
    if (key === "properties" && isJsonObject(value))
      pruned[key] = Object.fromEntries(Object.entries(value).map(([name, node]) => [name, walkProperty(node, `properties.${name}`, vendor, unsupported)]));
    else if (ROOT_KEYS.has(key))
      pruned[key] = value;
    else if (!isAnnotationOnlyJsonSchemaKeyword(key))
      unsupported.push(key);
  if (unsupported.length > 0)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${unsupported.join(", ")}`);
  return pruned;
}
function describeUnsupportedProperties(pruned, fallback) {
  if (!isJsonObject(pruned.properties))
    return fallback;
  const offenders = Object.entries(pruned.properties).filter(([, node]) => !parseSchema(PrimitiveSchemaDefinitionSchema, node).success).map(([name]) => `properties.${name}`);
  return offenders.length > 0 ? offenders.join(", ") : fallback;
}
function findDroppedConstraintPaths(original, parsed, path = "") {
  if (Array.isArray(original) && Array.isArray(parsed))
    return original.flatMap((item, index) => findDroppedConstraintPaths(item, parsed[index], `${path}[${index}]`));
  if (!isJsonObject(original) || !isJsonObject(parsed))
    return [];
  return Object.entries(original).flatMap(([key, value]) => {
    const childPath = path ? `${path}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(parsed, key))
      return isAnnotationOnlyJsonSchemaKeyword(key) ? [] : [childPath];
    return findDroppedConstraintPaths(value, parsed[key], childPath);
  });
}
function normalizeElicitInputParams(input) {
  if (!isStandardSchema(input.requestedSchema))
    return {
      ...input,
      mode: "form",
      requestedSchema: input.requestedSchema
    };
  const vendor = input.requestedSchema["~standard"].vendor;
  const pruned = walkRequestedSchema(convertStandardElicitationSchema(input.requestedSchema), vendor);
  const parsed = parseSchema(ElicitRequestFormParamsSchema.shape.requestedSchema, pruned);
  if (!parsed.success)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema only supports flat primitive properties (string, number, integer, boolean, and string enums): ${describeUnsupportedProperties(pruned, parsed.error.message)}`);
  const droppedConstraints = findDroppedConstraintPaths(pruned, parsed.data);
  if (droppedConstraints.length > 0)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema contains unsupported JSON Schema constraint(s) after Standard Schema conversion: ${droppedConstraints.join(", ")}`);
  const danglingRequired = (parsed.data.required ?? []).filter((key) => !Object.prototype.hasOwnProperty.call(parsed.data.properties, key));
  if (danglingRequired.length > 0)
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Elicitation requestedSchema lists required properties that are not defined in properties: ${danglingRequired.join(", ")}`);
  return {
    ...input,
    mode: "form",
    requestedSchema: parsed.data
  };
}
function buildInputRequired(spec) {
  const hasInputRequests = spec.inputRequests !== undefined && Object.keys(spec.inputRequests).length > 0;
  const hasRequestState = typeof spec.requestState === "string";
  if (!hasInputRequests && !hasRequestState)
    throw new TypeError("inputRequired() requires at least one of inputRequests (with at least one entry) or requestState (spec: every InputRequiredResult MUST include at least one of the two)");
  return {
    resultType: "input_required",
    ...spec.inputRequests !== undefined && { inputRequests: spec.inputRequests },
    ...spec.requestState !== undefined && { requestState: spec.requestState }
  };
}
var inputRequired = Object.assign(buildInputRequired, {
  elicit(params) {
    try {
      return {
        method: "elicitation/create",
        params: normalizeElicitInputParams(params)
      };
    } catch (error) {
      throw error instanceof ProtocolError ? new TypeError(error.message, { cause: error }) : error;
    }
  },
  elicitUrl(params) {
    return {
      method: "elicitation/create",
      params: {
        ...params,
        mode: "url"
      }
    };
  },
  createMessage(params) {
    return {
      method: "sampling/createMessage",
      params
    };
  },
  listRoots() {
    return { method: "roots/list" };
  }
});
var DEFAULT_INPUT_REQUIRED_AUTO_FULFILL = true;
var DEFAULT_INPUT_REQUIRED_MAX_ROUNDS = 10;
var REQUEST_STATE_ONLY_LEG_PACING_MS = 250;
function resolveInputRequiredDriverConfig(options) {
  return {
    autoFulfill: options?.autoFulfill ?? DEFAULT_INPUT_REQUIRED_AUTO_FULFILL,
    maxRounds: options?.maxRounds ?? DEFAULT_INPUT_REQUIRED_MAX_ROUNDS
  };
}
function buildInputRequiredRetryParams(originalParams, responses, requestState) {
  const hasResponses = responses !== undefined && Object.keys(responses).length > 0;
  if (!hasResponses && requestState === undefined)
    return originalParams;
  return {
    ...originalParams,
    ...hasResponses && { inputResponses: responses },
    ...requestState !== undefined && { requestState }
  };
}
function inputRequiredRoundsExceededMessage(method, maxRounds) {
  return `Multi-round-trip request '${method}' still required input after ${maxRounds} rounds (inputRequired.maxRounds)`;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal.reason)));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof SdkError ? signal.reason : new SdkError(SdkErrorCode.RequestTimeout, String(signal?.reason)));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function linkedRoundAbort(outer) {
  const controller = new AbortController;
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener("abort", onOuterAbort, { once: true });
  if (outer?.aborted)
    controller.abort(outer.reason);
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => outer?.removeEventListener("abort", onOuterAbort)
  };
}
async function runInputRequiredDriver(args) {
  const { config, method, originalParams, requestOptions, hooks, signal } = args;
  const startedAt = args.flowStartedAt ?? Date.now();
  let payload = args.firstPayload;
  let round = 0;
  while (true) {
    round += 1;
    if (round > config.maxRounds)
      throw new SdkError(SdkErrorCode.InputRequiredRoundsExceeded, inputRequiredRoundsExceededMessage(method, config.maxRounds), {
        rounds: config.maxRounds,
        lastResult: {
          inputRequests: payload.inputRequests,
          ...payload.requestState !== undefined && { requestState: payload.requestState }
        }
      });
    requestOptions.onprogress?.({
      progress: round,
      message: `Fulfilling input required by '${method}' (round ${round})`
    });
    const entries = Object.entries(payload.inputRequests ?? {});
    let responses;
    if (entries.length > 0) {
      const round$1 = linkedRoundAbort(signal);
      try {
        const fulfilled = await Promise.all(entries.map(async ([key, entry]) => {
          try {
            return [key, await hooks.dispatchInputRequest(key, entry, round$1.signal)];
          } catch (error) {
            round$1.abort(error);
            throw error;
          }
        }));
        responses = Object.fromEntries(fulfilled);
      } finally {
        round$1.dispose();
      }
    } else
      await sleep(REQUEST_STATE_ONLY_LEG_PACING_MS, signal);
    const legOptions = { ...requestOptions.timeout !== undefined && { timeout: requestOptions.timeout } };
    if (requestOptions.maxTotalTimeout !== undefined) {
      const totalElapsed = Date.now() - startedAt;
      const remaining = requestOptions.maxTotalTimeout - totalElapsed;
      if (remaining <= 0)
        throw new SdkError(SdkErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
          maxTotalTimeout: requestOptions.maxTotalTimeout,
          totalElapsed
        });
      legOptions.maxTotalTimeout = remaining;
    }
    const result = await hooks.retry(buildInputRequiredRetryParams(originalParams, responses, payload.requestState), legOptions);
    if (isInputRequiredResult(result)) {
      payload = {
        inputRequests: result.inputRequests ?? {},
        ...result.requestState !== undefined && { requestState: result.requestState }
      };
      continue;
    }
    return result;
  }
}
var SPEC_SCHEMA_KEYS = [
  "AnnotationsSchema",
  "AudioContentSchema",
  "BaseMetadataSchema",
  "BlobResourceContentsSchema",
  "BooleanSchemaSchema",
  "CallToolRequestSchema",
  "CallToolRequestParamsSchema",
  "CallToolResultSchema",
  "CancelledNotificationSchema",
  "CancelledNotificationParamsSchema",
  "CancelTaskRequestSchema",
  "CancelTaskResultSchema",
  "ClientCapabilitiesSchema",
  "ClientNotificationSchema",
  "ClientRequestSchema",
  "ClientResultSchema",
  "CompatibilityCallToolResultSchema",
  "CompleteRequestSchema",
  "CompleteRequestParamsSchema",
  "CompleteResultSchema",
  "ContentBlockSchema",
  "CreateMessageRequestSchema",
  "CreateMessageRequestParamsSchema",
  "CreateMessageResultSchema",
  "CreateMessageResultWithToolsSchema",
  "CreateTaskResultSchema",
  "CursorSchema",
  "DiscoverRequestSchema",
  "DiscoverResultSchema",
  "ElicitationCompleteNotificationSchema",
  "ElicitationCompleteNotificationParamsSchema",
  "ElicitRequestSchema",
  "ElicitRequestFormParamsSchema",
  "ElicitRequestParamsSchema",
  "ElicitRequestURLParamsSchema",
  "ElicitResultSchema",
  "EmbeddedResourceSchema",
  "EmptyResultSchema",
  "EnumSchemaSchema",
  "GetPromptRequestSchema",
  "GetPromptRequestParamsSchema",
  "GetPromptResultSchema",
  "GetTaskPayloadRequestSchema",
  "GetTaskPayloadResultSchema",
  "GetTaskRequestSchema",
  "GetTaskResultSchema",
  "IconSchema",
  "IconsSchema",
  "ImageContentSchema",
  "ImplementationSchema",
  "InitializedNotificationSchema",
  "InitializeRequestSchema",
  "InitializeRequestParamsSchema",
  "InitializeResultSchema",
  "JSONArraySchema",
  "JSONObjectSchema",
  "JSONRPCErrorResponseSchema",
  "JSONRPCMessageSchema",
  "JSONRPCNotificationSchema",
  "JSONRPCRequestSchema",
  "JSONRPCResponseSchema",
  "JSONRPCResultResponseSchema",
  "JSONValueSchema",
  "LegacyTitledEnumSchemaSchema",
  "ListPromptsRequestSchema",
  "ListPromptsResultSchema",
  "ListResourcesRequestSchema",
  "ListResourcesResultSchema",
  "ListResourceTemplatesRequestSchema",
  "ListResourceTemplatesResultSchema",
  "ListRootsRequestSchema",
  "ListRootsResultSchema",
  "ListTasksRequestSchema",
  "ListTasksResultSchema",
  "ListToolsRequestSchema",
  "ListToolsResultSchema",
  "LoggingLevelSchema",
  "LoggingMessageNotificationSchema",
  "LoggingMessageNotificationParamsSchema",
  "ModelHintSchema",
  "ModelPreferencesSchema",
  "MultiSelectEnumSchemaSchema",
  "NotificationSchema",
  "NumberSchemaSchema",
  "PaginatedRequestSchema",
  "PaginatedRequestParamsSchema",
  "PaginatedResultSchema",
  "PingRequestSchema",
  "PrimitiveSchemaDefinitionSchema",
  "ProgressSchema",
  "ProgressNotificationSchema",
  "ProgressNotificationParamsSchema",
  "ProgressTokenSchema",
  "PromptSchema",
  "PromptArgumentSchema",
  "PromptListChangedNotificationSchema",
  "PromptMessageSchema",
  "PromptReferenceSchema",
  "ReadResourceRequestSchema",
  "ReadResourceRequestParamsSchema",
  "ReadResourceResultSchema",
  "RelatedTaskMetadataSchema",
  "RequestSchema",
  "RequestIdSchema",
  "RequestMetaSchema",
  "ResourceSchema",
  "ResourceContentsSchema",
  "ResourceLinkSchema",
  "ResourceListChangedNotificationSchema",
  "ResourceRequestParamsSchema",
  "ResourceTemplateSchema",
  "ResourceTemplateReferenceSchema",
  "ResourceUpdatedNotificationSchema",
  "ResourceUpdatedNotificationParamsSchema",
  "ResultMetaObjectSchema",
  "ResultSchema",
  "RoleSchema",
  "RootSchema",
  "RootsListChangedNotificationSchema",
  "SamplingContentSchema",
  "SamplingMessageSchema",
  "SamplingMessageContentBlockSchema",
  "ServerCapabilitiesSchema",
  "ServerNotificationSchema",
  "ServerRequestSchema",
  "ServerResultSchema",
  "SetLevelRequestSchema",
  "SetLevelRequestParamsSchema",
  "SingleSelectEnumSchemaSchema",
  "StringSchemaSchema",
  "SubscribeRequestSchema",
  "SubscribeRequestParamsSchema",
  "SubscriptionFilterSchema",
  "SubscriptionsAcknowledgedNotificationSchema",
  "SubscriptionsAcknowledgedNotificationParamsSchema",
  "SubscriptionsListenRequestSchema",
  "SubscriptionsListenRequestParamsSchema",
  "SubscriptionsListenResultSchema",
  "SubscriptionsListenResultMetaSchema",
  "TaskAugmentedRequestParamsSchema",
  "TaskCreationParamsSchema",
  "TaskMetadataSchema",
  "TaskSchema",
  "TaskStatusSchema",
  "TaskStatusNotificationSchema",
  "TaskStatusNotificationParamsSchema",
  "TextContentSchema",
  "TextResourceContentsSchema",
  "TitledMultiSelectEnumSchemaSchema",
  "TitledSingleSelectEnumSchemaSchema",
  "ToolSchema",
  "ToolAnnotationsSchema",
  "ToolChoiceSchema",
  "ToolExecutionSchema",
  "ToolListChangedNotificationSchema",
  "ToolResultContentSchema",
  "ToolUseContentSchema",
  "UnsubscribeRequestSchema",
  "UnsubscribeRequestParamsSchema",
  "UntitledMultiSelectEnumSchemaSchema",
  "UntitledSingleSelectEnumSchemaSchema"
];
var authSchemas = {
  IdJagTokenExchangeResponseSchema,
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthClientMetadataSchema,
  OAuthClientRegistrationErrorSchema,
  OAuthErrorResponseSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokenRevocationRequestSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  OpenIdProviderMetadataSchema
};
var _specTypeSchemas = {};
var _isSpecType = {};
function register(key, schema) {
  const name = key.slice(0, -6);
  _specTypeSchemas[name] = schema;
  _isSpecType[name] = (v) => schema.safeParse(v).success;
}
for (const key of SPEC_SCHEMA_KEYS)
  register(key, schemas_exports[key]);
for (const [key, schema] of Object.entries(authSchemas))
  register(key, schema);
var specTypeSchemas = Object.freeze(_specTypeSchemas);
var isSpecType = Object.freeze(_isSpecType);
function bootstrapOutboundCodec(method) {
  switch (method) {
    case "initialize":
    case "notifications/initialized":
      return codecForVersion(undefined);
    case "server/discover":
      return codecForVersion(MODERN_WIRE_REVISION);
    default:
      return;
  }
}
var DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
var RESERVED_ENVELOPE_META_KEYS = [
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  LOG_LEVEL_META_KEY
];
var RETRY_PARAMS_KEYS = ["inputResponses", "requestState"];
function liftWireOnlyMaterial(message, kind) {
  const params = message.params;
  if (!isPlainObject$1(params))
    return {
      message,
      lifted: {}
    };
  const meta = params._meta;
  const envelopeKeys = isPlainObject$1(meta) ? RESERVED_ENVELOPE_META_KEYS.filter((key) => (key in meta)) : [];
  const retryKeys = kind === "request" ? RETRY_PARAMS_KEYS.filter((key) => (key in params)) : [];
  if (envelopeKeys.length === 0 && retryKeys.length === 0)
    return {
      message,
      lifted: {}
    };
  const lifted = {};
  const nextParams = { ...params };
  if (envelopeKeys.length > 0 && isPlainObject$1(meta)) {
    const envelope = {};
    const nextMeta = { ...meta };
    for (const key of envelopeKeys) {
      envelope[key] = meta[key];
      delete nextMeta[key];
    }
    lifted.envelope = envelope;
    if (Object.keys(nextMeta).length > 0)
      nextParams._meta = nextMeta;
    else
      delete nextParams._meta;
  }
  for (const key of retryKeys) {
    if (key === "inputResponses")
      lifted.inputResponses = nextParams[key];
    if (key === "requestState")
      lifted.requestState = nextParams[key];
    delete nextParams[key];
  }
  return {
    message: {
      ...message,
      params: nextParams
    },
    lifted
  };
}
function codecResultValidator(codec, method) {
  const probe = codec.validateResult(method, undefined);
  if (!probe.ok && probe.reason === "not-in-era")
    return;
  return { "~standard": {
    version: 1,
    vendor: "mcp-wire-codec",
    validate(value) {
      const outcome = codec.validateResult(method, value);
      if (outcome.ok)
        return { value: outcome.value };
      return { issues: [{ message: outcome.reason === "invalid" ? outcome.message : `not-in-era: ${method}` }] };
    }
  } };
}
function requestStateAccessor(value) {
  return () => value;
}
var NO_REQUEST_STATE = requestStateAccessor(undefined);
var writeNegotiatedProtocolVersion;
var Protocol = class {
  _transport;
  _requestMessageId = 0;
  _requestHandlers = /* @__PURE__ */ new Map;
  _customSchemaRequestMethods = /* @__PURE__ */ new Set;
  _requestHandlerAbortControllers = /* @__PURE__ */ new Map;
  _notificationHandlers = /* @__PURE__ */ new Map;
  _responseHandlers = /* @__PURE__ */ new Map;
  _progressHandlers = /* @__PURE__ */ new Map;
  _timeoutInfo = /* @__PURE__ */ new Map;
  _pendingDebouncedNotifications = /* @__PURE__ */ new Set;
  _negotiatedProtocolVersion;
  static {
    writeNegotiatedProtocolVersion = (instance, version) => {
      instance._negotiatedProtocolVersion = version;
    };
  }
  _supportedProtocolVersions;
  onclose;
  onerror;
  fallbackRequestHandler;
  fallbackNotificationHandler;
  constructor(_options) {
    this._options = _options;
    this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    this.setNotificationHandler("notifications/cancelled", (notification) => {
      this._oncancel(notification);
    });
    this.setNotificationHandler("notifications/progress", (notification) => {
      this._onprogress(notification);
    });
    this.setRequestHandler("ping", (_request) => ({}));
  }
  _shouldDropInbound(_message) {}
  _outboundMetaEnvelope() {}
  _envelopeOutbound(message) {
    const envelope = this._outboundMetaEnvelope();
    if (envelope === undefined)
      return message;
    const params = message.params ?? {};
    return {
      ...message,
      params: {
        ...params,
        _meta: {
          ...envelope,
          ...params._meta
        }
      }
    };
  }
  _resolveNonCompleteResult(decoded, flow) {
    return Promise.reject(new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${decoded.kind}' for ${flow.request.method}`, {
      resultType: decoded.kind,
      method: flow.request.method
    }));
  }
  _getRequestHandler(method) {
    return this._requestHandlers.get(method);
  }
  async _oncancel(notification) {
    if (notification.params.requestId === undefined)
      return;
    this._requestHandlerAbortControllers.get(notification.params.requestId)?.abort(notification.params.reason);
  }
  _setupTimeout(messageId, timeout, maxTotalTimeout, onTimeout, resetTimeoutOnProgress = false) {
    this._timeoutInfo.set(messageId, {
      timeoutId: setTimeout(onTimeout, timeout),
      startTime: Date.now(),
      timeout,
      maxTotalTimeout,
      resetTimeoutOnProgress,
      onTimeout
    });
  }
  _resetTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    if (!info)
      return false;
    const totalElapsed = Date.now() - info.startTime;
    if (info.maxTotalTimeout && totalElapsed >= info.maxTotalTimeout) {
      this._timeoutInfo.delete(messageId);
      throw new SdkError(SdkErrorCode.RequestTimeout, "Maximum total timeout exceeded", {
        maxTotalTimeout: info.maxTotalTimeout,
        totalElapsed
      });
    }
    clearTimeout(info.timeoutId);
    info.timeoutId = setTimeout(info.onTimeout, info.timeout);
    return true;
  }
  _cleanupTimeout(messageId) {
    const info = this._timeoutInfo.get(messageId);
    if (info) {
      clearTimeout(info.timeoutId);
      this._timeoutInfo.delete(messageId);
    }
  }
  async connect(transport) {
    this._transport = transport;
    const _onclose = this.transport?.onclose;
    this._transport.onclose = () => {
      try {
        _onclose?.();
      } finally {
        this._onclose();
      }
    };
    const _onerror = this.transport?.onerror;
    this._transport.onerror = (error) => {
      _onerror?.(error);
      this._onerror(error);
    };
    const _onmessage = this._transport?.onmessage;
    this._transport.onmessage = (message, extra) => {
      _onmessage?.(message, extra);
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))
        this._onresponse(message);
      else if (isJSONRPCRequest(message))
        this._onrequest(message, extra);
      else if (isJSONRPCNotification(message))
        this._onnotification(message, extra);
      else
        this._onerror(/* @__PURE__ */ new Error(`Unknown message type: ${JSON.stringify(message)}`));
    };
    transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions);
    await this._transport.start();
  }
  _onclose() {
    const responseHandlers = this._responseHandlers;
    this._responseHandlers = /* @__PURE__ */ new Map;
    this._progressHandlers.clear();
    this._pendingDebouncedNotifications.clear();
    for (const info of this._timeoutInfo.values())
      clearTimeout(info.timeoutId);
    this._timeoutInfo.clear();
    const requestHandlerAbortControllers = this._requestHandlerAbortControllers;
    this._requestHandlerAbortControllers = /* @__PURE__ */ new Map;
    const error = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
    this._transport = undefined;
    try {
      this.onclose?.();
    } finally {
      for (const handler of responseHandlers.values())
        handler(error);
      for (const controller of requestHandlerAbortControllers.values())
        controller.abort(error);
    }
  }
  _onerror(error) {
    this.onerror?.(error);
  }
  _onnotification(rawNotification, extra) {
    const { message: notification } = liftWireOnlyMaterial(rawNotification, "notification");
    const codec = this._negotiatedWireCodec();
    if (extra?.classification === undefined && this._shouldDropInbound(rawNotification) === "drop")
      return;
    if (extra?.classification !== undefined) {
      const classified = classifiedWireEra(extra.classification);
      if (classified !== codec.era) {
        this._onerror(/* @__PURE__ */ new Error(`Era mismatch on inbound notification '${notification.method}': classified as ${classified} but this instance serves ${codec.era}`));
        return;
      }
    }
    if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method))
      return;
    const handler = this._notificationHandlers.get(notification.method);
    const fallback = this.fallbackNotificationHandler;
    if (handler === undefined && fallback === undefined)
      return;
    Promise.resolve().then(() => handler === undefined ? fallback(notification) : handler(notification, codec)).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Uncaught error in notification handler: ${error}`)));
  }
  _onrequest(rawRequest, extra) {
    const { message: request, lifted } = liftWireOnlyMaterial(rawRequest, "request");
    const codec = this._negotiatedWireCodec();
    if (extra?.classification === undefined && this._shouldDropInbound(rawRequest) === "drop") {
      this._onerror(/* @__PURE__ */ new Error(`Dropped inbound request '${rawRequest.method}': not servable on this connection's protocol era`));
      return;
    }
    const capturedTransport = this._transport;
    const sendErrorResponse = (code, message, data) => {
      const errorResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code,
          message,
          ...data !== undefined && { data }
        }
      };
      capturedTransport?.send(errorResponse).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send an error response: ${error}`)));
    };
    if (extra?.classification !== undefined) {
      const classified = classifiedWireEra(extra.classification);
      if (classified !== codec.era) {
        this._onerror(/* @__PURE__ */ new Error(`Era mismatch on inbound request '${request.method}': classified as ${classified} but this instance serves ${codec.era}`));
        const requested = extra.classification.revision ?? classified;
        sendErrorResponse(ProtocolErrorCode.UnsupportedProtocolVersion, `Unsupported protocol version: ${requested}`, {
          supported: this._supportedProtocolVersions,
          requested
        });
        return;
      }
    }
    if (isSpecRequestMethod(request.method) && !codec.hasRequestMethod(request.method) && !(isExtensionReusedRequestMethod(request.method) && this._customSchemaRequestMethods.has(request.method))) {
      sendErrorResponse(ProtocolErrorCode.MethodNotFound, "Method not found");
      return;
    }
    const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;
    if (handler === undefined) {
      sendErrorResponse(ProtocolErrorCode.MethodNotFound, "Method not found");
      return;
    }
    const envelopeError = codec.checkInboundEnvelope(lifted);
    if (envelopeError !== undefined) {
      sendErrorResponse(ProtocolErrorCode.InvalidParams, envelopeError);
      return;
    }
    const sendNotification = (notification, options) => this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, {
      ...options,
      relatedRequestId: request.id
    });
    const sendRequest = (r, resultSchema, options) => this._requestWithSchemaViaCodec(this._resolveOutboundCodec(r.method), r, resultSchema, {
      ...options,
      relatedRequestId: request.id
    });
    const abortController = new AbortController;
    this._requestHandlerAbortControllers.set(request.id, abortController);
    const partitionedInputResponses = lifted.inputResponses === undefined ? undefined : partitionInputResponses(lifted.inputResponses);
    const baseCtx = {
      sessionId: capturedTransport?.sessionId,
      mcpReq: {
        id: request.id,
        method: request.method,
        _meta: request.params?._meta,
        ...lifted.envelope !== undefined && { envelope: lifted.envelope },
        ...partitionedInputResponses !== undefined && { inputResponses: partitionedInputResponses.accepted },
        ...partitionedInputResponses !== undefined && partitionedInputResponses.droppedKeys.length > 0 && { droppedInputResponseKeys: partitionedInputResponses.droppedKeys },
        requestState: lifted.requestState === undefined ? NO_REQUEST_STATE : requestStateAccessor(lifted.requestState),
        signal: abortController.signal,
        send: (r, schemaOrOptions, maybeOptions) => {
          const sendCodec = this._resolveOutboundCodec(r.method);
          this._assertOutboundRequestInEra(sendCodec, r.method);
          if (isStandardSchema(schemaOrOptions))
            return sendRequest(r, schemaOrOptions, maybeOptions);
          const validate = codecResultValidator(sendCodec, r.method);
          if (validate === undefined)
            throw new TypeError(`'${r.method}' is not a spec method; pass a result schema as the second argument to ctx.mcpReq.send().`);
          return sendRequest(r, validate, schemaOrOptions);
        },
        notify: sendNotification
      },
      http: extra?.authInfo ? { authInfo: extra.authInfo } : undefined
    };
    const ctx = this.buildContext(baseCtx, extra);
    Promise.resolve().then(() => handler(request, ctx)).then(async (result) => {
      if (abortController.signal.aborted)
        return;
      let encoded;
      try {
        encoded = codec.encodeResult(request.method, result, this._outboundServerInfo());
      } catch (error) {
        this._onerror(/* @__PURE__ */ new Error(`Failed to encode result for ${request.method}: ${error}`));
        sendErrorResponse(ProtocolErrorCode.InternalError, "Internal error");
        return;
      }
      const response = {
        result: encoded,
        jsonrpc: "2.0",
        id: request.id
      };
      await capturedTransport?.send(response);
    }, async (error) => {
      if (abortController.signal.aborted)
        return;
      const thrownCode = Number.isSafeInteger(error["code"]) ? error["code"] : ProtocolErrorCode.InternalError;
      const errorResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: codec.encodeErrorCode(thrownCode),
          message: error.message ?? "Internal error",
          ...error["data"] !== undefined && { data: error["data"] }
        }
      };
      await capturedTransport?.send(errorResponse);
    }).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send response: ${error}`))).finally(() => {
      if (this._requestHandlerAbortControllers.get(request.id) === abortController)
        this._requestHandlerAbortControllers.delete(request.id);
    });
  }
  _onprogress(notification) {
    const { progressToken, ...params } = notification.params;
    const messageId = Number(progressToken);
    const handler = this._progressHandlers.get(messageId);
    if (!handler) {
      this._onerror(/* @__PURE__ */ new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
      return;
    }
    const responseHandler = this._responseHandlers.get(messageId);
    const timeoutInfo = this._timeoutInfo.get(messageId);
    if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress)
      try {
        this._resetTimeout(messageId);
      } catch (error) {
        this._responseHandlers.delete(messageId);
        this._progressHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        responseHandler(error);
        return;
      }
    handler(params);
  }
  _onresponse(response) {
    const messageId = Number(response.id);
    const handler = this._responseHandlers.get(messageId);
    if (handler === undefined) {
      this._onerror(/* @__PURE__ */ new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
      return;
    }
    this._responseHandlers.delete(messageId);
    this._cleanupTimeout(messageId);
    this._progressHandlers.delete(messageId);
    if (isJSONRPCResultResponse(response))
      handler(response);
    else
      handler(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
  }
  get transport() {
    return this._transport;
  }
  async close() {
    await this._transport?.close();
  }
  request(request, schemaOrOptions, maybeOptions) {
    const codec = this._resolveOutboundCodec(request.method);
    if (isStandardSchema(schemaOrOptions)) {
      if (!isExtensionReusedRequestMethod(request.method))
        this._assertOutboundRequestInEra(codec, request.method);
      return this._requestWithSchemaViaCodec(codec, request, schemaOrOptions, maybeOptions);
    }
    this._assertOutboundRequestInEra(codec, request.method);
    const validate = codecResultValidator(codec, request.method);
    if (validate === undefined)
      throw new TypeError(`'${request.method}' is not a spec method; pass a result schema as the second argument to request().`);
    return this._requestWithSchemaViaCodec(codec, request, validate, schemaOrOptions);
  }
  _negotiatedWireCodec() {
    return codecForVersion(this._negotiatedProtocolVersion);
  }
  _wireCodec() {
    return this._negotiatedWireCodec();
  }
  _resolveOutboundCodec(method) {
    if (this._negotiatedProtocolVersion === undefined) {
      const pinned = bootstrapOutboundCodec(method);
      if (pinned)
        return pinned;
    }
    return this._negotiatedWireCodec();
  }
  _assertOutboundRequestInEra(codec, method) {
    if (isSpecRequestMethod(method) && !codec.hasRequestMethod(method))
      throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Method '${method}' is not supported by the negotiated protocol version (wire era ${codec.era})`, {
        method,
        era: codec.era
      });
  }
  _requestWithSchema(request, resultSchema, options) {
    const codec = this._resolveOutboundCodec(request.method);
    this._assertOutboundRequestInEra(codec, request.method);
    return this._requestWithSchemaViaCodec(codec, request, resultSchema, options);
  }
  _requestWithSchemaViaCodec(codec, request, resultSchema, options) {
    const { relatedRequestId, resumptionToken, onresumptiontoken, headers } = options ?? {};
    const flowStartedAt = Date.now();
    let onAbort;
    let cleanupMessageId;
    return new Promise((resolve, reject) => {
      const earlyReject = (error) => {
        reject(error);
      };
      if (!this._transport) {
        earlyReject(/* @__PURE__ */ new Error("Not connected"));
        return;
      }
      if (this._options?.enforceStrictCapabilities === true)
        try {
          this.assertCapabilityForMethod(request.method);
        } catch (error) {
          earlyReject(error);
          return;
        }
      if (options?.signal?.aborted) {
        const reason = options.signal.reason;
        throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
      }
      const requestAbort = codec.era === MODERN_WIRE_REVISION && this._transport.hasPerRequestStream === true ? new AbortController : undefined;
      const messageId = this._requestMessageId++;
      cleanupMessageId = messageId;
      const jsonrpcRequest = {
        ...request,
        jsonrpc: "2.0",
        id: messageId
      };
      if (options?.onprogress) {
        this._progressHandlers.set(messageId, options.onprogress);
        jsonrpcRequest.params = {
          ...request.params,
          _meta: {
            ...request.params?._meta,
            progressToken: messageId
          }
        };
      }
      const outbound = this._envelopeOutbound(jsonrpcRequest);
      let responseReceived = false;
      const cancel = (reason) => {
        if (responseReceived)
          return;
        this._progressHandlers.delete(messageId);
        if (requestAbort === undefined) {
          if (request.method !== "initialize")
            this._transport?.send(this._envelopeOutbound({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: {
                requestId: messageId,
                reason: String(reason)
              }
            }), {
              relatedRequestId,
              resumptionToken,
              onresumptiontoken
            }).catch((error) => this._onerror(/* @__PURE__ */ new Error(`Failed to send cancellation: ${error}`)));
        } else
          requestAbort.abort();
        reject(reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason)));
      };
      this._responseHandlers.set(messageId, (response) => {
        if (options?.signal?.aborted)
          return;
        responseReceived = true;
        if (response instanceof Error)
          return reject(response);
        let decoded;
        try {
          decoded = codec.decodeResult(request.method, response.result);
        } catch (error) {
          return reject(error instanceof Error ? error : new Error(String(error)));
        }
        if (decoded.kind === "invalid")
          return reject(decoded.error);
        if (decoded.kind === "input_required") {
          if (options?.allowInputRequired === true)
            return resolve(manualInputRequiredValue(decoded));
          const flow = {
            codec,
            request,
            resultSchema,
            options,
            flowStartedAt,
            retry: (params, legOptions) => this._requestWithSchemaViaCodec(codec, params === undefined ? { method: request.method } : {
              method: request.method,
              params
            }, resultSchema, legOptions)
          };
          return resolve(this._resolveNonCompleteResult(decoded, flow));
        }
        const result = decoded.result;
        validateStandardSchema(resultSchema, result).then((parseResult) => {
          if (parseResult.success)
            resolve(parseResult.data);
          else
            reject(new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${request.method}: ${parseResult.error}`));
        }, reject);
      });
      onAbort = () => cancel(options?.signal?.reason);
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
      const timeoutHandler = () => cancel(new SdkError(SdkErrorCode.RequestTimeout, "Request timed out", { timeout }));
      this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);
      this._transport.send(outbound, {
        relatedRequestId,
        resumptionToken,
        onresumptiontoken,
        headers,
        requestSignal: requestAbort?.signal
      }).catch((error) => {
        this._progressHandlers.delete(messageId);
        reject(error);
      });
    }).finally(() => {
      if (onAbort)
        options?.signal?.removeEventListener("abort", onAbort);
      if (cleanupMessageId !== undefined) {
        this._responseHandlers.delete(cleanupMessageId);
        this._cleanupTimeout(cleanupMessageId);
      }
    });
  }
  async notification(notification, options) {
    return await this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, options);
  }
  async _notificationViaCodec(codec, notification, options) {
    if (!this._transport)
      throw new SdkError(SdkErrorCode.NotConnected, "Not connected");
    if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method))
      throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `Notification '${notification.method}' is not supported by the negotiated protocol version (wire era ${codec.era})`, {
        method: notification.method,
        era: codec.era
      });
    this.assertNotificationCapability(notification.method);
    const jsonrpcNotification = this._envelopeOutbound({
      jsonrpc: "2.0",
      ...notification
    });
    if ((this._options?.debouncedNotificationMethods ?? []).includes(notification.method) && !notification.params && options?.relatedRequestId === undefined) {
      if (this._pendingDebouncedNotifications.has(notification.method))
        return;
      this._pendingDebouncedNotifications.add(notification.method);
      Promise.resolve().then(() => {
        this._pendingDebouncedNotifications.delete(notification.method);
        if (!this._transport)
          return;
        this._transport?.send(jsonrpcNotification, options).catch((error) => this._onerror(error));
      });
      return;
    }
    await this._transport.send(jsonrpcNotification, options);
  }
  setRequestHandler(method, schemasOrHandler, maybeHandler) {
    this.assertRequestHandlerCapability(method);
    let stored;
    if (typeof schemasOrHandler === "function") {
      if (!isSpecRequestMethod(method))
        throw new TypeError(`'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`);
      stored = (request, ctx) => {
        const dispatchCodec = this._negotiatedWireCodec();
        let outcome = dispatchCodec.validateRequest(method, request);
        if (!outcome.ok && outcome.reason === "not-in-era")
          outcome = dispatchCodec.validateInputRequest(method, request);
        if (!outcome.ok) {
          if (outcome.reason === "not-in-era")
            throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
          throw new Error(outcome.message);
        }
        return Promise.resolve(schemasOrHandler(outcome.value, ctx));
      };
    } else if (maybeHandler)
      stored = async (request, ctx) => {
        const parsed = await validateStandardSchema(schemasOrHandler.params, { ...request.params });
        if (!parsed.success)
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error}`);
        return maybeHandler(parsed.data, ctx);
      };
    else
      throw new TypeError("setRequestHandler: handler is required");
    if (typeof schemasOrHandler === "function")
      this._customSchemaRequestMethods.delete(method);
    else
      this._customSchemaRequestMethods.add(method);
    this._requestHandlers.set(method, this._wrapHandler(method, stored));
  }
  _wrapHandler(_method, handler) {
    return handler;
  }
  _outboundServerInfo() {}
  removeRequestHandler(method) {
    this._requestHandlers.delete(method);
    this._customSchemaRequestMethods.delete(method);
  }
  assertCanSetRequestHandler(method) {
    if (this._requestHandlers.has(method))
      throw new Error(`A request handler for ${method} already exists, which would be overridden`);
  }
  setNotificationHandler(method, schemasOrHandler, maybeHandler) {
    if (typeof schemasOrHandler === "function") {
      if (!isSpecNotificationMethod(method))
        throw new TypeError(`'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`);
      this._notificationHandlers.set(method, (notification, codec) => {
        const outcome = codec.validateNotification(method, notification);
        if (!outcome.ok) {
          if (outcome.reason === "not-in-era")
            throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
          throw new Error(outcome.message);
        }
        return Promise.resolve(schemasOrHandler(outcome.value));
      });
      return;
    }
    if (!maybeHandler)
      throw new TypeError("setNotificationHandler: handler is required");
    this._notificationHandlers.set(method, async (notification) => {
      const parsed = await validateStandardSchema(schemasOrHandler.params, { ...notification.params });
      if (!parsed.success)
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for notification ${method}: ${parsed.error}`);
      await maybeHandler(parsed.data, notification);
    });
  }
  removeNotificationHandler(method) {
    this._notificationHandlers.delete(method);
  }
};
function isPlainObject$1(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function mergeCapabilities(base, additional) {
  const result = { ...base };
  for (const key in additional) {
    const k = key;
    const addValue = additional[k];
    if (addValue === undefined)
      continue;
    const baseValue = result[k];
    result[k] = isPlainObject$1(baseValue) && isPlainObject$1(addValue) ? {
      ...baseValue,
      ...addValue
    } : addValue;
  }
  return result;
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function partitionInputResponses(inputResponses) {
  const accepted = {};
  const droppedKeys = [];
  if (!isPlainObject2(inputResponses))
    return {
      accepted,
      droppedKeys
    };
  for (const [key, entry] of Object.entries(inputResponses)) {
    if (!isPlainObject2(entry) || "method" in entry || "result" in entry) {
      droppedKeys.push(key);
      continue;
    }
    accepted[key] = entry;
  }
  return {
    accepted,
    droppedKeys
  };
}
function relatedMessagingUnavailable(member) {
  throw new SdkError(SdkErrorCode.SendFailed, `ctx.mcpReq.${member} is not available while fulfilling an embedded input request: the request is fulfilled locally and has no related peer request`);
}
function synthesizeInputRequestContext(key, method, params, signal, sessionId) {
  return {
    sessionId,
    mcpReq: {
      id: key,
      method,
      _meta: params?.["_meta"],
      requestState: requestStateAccessor(undefined),
      signal,
      send: () => relatedMessagingUnavailable("send"),
      notify: () => relatedMessagingUnavailable("notify")
    }
  };
}
async function dispatchInputRequest(host, codec, key, entry, signal) {
  if (!isPlainObject2(entry) || typeof entry["method"] !== "string")
    throw new SdkError(SdkErrorCode.InvalidResult, `Invalid input request '${key}': each inputRequests entry must be an embedded request object with a method`, { key });
  const method = entry["method"];
  if (!codec.hasInputRequestMethod(method))
    throw new SdkError(SdkErrorCode.InvalidResult, `Invalid input request '${key}': '${method}' is not an embedded request the ${codec.era} revision defines (expected elicitation/create, sampling/createMessage, or roots/list)`, {
      key,
      method
    });
  const handler = host.getRequestHandler(method);
  if (handler === undefined)
    throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Cannot fulfil input request '${key}': no handler is registered for '${method}' on this client. Declare the corresponding capability and register a handler, or handle input_required results manually.`, {
      key,
      method
    });
  const params = isPlainObject2(entry["params"]) ? entry["params"] : undefined;
  return await handler({
    jsonrpc: "2.0",
    id: key,
    method,
    ...params !== undefined && { params }
  }, host.buildContext(synthesizeInputRequestContext(key, method, params, signal, host.sessionId)));
}
function buildRetryLegRequestOptions(options, legOptions) {
  return {
    ...options?.signal !== undefined && { signal: options.signal },
    ...options?.onprogress !== undefined && { onprogress: options.onprogress },
    ...options?.resetTimeoutOnProgress !== undefined && { resetTimeoutOnProgress: options.resetTimeoutOnProgress },
    ...options?.headers !== undefined && { headers: options.headers },
    ...legOptions.timeout !== undefined && { timeout: legOptions.timeout },
    ...legOptions.maxTotalTimeout !== undefined && { maxTotalTimeout: legOptions.maxTotalTimeout },
    allowInputRequired: true
  };
}
function runInputRequiredFlow(host, config, decoded, flow) {
  const { codec, request, options, flowStartedAt } = flow;
  const firstPayload = {
    inputRequests: decoded.inputRequests,
    ...decoded.requestState !== undefined && { requestState: decoded.requestState }
  };
  const hooks = {
    dispatchInputRequest: (key, entry, signal) => dispatchInputRequest(host, codec, key, entry, signal),
    retry: (params, legOptions) => flow.retry(params, buildRetryLegRequestOptions(options, legOptions))
  };
  return runInputRequiredDriver({
    config,
    method: request.method,
    originalParams: request.params,
    firstPayload,
    flowStartedAt,
    signal: options?.signal,
    requestOptions: {
      ...options?.timeout !== undefined && { timeout: options.timeout },
      ...options?.maxTotalTimeout !== undefined && { maxTotalTimeout: options.maxTotalTimeout },
      ...options?.onprogress !== undefined && { onprogress: options.onprogress }
    },
    hooks
  });
}
function manualInputRequiredValue(decoded) {
  return {
    resultType: "input_required",
    inputRequests: decoded.inputRequests,
    ...decoded.requestState !== undefined && { requestState: decoded.requestState },
    ...decoded._meta !== undefined && { _meta: decoded._meta }
  };
}
/*!
* content-type
* Copyright(c) 2015 Douglas Christopher Wilson
* MIT Licensed
*/
var require_content_type = /* @__PURE__ */ __commonJSMin((exports) => {
  var PARAM_REGEXP = /; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) */g;
  var QESC_REGEXP = /\\([\u000b\u0020-\u00ff])/g;
  var TYPE_REGEXP = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  exports.parse = parse;
  function parse(string) {
    if (!string)
      throw new TypeError("argument string is required");
    var header = typeof string === "object" ? getcontenttype(string) : string;
    if (typeof header !== "string")
      throw new TypeError("argument string is required to be a string");
    var index = header.indexOf(";");
    var type = index !== -1 ? header.slice(0, index).trim() : header.trim();
    if (!TYPE_REGEXP.test(type))
      throw new TypeError("invalid media type");
    var obj = new ContentType(type.toLowerCase());
    if (index !== -1) {
      var key;
      var match;
      var value;
      PARAM_REGEXP.lastIndex = index;
      while (match = PARAM_REGEXP.exec(header)) {
        if (match.index !== index)
          throw new TypeError("invalid parameter format");
        index += match[0].length;
        key = match[1].toLowerCase();
        value = match[2];
        if (value.charCodeAt(0) === 34) {
          value = value.slice(1, -1);
          if (value.indexOf("\\") !== -1)
            value = value.replace(QESC_REGEXP, "$1");
        }
        obj.parameters[key] = value;
      }
      if (index !== header.length)
        throw new TypeError("invalid parameter format");
    }
    return obj;
  }
  function getcontenttype(obj) {
    var header;
    if (typeof obj.getHeader === "function")
      header = obj.getHeader("content-type");
    else if (typeof obj.headers === "object")
      header = obj.headers && obj.headers["content-type"];
    if (typeof header !== "string")
      throw new TypeError("content-type header is missing from object");
    return header;
  }
  function ContentType(type) {
    this.parameters = Object.create(null);
    this.type = type;
  }
});
var import_content_type = /* @__PURE__ */ __toESM(require_content_type(), 1);
function mediaTypeEssence(header) {
  if (!header)
    return;
  try {
    return import_content_type.parse(header).type;
  } catch {
    const essence = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (essence === "" || header.slice(essence.length).includes(","))
      return;
    return essence;
  }
}
var STDIO_DEFAULT_MAX_BUFFER_SIZE = 10 * 1024 * 1024;
function normalizeHeaders(headers) {
  if (!headers)
    return {};
  if (headers instanceof Headers)
    return Object.fromEntries(headers.entries());
  if (Array.isArray(headers))
    return Object.fromEntries(headers);
  return { ...headers };
}
function createFetchWithInit(baseFetch = fetch, baseInit) {
  if (!baseInit)
    return baseFetch;
  return async (url, init) => {
    return baseFetch(url, {
      ...baseInit,
      ...init,
      headers: init?.headers ? {
        ...normalizeHeaders(baseInit.headers),
        ...normalizeHeaders(init.headers)
      } : baseInit.headers
    });
  };
}
var REDIRECT_STATUSES = new Set([
  301,
  302,
  303,
  307,
  308
]);
var MAX_REDIRECTS = 5;
function isWithinOrigin(from, to) {
  if (from.protocol === to.protocol && from.host === to.host)
    return true;
  return from.protocol === "http:" && to.protocol === "https:" && from.hostname === to.hostname && !from.port && !to.port;
}
function redirectTarget(url, response) {
  const location = REDIRECT_STATUSES.has(response.status) ? response.headers?.get("location") : undefined;
  if (!location)
    return;
  try {
    return new URL(location, url);
  } catch {
    return;
  }
}
var leftToFetch = /* @__PURE__ */ new WeakSet;
function fetchLeavingRedirects(baseFetch) {
  const copy = (url, init) => baseFetch(url, init);
  leftToFetch.add(copy);
  return copy;
}
function fetchWithinOrigin(baseFetch) {
  if (leftToFetch.has(baseFetch))
    return baseFetch;
  return async (url, init) => {
    if (init?.redirect === "error" || init?.redirect === "manual")
      return baseFetch(url, init);
    const method = (init?.method ?? "GET").toUpperCase();
    let current = url;
    for (let followed = 0;; followed++) {
      const response = await baseFetch(current, {
        ...init,
        redirect: "manual"
      });
      const target = redirectTarget(current, response);
      if (!target || followed === MAX_REDIRECTS)
        return response;
      const from = new URL(current);
      const keepsMethod = method === "GET" || response.status === 307 || response.status === 308;
      const keepsUserinfo = !(target.username || target.password) || target.username === from.username && target.password === from.password;
      if (!keepsMethod || !keepsUserinfo || !isWithinOrigin(from, target))
        return response;
      await response.text?.().catch(() => {});
      current = target;
    }
  };
}
function unfollowedRedirect(url, response) {
  if (response.type === "opaqueredirect")
    return "Redirect not followed: this runtime does not expose where it points";
  const target = redirectTarget(response.url || url, response);
  if (!target)
    return;
  target.username = target.password = target.search = target.hash = "";
  if (target.protocol === "http:" && new URL(response.url || url).protocol === "https:") {
    target.protocol = "https:";
    return `Redirect from https to plain http not followed; try ${target.href} as the endpoint`;
  }
  return `Redirect to ${target.href} not followed; use that URL as the endpoint if it is the intended server`;
}

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/ajvProvider-BIwGVY6G.mjs
var require_code$1 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.regexpCode = exports.getEsmExportName = exports.getProperty = exports.safeStringify = exports.stringify = exports.strConcat = exports.addCodeArg = exports.str = exports._ = exports.nil = exports._Code = exports.Name = exports.IDENTIFIER = exports._CodeOrName = undefined;
  var _CodeOrName = class {
  };
  exports._CodeOrName = _CodeOrName;
  exports.IDENTIFIER = /^[a-z$_][a-z$_0-9]*$/i;
  var Name = class extends _CodeOrName {
    constructor(s) {
      super();
      if (!exports.IDENTIFIER.test(s))
        throw new Error("CodeGen: name must be a valid identifier");
      this.str = s;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      return false;
    }
    get names() {
      return { [this.str]: 1 };
    }
  };
  exports.Name = Name;
  var _Code = class extends _CodeOrName {
    constructor(code) {
      super();
      this._items = typeof code === "string" ? [code] : code;
    }
    toString() {
      return this.str;
    }
    emptyStr() {
      if (this._items.length > 1)
        return false;
      const item = this._items[0];
      return item === "" || item === '""';
    }
    get str() {
      var _a;
      return (_a = this._str) !== null && _a !== undefined ? _a : this._str = this._items.reduce((s, c) => `${s}${c}`, "");
    }
    get names() {
      var _a;
      return (_a = this._names) !== null && _a !== undefined ? _a : this._names = this._items.reduce((names, c) => {
        if (c instanceof Name)
          names[c.str] = (names[c.str] || 0) + 1;
        return names;
      }, {});
    }
  };
  exports._Code = _Code;
  exports.nil = new _Code("");
  function _(strs, ...args) {
    const code = [strs[0]];
    let i = 0;
    while (i < args.length) {
      addCodeArg(code, args[i]);
      code.push(strs[++i]);
    }
    return new _Code(code);
  }
  exports._ = _;
  const plus = new _Code("+");
  function str(strs, ...args) {
    const expr = [safeStringify(strs[0])];
    let i = 0;
    while (i < args.length) {
      expr.push(plus);
      addCodeArg(expr, args[i]);
      expr.push(plus, safeStringify(strs[++i]));
    }
    optimize(expr);
    return new _Code(expr);
  }
  exports.str = str;
  function addCodeArg(code, arg) {
    if (arg instanceof _Code)
      code.push(...arg._items);
    else if (arg instanceof Name)
      code.push(arg);
    else
      code.push(interpolate(arg));
  }
  exports.addCodeArg = addCodeArg;
  function optimize(expr) {
    let i = 1;
    while (i < expr.length - 1) {
      if (expr[i] === plus) {
        const res = mergeExprItems(expr[i - 1], expr[i + 1]);
        if (res !== undefined) {
          expr.splice(i - 1, 3, res);
          continue;
        }
        expr[i++] = "+";
      }
      i++;
    }
  }
  function mergeExprItems(a, b) {
    if (b === '""')
      return a;
    if (a === '""')
      return b;
    if (typeof a == "string") {
      if (b instanceof Name || a[a.length - 1] !== '"')
        return;
      if (typeof b != "string")
        return `${a.slice(0, -1)}${b}"`;
      if (b[0] === '"')
        return a.slice(0, -1) + b.slice(1);
      return;
    }
    if (typeof b == "string" && b[0] === '"' && !(a instanceof Name))
      return `"${a}${b.slice(1)}`;
  }
  function strConcat(c1, c2) {
    return c2.emptyStr() ? c1 : c1.emptyStr() ? c2 : str`${c1}${c2}`;
  }
  exports.strConcat = strConcat;
  function interpolate(x) {
    return typeof x == "number" || typeof x == "boolean" || x === null ? x : safeStringify(Array.isArray(x) ? x.join(",") : x);
  }
  function stringify(x) {
    return new _Code(safeStringify(x));
  }
  exports.stringify = stringify;
  function safeStringify(x) {
    return JSON.stringify(x).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  }
  exports.safeStringify = safeStringify;
  function getProperty(key) {
    return typeof key == "string" && exports.IDENTIFIER.test(key) ? new _Code(`.${key}`) : _`[${key}]`;
  }
  exports.getProperty = getProperty;
  function getEsmExportName(key) {
    if (typeof key == "string" && exports.IDENTIFIER.test(key))
      return new _Code(`${key}`);
    throw new Error(`CodeGen: invalid export name: ${key}, use explicit $id name mapping`);
  }
  exports.getEsmExportName = getEsmExportName;
  function regexpCode(rx) {
    return new _Code(rx.toString());
  }
  exports.regexpCode = regexpCode;
});
var require_scope = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.ValueScope = exports.ValueScopeName = exports.Scope = exports.varKinds = exports.UsedValueState = undefined;
  const code_1 = require_code$1();
  var ValueError = class extends Error {
    constructor(name) {
      super(`CodeGen: "code" for ${name} not defined`);
      this.value = name.value;
    }
  };
  var UsedValueState;
  (function(UsedValueState) {
    UsedValueState[UsedValueState["Started"] = 0] = "Started";
    UsedValueState[UsedValueState["Completed"] = 1] = "Completed";
  })(UsedValueState || (exports.UsedValueState = UsedValueState = {}));
  exports.varKinds = {
    const: new code_1.Name("const"),
    let: new code_1.Name("let"),
    var: new code_1.Name("var")
  };
  var Scope = class {
    constructor({ prefixes, parent } = {}) {
      this._names = {};
      this._prefixes = prefixes;
      this._parent = parent;
    }
    toName(nameOrPrefix) {
      return nameOrPrefix instanceof code_1.Name ? nameOrPrefix : this.name(nameOrPrefix);
    }
    name(prefix) {
      return new code_1.Name(this._newName(prefix));
    }
    _newName(prefix) {
      const ng = this._names[prefix] || this._nameGroup(prefix);
      return `${prefix}${ng.index++}`;
    }
    _nameGroup(prefix) {
      var _a, _b;
      if (((_b = (_a = this._parent) === null || _a === undefined ? undefined : _a._prefixes) === null || _b === undefined ? undefined : _b.has(prefix)) || this._prefixes && !this._prefixes.has(prefix))
        throw new Error(`CodeGen: prefix "${prefix}" is not allowed in this scope`);
      return this._names[prefix] = {
        prefix,
        index: 0
      };
    }
  };
  exports.Scope = Scope;
  var ValueScopeName = class extends code_1.Name {
    constructor(prefix, nameStr) {
      super(nameStr);
      this.prefix = prefix;
    }
    setValue(value, { property, itemIndex }) {
      this.value = value;
      this.scopePath = (0, code_1._)`.${new code_1.Name(property)}[${itemIndex}]`;
    }
  };
  exports.ValueScopeName = ValueScopeName;
  const line = (0, code_1._)`\n`;
  var ValueScope = class extends Scope {
    constructor(opts) {
      super(opts);
      this._values = {};
      this._scope = opts.scope;
      this.opts = {
        ...opts,
        _n: opts.lines ? line : code_1.nil
      };
    }
    get() {
      return this._scope;
    }
    name(prefix) {
      return new ValueScopeName(prefix, this._newName(prefix));
    }
    value(nameOrPrefix, value) {
      var _a;
      if (value.ref === undefined)
        throw new Error("CodeGen: ref must be passed in value");
      const name = this.toName(nameOrPrefix);
      const { prefix } = name;
      const valueKey = (_a = value.key) !== null && _a !== undefined ? _a : value.ref;
      let vs = this._values[prefix];
      if (vs) {
        const _name = vs.get(valueKey);
        if (_name)
          return _name;
      } else
        vs = this._values[prefix] = /* @__PURE__ */ new Map;
      vs.set(valueKey, name);
      const s = this._scope[prefix] || (this._scope[prefix] = []);
      const itemIndex = s.length;
      s[itemIndex] = value.ref;
      name.setValue(value, {
        property: prefix,
        itemIndex
      });
      return name;
    }
    getValue(prefix, keyOrRef) {
      const vs = this._values[prefix];
      if (!vs)
        return;
      return vs.get(keyOrRef);
    }
    scopeRefs(scopeName, values = this._values) {
      return this._reduceValues(values, (name) => {
        if (name.scopePath === undefined)
          throw new Error(`CodeGen: name "${name}" has no value`);
        return (0, code_1._)`${scopeName}${name.scopePath}`;
      });
    }
    scopeCode(values = this._values, usedValues, getCode) {
      return this._reduceValues(values, (name) => {
        if (name.value === undefined)
          throw new Error(`CodeGen: name "${name}" has no value`);
        return name.value.code;
      }, usedValues, getCode);
    }
    _reduceValues(values, valueCode, usedValues = {}, getCode) {
      let code = code_1.nil;
      for (const prefix in values) {
        const vs = values[prefix];
        if (!vs)
          continue;
        const nameSet = usedValues[prefix] = usedValues[prefix] || /* @__PURE__ */ new Map;
        vs.forEach((name) => {
          if (nameSet.has(name))
            return;
          nameSet.set(name, UsedValueState.Started);
          let c = valueCode(name);
          if (c) {
            const def = this.opts.es5 ? exports.varKinds.var : exports.varKinds.const;
            code = (0, code_1._)`${code}${def} ${name} = ${c};${this.opts._n}`;
          } else if (c = getCode === null || getCode === undefined ? undefined : getCode(name))
            code = (0, code_1._)`${code}${c}${this.opts._n}`;
          else
            throw new ValueError(name);
          nameSet.set(name, UsedValueState.Completed);
        });
      }
      return code;
    }
  };
  exports.ValueScope = ValueScope;
});
var require_codegen = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.or = exports.and = exports.not = exports.CodeGen = exports.operators = exports.varKinds = exports.ValueScopeName = exports.ValueScope = exports.Scope = exports.Name = exports.regexpCode = exports.stringify = exports.getProperty = exports.nil = exports.strConcat = exports.str = exports._ = undefined;
  const code_1 = require_code$1();
  const scope_1 = require_scope();
  var code_2 = require_code$1();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return code_2._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return code_2.str;
    }
  });
  Object.defineProperty(exports, "strConcat", {
    enumerable: true,
    get: function() {
      return code_2.strConcat;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return code_2.nil;
    }
  });
  Object.defineProperty(exports, "getProperty", {
    enumerable: true,
    get: function() {
      return code_2.getProperty;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return code_2.stringify;
    }
  });
  Object.defineProperty(exports, "regexpCode", {
    enumerable: true,
    get: function() {
      return code_2.regexpCode;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return code_2.Name;
    }
  });
  var scope_2 = require_scope();
  Object.defineProperty(exports, "Scope", {
    enumerable: true,
    get: function() {
      return scope_2.Scope;
    }
  });
  Object.defineProperty(exports, "ValueScope", {
    enumerable: true,
    get: function() {
      return scope_2.ValueScope;
    }
  });
  Object.defineProperty(exports, "ValueScopeName", {
    enumerable: true,
    get: function() {
      return scope_2.ValueScopeName;
    }
  });
  Object.defineProperty(exports, "varKinds", {
    enumerable: true,
    get: function() {
      return scope_2.varKinds;
    }
  });
  exports.operators = {
    GT: new code_1._Code(">"),
    GTE: new code_1._Code(">="),
    LT: new code_1._Code("<"),
    LTE: new code_1._Code("<="),
    EQ: new code_1._Code("==="),
    NEQ: new code_1._Code("!=="),
    NOT: new code_1._Code("!"),
    OR: new code_1._Code("||"),
    AND: new code_1._Code("&&"),
    ADD: new code_1._Code("+")
  };
  var Node = class {
    optimizeNodes() {
      return this;
    }
    optimizeNames(_names, _constants) {
      return this;
    }
  };
  var Def = class extends Node {
    constructor(varKind, name, rhs) {
      super();
      this.varKind = varKind;
      this.name = name;
      this.rhs = rhs;
    }
    render({ es5, _n }) {
      const varKind = es5 ? scope_1.varKinds.var : this.varKind;
      const rhs = this.rhs === undefined ? "" : ` = ${this.rhs}`;
      return `${varKind} ${this.name}${rhs};` + _n;
    }
    optimizeNames(names, constants) {
      if (!names[this.name.str])
        return;
      if (this.rhs)
        this.rhs = optimizeExpr(this.rhs, names, constants);
      return this;
    }
    get names() {
      return this.rhs instanceof code_1._CodeOrName ? this.rhs.names : {};
    }
  };
  var Assign = class extends Node {
    constructor(lhs, rhs, sideEffects) {
      super();
      this.lhs = lhs;
      this.rhs = rhs;
      this.sideEffects = sideEffects;
    }
    render({ _n }) {
      return `${this.lhs} = ${this.rhs};` + _n;
    }
    optimizeNames(names, constants) {
      if (this.lhs instanceof code_1.Name && !names[this.lhs.str] && !this.sideEffects)
        return;
      this.rhs = optimizeExpr(this.rhs, names, constants);
      return this;
    }
    get names() {
      return addExprNames(this.lhs instanceof code_1.Name ? {} : { ...this.lhs.names }, this.rhs);
    }
  };
  var AssignOp = class extends Assign {
    constructor(lhs, op, rhs, sideEffects) {
      super(lhs, rhs, sideEffects);
      this.op = op;
    }
    render({ _n }) {
      return `${this.lhs} ${this.op}= ${this.rhs};` + _n;
    }
  };
  var Label = class extends Node {
    constructor(label) {
      super();
      this.label = label;
      this.names = {};
    }
    render({ _n }) {
      return `${this.label}:` + _n;
    }
  };
  var Break = class extends Node {
    constructor(label) {
      super();
      this.label = label;
      this.names = {};
    }
    render({ _n }) {
      return `break${this.label ? ` ${this.label}` : ""};` + _n;
    }
  };
  var Throw = class extends Node {
    constructor(error) {
      super();
      this.error = error;
    }
    render({ _n }) {
      return `throw ${this.error};` + _n;
    }
    get names() {
      return this.error.names;
    }
  };
  var AnyCode = class extends Node {
    constructor(code) {
      super();
      this.code = code;
    }
    render({ _n }) {
      return `${this.code};` + _n;
    }
    optimizeNodes() {
      return `${this.code}` ? this : undefined;
    }
    optimizeNames(names, constants) {
      this.code = optimizeExpr(this.code, names, constants);
      return this;
    }
    get names() {
      return this.code instanceof code_1._CodeOrName ? this.code.names : {};
    }
  };
  var ParentNode = class extends Node {
    constructor(nodes = []) {
      super();
      this.nodes = nodes;
    }
    render(opts) {
      return this.nodes.reduce((code, n) => code + n.render(opts), "");
    }
    optimizeNodes() {
      const { nodes } = this;
      let i = nodes.length;
      while (i--) {
        const n = nodes[i].optimizeNodes();
        if (Array.isArray(n))
          nodes.splice(i, 1, ...n);
        else if (n)
          nodes[i] = n;
        else
          nodes.splice(i, 1);
      }
      return nodes.length > 0 ? this : undefined;
    }
    optimizeNames(names, constants) {
      const { nodes } = this;
      let i = nodes.length;
      while (i--) {
        const n = nodes[i];
        if (n.optimizeNames(names, constants))
          continue;
        subtractNames(names, n.names);
        nodes.splice(i, 1);
      }
      return nodes.length > 0 ? this : undefined;
    }
    get names() {
      return this.nodes.reduce((names, n) => addNames(names, n.names), {});
    }
  };
  var BlockNode = class extends ParentNode {
    render(opts) {
      return "{" + opts._n + super.render(opts) + "}" + opts._n;
    }
  };
  var Root = class extends ParentNode {
  };
  var Else = class extends BlockNode {
  };
  Else.kind = "else";
  var If = class If extends BlockNode {
    constructor(condition, nodes) {
      super(nodes);
      this.condition = condition;
    }
    render(opts) {
      let code = `if(${this.condition})` + super.render(opts);
      if (this.else)
        code += "else " + this.else.render(opts);
      return code;
    }
    optimizeNodes() {
      super.optimizeNodes();
      const cond = this.condition;
      if (cond === true)
        return this.nodes;
      let e = this.else;
      if (e) {
        const ns = e.optimizeNodes();
        e = this.else = Array.isArray(ns) ? new Else(ns) : ns;
      }
      if (e) {
        if (cond === false)
          return e instanceof If ? e : e.nodes;
        if (this.nodes.length)
          return this;
        return new If(not(cond), e instanceof If ? [e] : e.nodes);
      }
      if (cond === false || !this.nodes.length)
        return;
      return this;
    }
    optimizeNames(names, constants) {
      var _a;
      this.else = (_a = this.else) === null || _a === undefined ? undefined : _a.optimizeNames(names, constants);
      if (!(super.optimizeNames(names, constants) || this.else))
        return;
      this.condition = optimizeExpr(this.condition, names, constants);
      return this;
    }
    get names() {
      const names = super.names;
      addExprNames(names, this.condition);
      if (this.else)
        addNames(names, this.else.names);
      return names;
    }
  };
  If.kind = "if";
  var For = class extends BlockNode {
  };
  For.kind = "for";
  var ForLoop = class extends For {
    constructor(iteration) {
      super();
      this.iteration = iteration;
    }
    render(opts) {
      return `for(${this.iteration})` + super.render(opts);
    }
    optimizeNames(names, constants) {
      if (!super.optimizeNames(names, constants))
        return;
      this.iteration = optimizeExpr(this.iteration, names, constants);
      return this;
    }
    get names() {
      return addNames(super.names, this.iteration.names);
    }
  };
  var ForRange = class extends For {
    constructor(varKind, name, from, to) {
      super();
      this.varKind = varKind;
      this.name = name;
      this.from = from;
      this.to = to;
    }
    render(opts) {
      const varKind = opts.es5 ? scope_1.varKinds.var : this.varKind;
      const { name, from, to } = this;
      return `for(${varKind} ${name}=${from}; ${name}<${to}; ${name}++)` + super.render(opts);
    }
    get names() {
      return addExprNames(addExprNames(super.names, this.from), this.to);
    }
  };
  var ForIter = class extends For {
    constructor(loop, varKind, name, iterable) {
      super();
      this.loop = loop;
      this.varKind = varKind;
      this.name = name;
      this.iterable = iterable;
    }
    render(opts) {
      return `for(${this.varKind} ${this.name} ${this.loop} ${this.iterable})` + super.render(opts);
    }
    optimizeNames(names, constants) {
      if (!super.optimizeNames(names, constants))
        return;
      this.iterable = optimizeExpr(this.iterable, names, constants);
      return this;
    }
    get names() {
      return addNames(super.names, this.iterable.names);
    }
  };
  var Func = class extends BlockNode {
    constructor(name, args, async) {
      super();
      this.name = name;
      this.args = args;
      this.async = async;
    }
    render(opts) {
      return `${this.async ? "async " : ""}function ${this.name}(${this.args})` + super.render(opts);
    }
  };
  Func.kind = "func";
  var Return = class extends ParentNode {
    render(opts) {
      return "return " + super.render(opts);
    }
  };
  Return.kind = "return";
  var Try = class extends BlockNode {
    render(opts) {
      let code = "try" + super.render(opts);
      if (this.catch)
        code += this.catch.render(opts);
      if (this.finally)
        code += this.finally.render(opts);
      return code;
    }
    optimizeNodes() {
      var _a, _b;
      super.optimizeNodes();
      (_a = this.catch) === null || _a === undefined || _a.optimizeNodes();
      (_b = this.finally) === null || _b === undefined || _b.optimizeNodes();
      return this;
    }
    optimizeNames(names, constants) {
      var _a, _b;
      super.optimizeNames(names, constants);
      (_a = this.catch) === null || _a === undefined || _a.optimizeNames(names, constants);
      (_b = this.finally) === null || _b === undefined || _b.optimizeNames(names, constants);
      return this;
    }
    get names() {
      const names = super.names;
      if (this.catch)
        addNames(names, this.catch.names);
      if (this.finally)
        addNames(names, this.finally.names);
      return names;
    }
  };
  var Catch = class extends BlockNode {
    constructor(error) {
      super();
      this.error = error;
    }
    render(opts) {
      return `catch(${this.error})` + super.render(opts);
    }
  };
  Catch.kind = "catch";
  var Finally = class extends BlockNode {
    render(opts) {
      return "finally" + super.render(opts);
    }
  };
  Finally.kind = "finally";
  var CodeGen = class {
    constructor(extScope, opts = {}) {
      this._values = {};
      this._blockStarts = [];
      this._constants = {};
      this.opts = {
        ...opts,
        _n: opts.lines ? `
` : ""
      };
      this._extScope = extScope;
      this._scope = new scope_1.Scope({ parent: extScope });
      this._nodes = [new Root];
    }
    toString() {
      return this._root.render(this.opts);
    }
    name(prefix) {
      return this._scope.name(prefix);
    }
    scopeName(prefix) {
      return this._extScope.name(prefix);
    }
    scopeValue(prefixOrName, value) {
      const name = this._extScope.value(prefixOrName, value);
      (this._values[name.prefix] || (this._values[name.prefix] = /* @__PURE__ */ new Set)).add(name);
      return name;
    }
    getScopeValue(prefix, keyOrRef) {
      return this._extScope.getValue(prefix, keyOrRef);
    }
    scopeRefs(scopeName) {
      return this._extScope.scopeRefs(scopeName, this._values);
    }
    scopeCode() {
      return this._extScope.scopeCode(this._values);
    }
    _def(varKind, nameOrPrefix, rhs, constant) {
      const name = this._scope.toName(nameOrPrefix);
      if (rhs !== undefined && constant)
        this._constants[name.str] = rhs;
      this._leafNode(new Def(varKind, name, rhs));
      return name;
    }
    const(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.const, nameOrPrefix, rhs, _constant);
    }
    let(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.let, nameOrPrefix, rhs, _constant);
    }
    var(nameOrPrefix, rhs, _constant) {
      return this._def(scope_1.varKinds.var, nameOrPrefix, rhs, _constant);
    }
    assign(lhs, rhs, sideEffects) {
      return this._leafNode(new Assign(lhs, rhs, sideEffects));
    }
    add(lhs, rhs) {
      return this._leafNode(new AssignOp(lhs, exports.operators.ADD, rhs));
    }
    code(c) {
      if (typeof c == "function")
        c();
      else if (c !== code_1.nil)
        this._leafNode(new AnyCode(c));
      return this;
    }
    object(...keyValues) {
      const code = ["{"];
      for (const [key, value] of keyValues) {
        if (code.length > 1)
          code.push(",");
        code.push(key);
        if (key !== value || this.opts.es5) {
          code.push(":");
          (0, code_1.addCodeArg)(code, value);
        }
      }
      code.push("}");
      return new code_1._Code(code);
    }
    if(condition, thenBody, elseBody) {
      this._blockNode(new If(condition));
      if (thenBody && elseBody)
        this.code(thenBody).else().code(elseBody).endIf();
      else if (thenBody)
        this.code(thenBody).endIf();
      else if (elseBody)
        throw new Error('CodeGen: "else" body without "then" body');
      return this;
    }
    elseIf(condition) {
      return this._elseNode(new If(condition));
    }
    else() {
      return this._elseNode(new Else);
    }
    endIf() {
      return this._endBlockNode(If, Else);
    }
    _for(node, forBody) {
      this._blockNode(node);
      if (forBody)
        this.code(forBody).endFor();
      return this;
    }
    for(iteration, forBody) {
      return this._for(new ForLoop(iteration), forBody);
    }
    forRange(nameOrPrefix, from, to, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.let) {
      const name = this._scope.toName(nameOrPrefix);
      return this._for(new ForRange(varKind, name, from, to), () => forBody(name));
    }
    forOf(nameOrPrefix, iterable, forBody, varKind = scope_1.varKinds.const) {
      const name = this._scope.toName(nameOrPrefix);
      if (this.opts.es5) {
        const arr = iterable instanceof code_1.Name ? iterable : this.var("_arr", iterable);
        return this.forRange("_i", 0, (0, code_1._)`${arr}.length`, (i) => {
          this.var(name, (0, code_1._)`${arr}[${i}]`);
          forBody(name);
        });
      }
      return this._for(new ForIter("of", varKind, name, iterable), () => forBody(name));
    }
    forIn(nameOrPrefix, obj, forBody, varKind = this.opts.es5 ? scope_1.varKinds.var : scope_1.varKinds.const) {
      if (this.opts.ownProperties)
        return this.forOf(nameOrPrefix, (0, code_1._)`Object.keys(${obj})`, forBody);
      const name = this._scope.toName(nameOrPrefix);
      return this._for(new ForIter("in", varKind, name, obj), () => forBody(name));
    }
    endFor() {
      return this._endBlockNode(For);
    }
    label(label) {
      return this._leafNode(new Label(label));
    }
    break(label) {
      return this._leafNode(new Break(label));
    }
    return(value) {
      const node = new Return;
      this._blockNode(node);
      this.code(value);
      if (node.nodes.length !== 1)
        throw new Error('CodeGen: "return" should have one node');
      return this._endBlockNode(Return);
    }
    try(tryBody, catchCode, finallyCode) {
      if (!catchCode && !finallyCode)
        throw new Error('CodeGen: "try" without "catch" and "finally"');
      const node = new Try;
      this._blockNode(node);
      this.code(tryBody);
      if (catchCode) {
        const error = this.name("e");
        this._currNode = node.catch = new Catch(error);
        catchCode(error);
      }
      if (finallyCode) {
        this._currNode = node.finally = new Finally;
        this.code(finallyCode);
      }
      return this._endBlockNode(Catch, Finally);
    }
    throw(error) {
      return this._leafNode(new Throw(error));
    }
    block(body, nodeCount) {
      this._blockStarts.push(this._nodes.length);
      if (body)
        this.code(body).endBlock(nodeCount);
      return this;
    }
    endBlock(nodeCount) {
      const len = this._blockStarts.pop();
      if (len === undefined)
        throw new Error("CodeGen: not in self-balancing block");
      const toClose = this._nodes.length - len;
      if (toClose < 0 || nodeCount !== undefined && toClose !== nodeCount)
        throw new Error(`CodeGen: wrong number of nodes: ${toClose} vs ${nodeCount} expected`);
      this._nodes.length = len;
      return this;
    }
    func(name, args = code_1.nil, async, funcBody) {
      this._blockNode(new Func(name, args, async));
      if (funcBody)
        this.code(funcBody).endFunc();
      return this;
    }
    endFunc() {
      return this._endBlockNode(Func);
    }
    optimize(n = 1) {
      while (n-- > 0) {
        this._root.optimizeNodes();
        this._root.optimizeNames(this._root.names, this._constants);
      }
    }
    _leafNode(node) {
      this._currNode.nodes.push(node);
      return this;
    }
    _blockNode(node) {
      this._currNode.nodes.push(node);
      this._nodes.push(node);
    }
    _endBlockNode(N1, N2) {
      const n = this._currNode;
      if (n instanceof N1 || N2 && n instanceof N2) {
        this._nodes.pop();
        return this;
      }
      throw new Error(`CodeGen: not in block "${N2 ? `${N1.kind}/${N2.kind}` : N1.kind}"`);
    }
    _elseNode(node) {
      const n = this._currNode;
      if (!(n instanceof If))
        throw new Error('CodeGen: "else" without "if"');
      this._currNode = n.else = node;
      return this;
    }
    get _root() {
      return this._nodes[0];
    }
    get _currNode() {
      const ns = this._nodes;
      return ns[ns.length - 1];
    }
    set _currNode(node) {
      const ns = this._nodes;
      ns[ns.length - 1] = node;
    }
  };
  exports.CodeGen = CodeGen;
  function addNames(names, from) {
    for (const n in from)
      names[n] = (names[n] || 0) + (from[n] || 0);
    return names;
  }
  function addExprNames(names, from) {
    return from instanceof code_1._CodeOrName ? addNames(names, from.names) : names;
  }
  function optimizeExpr(expr, names, constants) {
    if (expr instanceof code_1.Name)
      return replaceName(expr);
    if (!canOptimize(expr))
      return expr;
    return new code_1._Code(expr._items.reduce((items, c) => {
      if (c instanceof code_1.Name)
        c = replaceName(c);
      if (c instanceof code_1._Code)
        items.push(...c._items);
      else
        items.push(c);
      return items;
    }, []));
    function replaceName(n) {
      const c = constants[n.str];
      if (c === undefined || names[n.str] !== 1)
        return n;
      delete names[n.str];
      return c;
    }
    function canOptimize(e) {
      return e instanceof code_1._Code && e._items.some((c) => c instanceof code_1.Name && names[c.str] === 1 && constants[c.str] !== undefined);
    }
  }
  function subtractNames(names, from) {
    for (const n in from)
      names[n] = (names[n] || 0) - (from[n] || 0);
  }
  function not(x) {
    return typeof x == "boolean" || typeof x == "number" || x === null ? !x : (0, code_1._)`!${par(x)}`;
  }
  exports.not = not;
  const andCode = mappend(exports.operators.AND);
  function and(...args) {
    return args.reduce(andCode);
  }
  exports.and = and;
  const orCode = mappend(exports.operators.OR);
  function or(...args) {
    return args.reduce(orCode);
  }
  exports.or = or;
  function mappend(op) {
    return (x, y) => x === code_1.nil ? y : y === code_1.nil ? x : (0, code_1._)`${par(x)} ${op} ${par(y)}`;
  }
  function par(x) {
    return x instanceof code_1.Name ? x : (0, code_1._)`(${x})`;
  }
});
var require_util = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.checkStrictMode = exports.getErrorPath = exports.Type = exports.useFunc = exports.setEvaluated = exports.evaluatedPropsToName = exports.mergeEvaluated = exports.eachItem = exports.unescapeJsonPointer = exports.escapeJsonPointer = exports.escapeFragment = exports.unescapeFragment = exports.schemaRefOrVal = exports.schemaHasRulesButRef = exports.schemaHasRules = exports.checkUnknownRules = exports.alwaysValidSchema = exports.toHash = undefined;
  const codegen_1 = require_codegen();
  const code_1 = require_code$1();
  function toHash(arr) {
    const hash = {};
    for (const item of arr)
      hash[item] = true;
    return hash;
  }
  exports.toHash = toHash;
  function alwaysValidSchema(it, schema) {
    if (typeof schema == "boolean")
      return schema;
    if (Object.keys(schema).length === 0)
      return true;
    checkUnknownRules(it, schema);
    return !schemaHasRules(schema, it.self.RULES.all);
  }
  exports.alwaysValidSchema = alwaysValidSchema;
  function checkUnknownRules(it, schema = it.schema) {
    const { opts, self } = it;
    if (!opts.strictSchema)
      return;
    if (typeof schema === "boolean")
      return;
    const rules = self.RULES.keywords;
    for (const key in schema)
      if (!rules[key])
        checkStrictMode(it, `unknown keyword: "${key}"`);
  }
  exports.checkUnknownRules = checkUnknownRules;
  function schemaHasRules(schema, rules) {
    if (typeof schema == "boolean")
      return !schema;
    for (const key in schema)
      if (rules[key])
        return true;
    return false;
  }
  exports.schemaHasRules = schemaHasRules;
  function schemaHasRulesButRef(schema, RULES) {
    if (typeof schema == "boolean")
      return !schema;
    for (const key in schema)
      if (key !== "$ref" && RULES.all[key])
        return true;
    return false;
  }
  exports.schemaHasRulesButRef = schemaHasRulesButRef;
  function schemaRefOrVal({ topSchemaRef, schemaPath }, schema, keyword, $data) {
    if (!$data) {
      if (typeof schema == "number" || typeof schema == "boolean")
        return schema;
      if (typeof schema == "string")
        return (0, codegen_1._)`${schema}`;
    }
    return (0, codegen_1._)`${topSchemaRef}${schemaPath}${(0, codegen_1.getProperty)(keyword)}`;
  }
  exports.schemaRefOrVal = schemaRefOrVal;
  function unescapeFragment(str) {
    return unescapeJsonPointer(decodeURIComponent(str));
  }
  exports.unescapeFragment = unescapeFragment;
  function escapeFragment(str) {
    return encodeURIComponent(escapeJsonPointer(str));
  }
  exports.escapeFragment = escapeFragment;
  function escapeJsonPointer(str) {
    if (typeof str == "number")
      return `${str}`;
    return str.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  exports.escapeJsonPointer = escapeJsonPointer;
  function unescapeJsonPointer(str) {
    return str.replace(/~1/g, "/").replace(/~0/g, "~");
  }
  exports.unescapeJsonPointer = unescapeJsonPointer;
  function eachItem(xs, f) {
    if (Array.isArray(xs))
      for (const x of xs)
        f(x);
    else
      f(xs);
  }
  exports.eachItem = eachItem;
  function makeMergeEvaluated({ mergeNames, mergeToName, mergeValues, resultToName }) {
    return (gen, from, to, toName) => {
      const res = to === undefined ? from : to instanceof codegen_1.Name ? (from instanceof codegen_1.Name ? mergeNames(gen, from, to) : mergeToName(gen, from, to), to) : from instanceof codegen_1.Name ? (mergeToName(gen, to, from), from) : mergeValues(from, to);
      return toName === codegen_1.Name && !(res instanceof codegen_1.Name) ? resultToName(gen, res) : res;
    };
  }
  exports.mergeEvaluated = {
    props: makeMergeEvaluated({
      mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => {
        gen.if((0, codegen_1._)`${from} === true`, () => gen.assign(to, true), () => gen.assign(to, (0, codegen_1._)`${to} || {}`).code((0, codegen_1._)`Object.assign(${to}, ${from})`));
      }),
      mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => {
        if (from === true)
          gen.assign(to, true);
        else {
          gen.assign(to, (0, codegen_1._)`${to} || {}`);
          setEvaluated(gen, to, from);
        }
      }),
      mergeValues: (from, to) => from === true ? true : {
        ...from,
        ...to
      },
      resultToName: evaluatedPropsToName
    }),
    items: makeMergeEvaluated({
      mergeNames: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true && ${from} !== undefined`, () => gen.assign(to, (0, codegen_1._)`${from} === true ? true : ${to} > ${from} ? ${to} : ${from}`)),
      mergeToName: (gen, from, to) => gen.if((0, codegen_1._)`${to} !== true`, () => gen.assign(to, from === true ? true : (0, codegen_1._)`${to} > ${from} ? ${to} : ${from}`)),
      mergeValues: (from, to) => from === true ? true : Math.max(from, to),
      resultToName: (gen, items) => gen.var("items", items)
    })
  };
  function evaluatedPropsToName(gen, ps) {
    if (ps === true)
      return gen.var("props", true);
    const props = gen.var("props", (0, codegen_1._)`{}`);
    if (ps !== undefined)
      setEvaluated(gen, props, ps);
    return props;
  }
  exports.evaluatedPropsToName = evaluatedPropsToName;
  function setEvaluated(gen, props, ps) {
    Object.keys(ps).forEach((p) => gen.assign((0, codegen_1._)`${props}${(0, codegen_1.getProperty)(p)}`, true));
  }
  exports.setEvaluated = setEvaluated;
  const snippets = {};
  function useFunc(gen, f) {
    return gen.scopeValue("func", {
      ref: f,
      code: snippets[f.code] || (snippets[f.code] = new code_1._Code(f.code))
    });
  }
  exports.useFunc = useFunc;
  var Type;
  (function(Type) {
    Type[Type["Num"] = 0] = "Num";
    Type[Type["Str"] = 1] = "Str";
  })(Type || (exports.Type = Type = {}));
  function getErrorPath(dataProp, dataPropType, jsPropertySyntax) {
    if (dataProp instanceof codegen_1.Name) {
      const isNumber = dataPropType === Type.Num;
      return jsPropertySyntax ? isNumber ? (0, codegen_1._)`"[" + ${dataProp} + "]"` : (0, codegen_1._)`"['" + ${dataProp} + "']"` : isNumber ? (0, codegen_1._)`"/" + ${dataProp}` : (0, codegen_1._)`"/" + ${dataProp}.replace(/~/g, "~0").replace(/\\//g, "~1")`;
    }
    return jsPropertySyntax ? (0, codegen_1.getProperty)(dataProp).toString() : "/" + escapeJsonPointer(dataProp);
  }
  exports.getErrorPath = getErrorPath;
  function checkStrictMode(it, msg, mode = it.opts.strictSchema) {
    if (!mode)
      return;
    msg = `strict mode: ${msg}`;
    if (mode === true)
      throw new Error(msg);
    it.self.logger.warn(msg);
  }
  exports.checkStrictMode = checkStrictMode;
});
var require_names = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const names = {
    data: new codegen_1.Name("data"),
    valCxt: new codegen_1.Name("valCxt"),
    instancePath: new codegen_1.Name("instancePath"),
    parentData: new codegen_1.Name("parentData"),
    parentDataProperty: new codegen_1.Name("parentDataProperty"),
    rootData: new codegen_1.Name("rootData"),
    dynamicAnchors: new codegen_1.Name("dynamicAnchors"),
    vErrors: new codegen_1.Name("vErrors"),
    errors: new codegen_1.Name("errors"),
    this: new codegen_1.Name("this"),
    self: new codegen_1.Name("self"),
    scope: new codegen_1.Name("scope"),
    json: new codegen_1.Name("json"),
    jsonPos: new codegen_1.Name("jsonPos"),
    jsonLen: new codegen_1.Name("jsonLen"),
    jsonPart: new codegen_1.Name("jsonPart")
  };
  exports.default = names;
});
var require_errors = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.extendErrors = exports.resetErrorsCount = exports.reportExtraError = exports.reportError = exports.keyword$DataError = exports.keywordError = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const names_1 = require_names();
  exports.keywordError = { message: ({ keyword }) => (0, codegen_1.str)`must pass "${keyword}" keyword validation` };
  exports.keyword$DataError = { message: ({ keyword, schemaType }) => schemaType ? (0, codegen_1.str)`"${keyword}" keyword must be ${schemaType} ($data)` : (0, codegen_1.str)`"${keyword}" keyword is invalid ($data)` };
  function reportError(cxt, error = exports.keywordError, errorPaths, overrideAllErrors) {
    const { it } = cxt;
    const { gen, compositeRule, allErrors } = it;
    const errObj = errorObjectCode(cxt, error, errorPaths);
    if (overrideAllErrors !== null && overrideAllErrors !== undefined ? overrideAllErrors : compositeRule || allErrors)
      addError(gen, errObj);
    else
      returnErrors(it, (0, codegen_1._)`[${errObj}]`);
  }
  exports.reportError = reportError;
  function reportExtraError(cxt, error = exports.keywordError, errorPaths) {
    const { it } = cxt;
    const { gen, compositeRule, allErrors } = it;
    addError(gen, errorObjectCode(cxt, error, errorPaths));
    if (!(compositeRule || allErrors))
      returnErrors(it, names_1.default.vErrors);
  }
  exports.reportExtraError = reportExtraError;
  function resetErrorsCount(gen, errsCount) {
    gen.assign(names_1.default.errors, errsCount);
    gen.if((0, codegen_1._)`${names_1.default.vErrors} !== null`, () => gen.if(errsCount, () => gen.assign((0, codegen_1._)`${names_1.default.vErrors}.length`, errsCount), () => gen.assign(names_1.default.vErrors, null)));
  }
  exports.resetErrorsCount = resetErrorsCount;
  function extendErrors({ gen, keyword, schemaValue, data, errsCount, it }) {
    if (errsCount === undefined)
      throw new Error("ajv implementation error");
    const err = gen.name("err");
    gen.forRange("i", errsCount, names_1.default.errors, (i) => {
      gen.const(err, (0, codegen_1._)`${names_1.default.vErrors}[${i}]`);
      gen.if((0, codegen_1._)`${err}.instancePath === undefined`, () => gen.assign((0, codegen_1._)`${err}.instancePath`, (0, codegen_1.strConcat)(names_1.default.instancePath, it.errorPath)));
      gen.assign((0, codegen_1._)`${err}.schemaPath`, (0, codegen_1.str)`${it.errSchemaPath}/${keyword}`);
      if (it.opts.verbose) {
        gen.assign((0, codegen_1._)`${err}.schema`, schemaValue);
        gen.assign((0, codegen_1._)`${err}.data`, data);
      }
    });
  }
  exports.extendErrors = extendErrors;
  function addError(gen, errObj) {
    const err = gen.const("err", errObj);
    gen.if((0, codegen_1._)`${names_1.default.vErrors} === null`, () => gen.assign(names_1.default.vErrors, (0, codegen_1._)`[${err}]`), (0, codegen_1._)`${names_1.default.vErrors}.push(${err})`);
    gen.code((0, codegen_1._)`${names_1.default.errors}++`);
  }
  function returnErrors(it, errs) {
    const { gen, validateName, schemaEnv } = it;
    if (schemaEnv.$async)
      gen.throw((0, codegen_1._)`new ${it.ValidationError}(${errs})`);
    else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, errs);
      gen.return(false);
    }
  }
  const E = {
    keyword: new codegen_1.Name("keyword"),
    schemaPath: new codegen_1.Name("schemaPath"),
    params: new codegen_1.Name("params"),
    propertyName: new codegen_1.Name("propertyName"),
    message: new codegen_1.Name("message"),
    schema: new codegen_1.Name("schema"),
    parentSchema: new codegen_1.Name("parentSchema")
  };
  function errorObjectCode(cxt, error, errorPaths) {
    const { createErrors } = cxt.it;
    if (createErrors === false)
      return (0, codegen_1._)`{}`;
    return errorObject(cxt, error, errorPaths);
  }
  function errorObject(cxt, error, errorPaths = {}) {
    const { gen, it } = cxt;
    const keyValues = [errorInstancePath(it, errorPaths), errorSchemaPath(cxt, errorPaths)];
    extraErrorProps(cxt, error, keyValues);
    return gen.object(...keyValues);
  }
  function errorInstancePath({ errorPath }, { instancePath }) {
    const instPath = instancePath ? (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(instancePath, util_1.Type.Str)}` : errorPath;
    return [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, instPath)];
  }
  function errorSchemaPath({ keyword, it: { errSchemaPath } }, { schemaPath, parentSchema }) {
    let schPath = parentSchema ? errSchemaPath : (0, codegen_1.str)`${errSchemaPath}/${keyword}`;
    if (schemaPath)
      schPath = (0, codegen_1.str)`${schPath}${(0, util_1.getErrorPath)(schemaPath, util_1.Type.Str)}`;
    return [E.schemaPath, schPath];
  }
  function extraErrorProps(cxt, { params, message }, keyValues) {
    const { keyword, data, schemaValue, it } = cxt;
    const { opts, propertyName, topSchemaRef, schemaPath } = it;
    keyValues.push([E.keyword, keyword], [E.params, typeof params == "function" ? params(cxt) : params || (0, codegen_1._)`{}`]);
    if (opts.messages)
      keyValues.push([E.message, typeof message == "function" ? message(cxt) : message]);
    if (opts.verbose)
      keyValues.push([E.schema, schemaValue], [E.parentSchema, (0, codegen_1._)`${topSchemaRef}${schemaPath}`], [names_1.default.data, data]);
    if (propertyName)
      keyValues.push([E.propertyName, propertyName]);
  }
});
var require_boolSchema = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.boolOrEmptySchema = exports.topBoolOrEmptySchema = undefined;
  const errors_1 = require_errors();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const boolError = { message: "boolean schema is false" };
  function topBoolOrEmptySchema(it) {
    const { gen, schema, validateName } = it;
    if (schema === false)
      falseSchemaError(it, false);
    else if (typeof schema == "object" && schema.$async === true)
      gen.return(names_1.default.data);
    else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, null);
      gen.return(true);
    }
  }
  exports.topBoolOrEmptySchema = topBoolOrEmptySchema;
  function boolOrEmptySchema(it, valid) {
    const { gen, schema } = it;
    if (schema === false) {
      gen.var(valid, false);
      falseSchemaError(it);
    } else
      gen.var(valid, true);
  }
  exports.boolOrEmptySchema = boolOrEmptySchema;
  function falseSchemaError(it, overrideAllErrors) {
    const { gen, data } = it;
    const cxt = {
      gen,
      keyword: "false schema",
      data,
      schema: false,
      schemaCode: false,
      schemaValue: false,
      params: {},
      it
    };
    (0, errors_1.reportError)(cxt, boolError, undefined, overrideAllErrors);
  }
});
var require_rules = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getRules = exports.isJSONType = undefined;
  const jsonTypes = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    "object",
    "array"
  ]);
  function isJSONType(x) {
    return typeof x == "string" && jsonTypes.has(x);
  }
  exports.isJSONType = isJSONType;
  function getRules() {
    const groups = {
      number: {
        type: "number",
        rules: []
      },
      string: {
        type: "string",
        rules: []
      },
      array: {
        type: "array",
        rules: []
      },
      object: {
        type: "object",
        rules: []
      }
    };
    return {
      types: {
        ...groups,
        integer: true,
        boolean: true,
        null: true
      },
      rules: [
        { rules: [] },
        groups.number,
        groups.string,
        groups.array,
        groups.object
      ],
      post: { rules: [] },
      all: {},
      keywords: {}
    };
  }
  exports.getRules = getRules;
});
var require_applicability = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.shouldUseRule = exports.shouldUseGroup = exports.schemaHasRulesForType = undefined;
  function schemaHasRulesForType({ schema, self }, type) {
    const group = self.RULES.types[type];
    return group && group !== true && shouldUseGroup(schema, group);
  }
  exports.schemaHasRulesForType = schemaHasRulesForType;
  function shouldUseGroup(schema, group) {
    return group.rules.some((rule) => shouldUseRule(schema, rule));
  }
  exports.shouldUseGroup = shouldUseGroup;
  function shouldUseRule(schema, rule) {
    var _a;
    return schema[rule.keyword] !== undefined || ((_a = rule.definition.implements) === null || _a === undefined ? undefined : _a.some((kwd) => schema[kwd] !== undefined));
  }
  exports.shouldUseRule = shouldUseRule;
});
var require_dataType = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.reportTypeError = exports.checkDataTypes = exports.checkDataType = exports.coerceAndCheckDataType = exports.getJSONTypes = exports.getSchemaTypes = exports.DataType = undefined;
  const rules_1 = require_rules();
  const applicability_1 = require_applicability();
  const errors_1 = require_errors();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  var DataType;
  (function(DataType) {
    DataType[DataType["Correct"] = 0] = "Correct";
    DataType[DataType["Wrong"] = 1] = "Wrong";
  })(DataType || (exports.DataType = DataType = {}));
  function getSchemaTypes(schema) {
    const types = getJSONTypes(schema.type);
    if (types.includes("null")) {
      if (schema.nullable === false)
        throw new Error("type: null contradicts nullable: false");
    } else {
      if (!types.length && schema.nullable !== undefined)
        throw new Error('"nullable" cannot be used without "type"');
      if (schema.nullable === true)
        types.push("null");
    }
    return types;
  }
  exports.getSchemaTypes = getSchemaTypes;
  function getJSONTypes(ts) {
    const types = Array.isArray(ts) ? ts : ts ? [ts] : [];
    if (types.every(rules_1.isJSONType))
      return types;
    throw new Error("type must be JSONType or JSONType[]: " + types.join(","));
  }
  exports.getJSONTypes = getJSONTypes;
  function coerceAndCheckDataType(it, types) {
    const { gen, data, opts } = it;
    const coerceTo = coerceToTypes(types, opts.coerceTypes);
    const checkTypes = types.length > 0 && !(coerceTo.length === 0 && types.length === 1 && (0, applicability_1.schemaHasRulesForType)(it, types[0]));
    if (checkTypes) {
      const wrongType = checkDataTypes(types, data, opts.strictNumbers, DataType.Wrong);
      gen.if(wrongType, () => {
        if (coerceTo.length)
          coerceData(it, types, coerceTo);
        else
          reportTypeError(it);
      });
    }
    return checkTypes;
  }
  exports.coerceAndCheckDataType = coerceAndCheckDataType;
  const COERCIBLE = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "null"
  ]);
  function coerceToTypes(types, coerceTypes) {
    return coerceTypes ? types.filter((t) => COERCIBLE.has(t) || coerceTypes === "array" && t === "array") : [];
  }
  function coerceData(it, types, coerceTo) {
    const { gen, data, opts } = it;
    const dataType = gen.let("dataType", (0, codegen_1._)`typeof ${data}`);
    const coerced = gen.let("coerced", (0, codegen_1._)`undefined`);
    if (opts.coerceTypes === "array")
      gen.if((0, codegen_1._)`${dataType} == 'object' && Array.isArray(${data}) && ${data}.length == 1`, () => gen.assign(data, (0, codegen_1._)`${data}[0]`).assign(dataType, (0, codegen_1._)`typeof ${data}`).if(checkDataTypes(types, data, opts.strictNumbers), () => gen.assign(coerced, data)));
    gen.if((0, codegen_1._)`${coerced} !== undefined`);
    for (const t of coerceTo)
      if (COERCIBLE.has(t) || t === "array" && opts.coerceTypes === "array")
        coerceSpecificType(t);
    gen.else();
    reportTypeError(it);
    gen.endIf();
    gen.if((0, codegen_1._)`${coerced} !== undefined`, () => {
      gen.assign(data, coerced);
      assignParentData(it, coerced);
    });
    function coerceSpecificType(t) {
      switch (t) {
        case "string":
          gen.elseIf((0, codegen_1._)`${dataType} == "number" || ${dataType} == "boolean"`).assign(coerced, (0, codegen_1._)`"" + ${data}`).elseIf((0, codegen_1._)`${data} === null`).assign(coerced, (0, codegen_1._)`""`);
          return;
        case "number":
          gen.elseIf((0, codegen_1._)`${dataType} == "boolean" || ${data} === null
              || (${dataType} == "string" && ${data} && ${data} == +${data})`).assign(coerced, (0, codegen_1._)`+${data}`);
          return;
        case "integer":
          gen.elseIf((0, codegen_1._)`${dataType} === "boolean" || ${data} === null
              || (${dataType} === "string" && ${data} && ${data} == +${data} && !(${data} % 1))`).assign(coerced, (0, codegen_1._)`+${data}`);
          return;
        case "boolean":
          gen.elseIf((0, codegen_1._)`${data} === "false" || ${data} === 0 || ${data} === null`).assign(coerced, false).elseIf((0, codegen_1._)`${data} === "true" || ${data} === 1`).assign(coerced, true);
          return;
        case "null":
          gen.elseIf((0, codegen_1._)`${data} === "" || ${data} === 0 || ${data} === false`);
          gen.assign(coerced, null);
          return;
        case "array":
          gen.elseIf((0, codegen_1._)`${dataType} === "string" || ${dataType} === "number"
              || ${dataType} === "boolean" || ${data} === null`).assign(coerced, (0, codegen_1._)`[${data}]`);
      }
    }
  }
  function assignParentData({ gen, parentData, parentDataProperty }, expr) {
    gen.if((0, codegen_1._)`${parentData} !== undefined`, () => gen.assign((0, codegen_1._)`${parentData}[${parentDataProperty}]`, expr));
  }
  function checkDataType(dataType, data, strictNums, correct = DataType.Correct) {
    const EQ = correct === DataType.Correct ? codegen_1.operators.EQ : codegen_1.operators.NEQ;
    let cond;
    switch (dataType) {
      case "null":
        return (0, codegen_1._)`${data} ${EQ} null`;
      case "array":
        cond = (0, codegen_1._)`Array.isArray(${data})`;
        break;
      case "object":
        cond = (0, codegen_1._)`${data} && typeof ${data} == "object" && !Array.isArray(${data})`;
        break;
      case "integer":
        cond = numCond((0, codegen_1._)`!(${data} % 1) && !isNaN(${data})`);
        break;
      case "number":
        cond = numCond();
        break;
      default:
        return (0, codegen_1._)`typeof ${data} ${EQ} ${dataType}`;
    }
    return correct === DataType.Correct ? cond : (0, codegen_1.not)(cond);
    function numCond(_cond = codegen_1.nil) {
      return (0, codegen_1.and)((0, codegen_1._)`typeof ${data} == "number"`, _cond, strictNums ? (0, codegen_1._)`isFinite(${data})` : codegen_1.nil);
    }
  }
  exports.checkDataType = checkDataType;
  function checkDataTypes(dataTypes, data, strictNums, correct) {
    if (dataTypes.length === 1)
      return checkDataType(dataTypes[0], data, strictNums, correct);
    let cond;
    const types = (0, util_1.toHash)(dataTypes);
    if (types.array && types.object) {
      const notObj = (0, codegen_1._)`typeof ${data} != "object"`;
      cond = types.null ? notObj : (0, codegen_1._)`!${data} || ${notObj}`;
      delete types.null;
      delete types.array;
      delete types.object;
    } else
      cond = codegen_1.nil;
    if (types.number)
      delete types.integer;
    for (const t in types)
      cond = (0, codegen_1.and)(cond, checkDataType(t, data, strictNums, correct));
    return cond;
  }
  exports.checkDataTypes = checkDataTypes;
  const typeError = {
    message: ({ schema }) => `must be ${schema}`,
    params: ({ schema, schemaValue }) => typeof schema == "string" ? (0, codegen_1._)`{type: ${schema}}` : (0, codegen_1._)`{type: ${schemaValue}}`
  };
  function reportTypeError(it) {
    const cxt = getTypeErrorContext(it);
    (0, errors_1.reportError)(cxt, typeError);
  }
  exports.reportTypeError = reportTypeError;
  function getTypeErrorContext(it) {
    const { gen, data, schema } = it;
    const schemaCode = (0, util_1.schemaRefOrVal)(it, schema, "type");
    return {
      gen,
      keyword: "type",
      data,
      schema: schema.type,
      schemaCode,
      schemaValue: schemaCode,
      parentSchema: schema,
      params: {},
      it
    };
  }
});
var require_defaults = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.assignDefaults = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  function assignDefaults(it, ty) {
    const { properties, items } = it.schema;
    if (ty === "object" && properties)
      for (const key in properties)
        assignDefault(it, key, properties[key].default);
    else if (ty === "array" && Array.isArray(items))
      items.forEach((sch, i) => assignDefault(it, i, sch.default));
  }
  exports.assignDefaults = assignDefaults;
  function assignDefault(it, prop, defaultValue) {
    const { gen, compositeRule, data, opts } = it;
    if (defaultValue === undefined)
      return;
    const childData = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(prop)}`;
    if (compositeRule) {
      (0, util_1.checkStrictMode)(it, `default is ignored for: ${childData}`);
      return;
    }
    let condition = (0, codegen_1._)`${childData} === undefined`;
    if (opts.useDefaults === "empty")
      condition = (0, codegen_1._)`${condition} || ${childData} === null || ${childData} === ""`;
    gen.if(condition, (0, codegen_1._)`${childData} = ${(0, codegen_1.stringify)(defaultValue)}`);
  }
});
var require_code = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateUnion = exports.validateArray = exports.usePattern = exports.callValidateCode = exports.schemaProperties = exports.allSchemaProperties = exports.noPropertyInData = exports.propertyInData = exports.isOwnProperty = exports.hasPropFunc = exports.reportMissingProp = exports.checkMissingProp = exports.checkReportMissingProp = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const names_1 = require_names();
  const util_2 = require_util();
  function checkReportMissingProp(cxt, prop) {
    const { gen, data, it } = cxt;
    gen.if(noPropertyInData(gen, data, prop, it.opts.ownProperties), () => {
      cxt.setParams({ missingProperty: (0, codegen_1._)`${prop}` }, true);
      cxt.error();
    });
  }
  exports.checkReportMissingProp = checkReportMissingProp;
  function checkMissingProp({ gen, data, it: { opts } }, properties, missing) {
    return (0, codegen_1.or)(...properties.map((prop) => (0, codegen_1.and)(noPropertyInData(gen, data, prop, opts.ownProperties), (0, codegen_1._)`${missing} = ${prop}`)));
  }
  exports.checkMissingProp = checkMissingProp;
  function reportMissingProp(cxt, missing) {
    cxt.setParams({ missingProperty: missing }, true);
    cxt.error();
  }
  exports.reportMissingProp = reportMissingProp;
  function hasPropFunc(gen) {
    return gen.scopeValue("func", {
      ref: Object.prototype.hasOwnProperty,
      code: (0, codegen_1._)`Object.prototype.hasOwnProperty`
    });
  }
  exports.hasPropFunc = hasPropFunc;
  function isOwnProperty(gen, data, property) {
    return (0, codegen_1._)`${hasPropFunc(gen)}.call(${data}, ${property})`;
  }
  exports.isOwnProperty = isOwnProperty;
  function propertyInData(gen, data, property, ownProperties) {
    const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} !== undefined`;
    return ownProperties ? (0, codegen_1._)`${cond} && ${isOwnProperty(gen, data, property)}` : cond;
  }
  exports.propertyInData = propertyInData;
  function noPropertyInData(gen, data, property, ownProperties) {
    const cond = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(property)} === undefined`;
    return ownProperties ? (0, codegen_1.or)(cond, (0, codegen_1.not)(isOwnProperty(gen, data, property))) : cond;
  }
  exports.noPropertyInData = noPropertyInData;
  function allSchemaProperties(schemaMap) {
    return schemaMap ? Object.keys(schemaMap).filter((p) => p !== "__proto__") : [];
  }
  exports.allSchemaProperties = allSchemaProperties;
  function schemaProperties(it, schemaMap) {
    return allSchemaProperties(schemaMap).filter((p) => !(0, util_1.alwaysValidSchema)(it, schemaMap[p]));
  }
  exports.schemaProperties = schemaProperties;
  function callValidateCode({ schemaCode, data, it: { gen, topSchemaRef, schemaPath, errorPath }, it }, func, context, passSchema) {
    const dataAndSchema = passSchema ? (0, codegen_1._)`${schemaCode}, ${data}, ${topSchemaRef}${schemaPath}` : data;
    const valCxt = [
      [names_1.default.instancePath, (0, codegen_1.strConcat)(names_1.default.instancePath, errorPath)],
      [names_1.default.parentData, it.parentData],
      [names_1.default.parentDataProperty, it.parentDataProperty],
      [names_1.default.rootData, names_1.default.rootData]
    ];
    if (it.opts.dynamicRef)
      valCxt.push([names_1.default.dynamicAnchors, names_1.default.dynamicAnchors]);
    const args = (0, codegen_1._)`${dataAndSchema}, ${gen.object(...valCxt)}`;
    return context !== codegen_1.nil ? (0, codegen_1._)`${func}.call(${context}, ${args})` : (0, codegen_1._)`${func}(${args})`;
  }
  exports.callValidateCode = callValidateCode;
  const newRegExp = (0, codegen_1._)`new RegExp`;
  function usePattern({ gen, it: { opts } }, pattern) {
    const u = opts.unicodeRegExp ? "u" : "";
    const { regExp } = opts.code;
    const rx = regExp(pattern, u);
    return gen.scopeValue("pattern", {
      key: rx.toString(),
      ref: rx,
      code: (0, codegen_1._)`${regExp.code === "new RegExp" ? newRegExp : (0, util_2.useFunc)(gen, regExp)}(${pattern}, ${u})`
    });
  }
  exports.usePattern = usePattern;
  function validateArray(cxt) {
    const { gen, data, keyword, it } = cxt;
    const valid = gen.name("valid");
    if (it.allErrors) {
      const validArr = gen.let("valid", true);
      validateItems(() => gen.assign(validArr, false));
      return validArr;
    }
    gen.var(valid, true);
    validateItems(() => gen.break());
    return valid;
    function validateItems(notValid) {
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      gen.forRange("i", 0, len, (i) => {
        cxt.subschema({
          keyword,
          dataProp: i,
          dataPropType: util_1.Type.Num
        }, valid);
        gen.if((0, codegen_1.not)(valid), notValid);
      });
    }
  }
  exports.validateArray = validateArray;
  function validateUnion(cxt) {
    const { gen, schema, keyword, it } = cxt;
    if (!Array.isArray(schema))
      throw new Error("ajv implementation error");
    if (schema.some((sch) => (0, util_1.alwaysValidSchema)(it, sch)) && !it.opts.unevaluated)
      return;
    const valid = gen.let("valid", false);
    const schValid = gen.name("_valid");
    gen.block(() => schema.forEach((_sch, i) => {
      const schCxt = cxt.subschema({
        keyword,
        schemaProp: i,
        compositeRule: true
      }, schValid);
      gen.assign(valid, (0, codegen_1._)`${valid} || ${schValid}`);
      if (!cxt.mergeValidEvaluated(schCxt, schValid))
        gen.if((0, codegen_1.not)(valid));
    }));
    cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
  }
  exports.validateUnion = validateUnion;
});
var require_keyword = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateKeywordUsage = exports.validSchemaType = exports.funcKeywordCode = exports.macroKeywordCode = undefined;
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const code_1 = require_code();
  const errors_1 = require_errors();
  function macroKeywordCode(cxt, def) {
    const { gen, keyword, schema, parentSchema, it } = cxt;
    const macroSchema = def.macro.call(it.self, schema, parentSchema, it);
    const schemaRef = useKeyword(gen, keyword, macroSchema);
    if (it.opts.validateSchema !== false)
      it.self.validateSchema(macroSchema, true);
    const valid = gen.name("valid");
    cxt.subschema({
      schema: macroSchema,
      schemaPath: codegen_1.nil,
      errSchemaPath: `${it.errSchemaPath}/${keyword}`,
      topSchemaRef: schemaRef,
      compositeRule: true
    }, valid);
    cxt.pass(valid, () => cxt.error(true));
  }
  exports.macroKeywordCode = macroKeywordCode;
  function funcKeywordCode(cxt, def) {
    var _a;
    const { gen, keyword, schema, parentSchema, $data, it } = cxt;
    checkAsyncKeyword(it, def);
    const validateRef = useKeyword(gen, keyword, !$data && def.compile ? def.compile.call(it.self, schema, parentSchema, it) : def.validate);
    const valid = gen.let("valid");
    cxt.block$data(valid, validateKeyword);
    cxt.ok((_a = def.valid) !== null && _a !== undefined ? _a : valid);
    function validateKeyword() {
      if (def.errors === false) {
        assignValid();
        if (def.modifying)
          modifyData(cxt);
        reportErrs(() => cxt.error());
      } else {
        const ruleErrs = def.async ? validateAsync() : validateSync();
        if (def.modifying)
          modifyData(cxt);
        reportErrs(() => addErrs(cxt, ruleErrs));
      }
    }
    function validateAsync() {
      const ruleErrs = gen.let("ruleErrs", null);
      gen.try(() => assignValid((0, codegen_1._)`await `), (e) => gen.assign(valid, false).if((0, codegen_1._)`${e} instanceof ${it.ValidationError}`, () => gen.assign(ruleErrs, (0, codegen_1._)`${e}.errors`), () => gen.throw(e)));
      return ruleErrs;
    }
    function validateSync() {
      const validateErrs = (0, codegen_1._)`${validateRef}.errors`;
      gen.assign(validateErrs, null);
      assignValid(codegen_1.nil);
      return validateErrs;
    }
    function assignValid(_await = def.async ? (0, codegen_1._)`await ` : codegen_1.nil) {
      const passCxt = it.opts.passContext ? names_1.default.this : names_1.default.self;
      const passSchema = !(("compile" in def) && !$data || def.schema === false);
      gen.assign(valid, (0, codegen_1._)`${_await}${(0, code_1.callValidateCode)(cxt, validateRef, passCxt, passSchema)}`, def.modifying);
    }
    function reportErrs(errors) {
      var _a$1;
      gen.if((0, codegen_1.not)((_a$1 = def.valid) !== null && _a$1 !== undefined ? _a$1 : valid), errors);
    }
  }
  exports.funcKeywordCode = funcKeywordCode;
  function modifyData(cxt) {
    const { gen, data, it } = cxt;
    gen.if(it.parentData, () => gen.assign(data, (0, codegen_1._)`${it.parentData}[${it.parentDataProperty}]`));
  }
  function addErrs(cxt, errs) {
    const { gen } = cxt;
    gen.if((0, codegen_1._)`Array.isArray(${errs})`, () => {
      gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`).assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
      (0, errors_1.extendErrors)(cxt);
    }, () => cxt.error());
  }
  function checkAsyncKeyword({ schemaEnv }, def) {
    if (def.async && !schemaEnv.$async)
      throw new Error("async keyword in sync schema");
  }
  function useKeyword(gen, keyword, result) {
    if (result === undefined)
      throw new Error(`keyword "${keyword}" failed to compile`);
    return gen.scopeValue("keyword", typeof result == "function" ? { ref: result } : {
      ref: result,
      code: (0, codegen_1.stringify)(result)
    });
  }
  function validSchemaType(schema, schemaType, allowUndefined = false) {
    return !schemaType.length || schemaType.some((st) => st === "array" ? Array.isArray(schema) : st === "object" ? schema && typeof schema == "object" && !Array.isArray(schema) : typeof schema == st || allowUndefined && typeof schema == "undefined");
  }
  exports.validSchemaType = validSchemaType;
  function validateKeywordUsage({ schema, opts, self, errSchemaPath }, def, keyword) {
    if (Array.isArray(def.keyword) ? !def.keyword.includes(keyword) : def.keyword !== keyword)
      throw new Error("ajv implementation error");
    const deps = def.dependencies;
    if (deps === null || deps === undefined ? undefined : deps.some((kwd) => !Object.prototype.hasOwnProperty.call(schema, kwd)))
      throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`);
    if (def.validateSchema) {
      if (!def.validateSchema(schema[keyword])) {
        const msg = `keyword "${keyword}" value is invalid at path "${errSchemaPath}": ` + self.errorsText(def.validateSchema.errors);
        if (opts.validateSchema === "log")
          self.logger.error(msg);
        else
          throw new Error(msg);
      }
    }
  }
  exports.validateKeywordUsage = validateKeywordUsage;
});
var require_subschema = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.extendSubschemaMode = exports.extendSubschemaData = exports.getSubschema = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  function getSubschema(it, { keyword, schemaProp, schema, schemaPath, errSchemaPath, topSchemaRef }) {
    if (keyword !== undefined && schema !== undefined)
      throw new Error('both "keyword" and "schema" passed, only one allowed');
    if (keyword !== undefined) {
      const sch = it.schema[keyword];
      return schemaProp === undefined ? {
        schema: sch,
        schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}`,
        errSchemaPath: `${it.errSchemaPath}/${keyword}`
      } : {
        schema: sch[schemaProp],
        schemaPath: (0, codegen_1._)`${it.schemaPath}${(0, codegen_1.getProperty)(keyword)}${(0, codegen_1.getProperty)(schemaProp)}`,
        errSchemaPath: `${it.errSchemaPath}/${keyword}/${(0, util_1.escapeFragment)(schemaProp)}`
      };
    }
    if (schema !== undefined) {
      if (schemaPath === undefined || errSchemaPath === undefined || topSchemaRef === undefined)
        throw new Error('"schemaPath", "errSchemaPath" and "topSchemaRef" are required with "schema"');
      return {
        schema,
        schemaPath,
        topSchemaRef,
        errSchemaPath
      };
    }
    throw new Error('either "keyword" or "schema" must be passed');
  }
  exports.getSubschema = getSubschema;
  function extendSubschemaData(subschema, it, { dataProp, dataPropType: dpType, data, dataTypes, propertyName }) {
    if (data !== undefined && dataProp !== undefined)
      throw new Error('both "data" and "dataProp" passed, only one allowed');
    const { gen } = it;
    if (dataProp !== undefined) {
      const { errorPath, dataPathArr, opts } = it;
      dataContextProps(gen.let("data", (0, codegen_1._)`${it.data}${(0, codegen_1.getProperty)(dataProp)}`, true));
      subschema.errorPath = (0, codegen_1.str)`${errorPath}${(0, util_1.getErrorPath)(dataProp, dpType, opts.jsPropertySyntax)}`;
      subschema.parentDataProperty = (0, codegen_1._)`${dataProp}`;
      subschema.dataPathArr = [...dataPathArr, subschema.parentDataProperty];
    }
    if (data !== undefined) {
      dataContextProps(data instanceof codegen_1.Name ? data : gen.let("data", data, true));
      if (propertyName !== undefined)
        subschema.propertyName = propertyName;
    }
    if (dataTypes)
      subschema.dataTypes = dataTypes;
    function dataContextProps(_nextData) {
      subschema.data = _nextData;
      subschema.dataLevel = it.dataLevel + 1;
      subschema.dataTypes = [];
      it.definedProperties = /* @__PURE__ */ new Set;
      subschema.parentData = it.data;
      subschema.dataNames = [...it.dataNames, _nextData];
    }
  }
  exports.extendSubschemaData = extendSubschemaData;
  function extendSubschemaMode(subschema, { jtdDiscriminator, jtdMetadata, compositeRule, createErrors, allErrors }) {
    if (compositeRule !== undefined)
      subschema.compositeRule = compositeRule;
    if (createErrors !== undefined)
      subschema.createErrors = createErrors;
    if (allErrors !== undefined)
      subschema.allErrors = allErrors;
    subschema.jtdDiscriminator = jtdDiscriminator;
    subschema.jtdMetadata = jtdMetadata;
  }
  exports.extendSubschemaMode = extendSubschemaMode;
});
var require_fast_deep_equal = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = function equal(a, b) {
    if (a === b)
      return true;
    if (a && b && typeof a == "object" && typeof b == "object") {
      if (a.constructor !== b.constructor)
        return false;
      var length, i, keys;
      if (Array.isArray(a)) {
        length = a.length;
        if (length != b.length)
          return false;
        for (i = length;i-- !== 0; )
          if (!equal(a[i], b[i]))
            return false;
        return true;
      }
      if (a.constructor === RegExp)
        return a.source === b.source && a.flags === b.flags;
      if (a.valueOf !== Object.prototype.valueOf)
        return a.valueOf() === b.valueOf();
      if (a.toString !== Object.prototype.toString)
        return a.toString() === b.toString();
      keys = Object.keys(a);
      length = keys.length;
      if (length !== Object.keys(b).length)
        return false;
      for (i = length;i-- !== 0; )
        if (!Object.prototype.hasOwnProperty.call(b, keys[i]))
          return false;
      for (i = length;i-- !== 0; ) {
        var key = keys[i];
        if (!equal(a[key], b[key]))
          return false;
      }
      return true;
    }
    return a !== a && b !== b;
  };
});
var require_json_schema_traverse = /* @__PURE__ */ __commonJSMin((exports, module) => {
  var traverse = module.exports = function(schema, opts, cb) {
    if (typeof opts == "function") {
      cb = opts;
      opts = {};
    }
    cb = opts.cb || cb;
    var pre = typeof cb == "function" ? cb : cb.pre || function() {};
    var post = cb.post || function() {};
    _traverse(opts, pre, post, schema, "", schema);
  };
  traverse.keywords = {
    additionalItems: true,
    items: true,
    contains: true,
    additionalProperties: true,
    propertyNames: true,
    not: true,
    if: true,
    then: true,
    else: true
  };
  traverse.arrayKeywords = {
    items: true,
    allOf: true,
    anyOf: true,
    oneOf: true
  };
  traverse.propsKeywords = {
    $defs: true,
    definitions: true,
    properties: true,
    patternProperties: true,
    dependencies: true
  };
  traverse.skipKeywords = {
    default: true,
    enum: true,
    const: true,
    required: true,
    maximum: true,
    minimum: true,
    exclusiveMaximum: true,
    exclusiveMinimum: true,
    multipleOf: true,
    maxLength: true,
    minLength: true,
    pattern: true,
    format: true,
    maxItems: true,
    minItems: true,
    uniqueItems: true,
    maxProperties: true,
    minProperties: true
  };
  function _traverse(opts, pre, post, schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex) {
    if (schema && typeof schema == "object" && !Array.isArray(schema)) {
      pre(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
      for (var key in schema) {
        var sch = schema[key];
        if (Array.isArray(sch)) {
          if (key in traverse.arrayKeywords)
            for (var i = 0;i < sch.length; i++)
              _traverse(opts, pre, post, sch[i], jsonPtr + "/" + key + "/" + i, rootSchema, jsonPtr, key, schema, i);
        } else if (key in traverse.propsKeywords) {
          if (sch && typeof sch == "object")
            for (var prop in sch)
              _traverse(opts, pre, post, sch[prop], jsonPtr + "/" + key + "/" + escapeJsonPtr(prop), rootSchema, jsonPtr, key, schema, prop);
        } else if (key in traverse.keywords || opts.allKeys && !(key in traverse.skipKeywords))
          _traverse(opts, pre, post, sch, jsonPtr + "/" + key, rootSchema, jsonPtr, key, schema);
      }
      post(schema, jsonPtr, rootSchema, parentJsonPtr, parentKeyword, parentSchema, keyIndex);
    }
  }
  function escapeJsonPtr(str) {
    return str.replace(/~/g, "~0").replace(/\//g, "~1");
  }
});
var require_resolve = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getSchemaRefs = exports.resolveUrl = exports.normalizeId = exports._getFullPath = exports.getFullPath = exports.inlineRef = undefined;
  const util_1 = require_util();
  const equal = require_fast_deep_equal();
  const traverse = require_json_schema_traverse();
  const SIMPLE_INLINED = new Set([
    "type",
    "format",
    "pattern",
    "maxLength",
    "minLength",
    "maxProperties",
    "minProperties",
    "maxItems",
    "minItems",
    "maximum",
    "minimum",
    "uniqueItems",
    "multipleOf",
    "required",
    "enum",
    "const"
  ]);
  function inlineRef(schema, limit = true) {
    if (typeof schema == "boolean")
      return true;
    if (limit === true)
      return !hasRef(schema);
    if (!limit)
      return false;
    return countKeys(schema) <= limit;
  }
  exports.inlineRef = inlineRef;
  const REF_KEYWORDS = new Set([
    "$ref",
    "$recursiveRef",
    "$recursiveAnchor",
    "$dynamicRef",
    "$dynamicAnchor"
  ]);
  function hasRef(schema) {
    for (const key in schema) {
      if (REF_KEYWORDS.has(key))
        return true;
      const sch = schema[key];
      if (Array.isArray(sch) && sch.some(hasRef))
        return true;
      if (typeof sch == "object" && hasRef(sch))
        return true;
    }
    return false;
  }
  function countKeys(schema) {
    let count = 0;
    for (const key in schema) {
      if (key === "$ref")
        return Infinity;
      count++;
      if (SIMPLE_INLINED.has(key))
        continue;
      if (typeof schema[key] == "object")
        (0, util_1.eachItem)(schema[key], (sch) => count += countKeys(sch));
      if (count === Infinity)
        return Infinity;
    }
    return count;
  }
  function getFullPath(resolver, id = "", normalize) {
    if (normalize !== false)
      id = normalizeId(id);
    return _getFullPath(resolver, resolver.parse(id));
  }
  exports.getFullPath = getFullPath;
  function _getFullPath(resolver, p) {
    return resolver.serialize(p).split("#")[0] + "#";
  }
  exports._getFullPath = _getFullPath;
  const TRAILING_SLASH_HASH = /#\/?$/;
  function normalizeId(id) {
    return id ? id.replace(TRAILING_SLASH_HASH, "") : "";
  }
  exports.normalizeId = normalizeId;
  function resolveUrl(resolver, baseId, id) {
    id = normalizeId(id);
    return resolver.resolve(baseId, id);
  }
  exports.resolveUrl = resolveUrl;
  const ANCHOR = /^[a-z_][-a-z0-9._]*$/i;
  function getSchemaRefs(schema, baseId) {
    if (typeof schema == "boolean")
      return {};
    const { schemaId, uriResolver } = this.opts;
    const schId = normalizeId(schema[schemaId] || baseId);
    const baseIds = { "": schId };
    const pathPrefix = getFullPath(uriResolver, schId, false);
    const localRefs = {};
    const schemaRefs = /* @__PURE__ */ new Set;
    traverse(schema, { allKeys: true }, (sch, jsonPtr, _, parentJsonPtr) => {
      if (parentJsonPtr === undefined)
        return;
      const fullPath = pathPrefix + jsonPtr;
      let innerBaseId = baseIds[parentJsonPtr];
      if (typeof sch[schemaId] == "string")
        innerBaseId = addRef.call(this, sch[schemaId]);
      addAnchor.call(this, sch.$anchor);
      addAnchor.call(this, sch.$dynamicAnchor);
      baseIds[jsonPtr] = innerBaseId;
      function addRef(ref) {
        const _resolve = this.opts.uriResolver.resolve;
        ref = normalizeId(innerBaseId ? _resolve(innerBaseId, ref) : ref);
        if (schemaRefs.has(ref))
          throw ambiguos(ref);
        schemaRefs.add(ref);
        let schOrRef = this.refs[ref];
        if (typeof schOrRef == "string")
          schOrRef = this.refs[schOrRef];
        if (typeof schOrRef == "object")
          checkAmbiguosRef(sch, schOrRef.schema, ref);
        else if (ref !== normalizeId(fullPath))
          if (ref[0] === "#") {
            checkAmbiguosRef(sch, localRefs[ref], ref);
            localRefs[ref] = sch;
          } else
            this.refs[ref] = fullPath;
        return ref;
      }
      function addAnchor(anchor) {
        if (typeof anchor == "string") {
          if (!ANCHOR.test(anchor))
            throw new Error(`invalid anchor "${anchor}"`);
          addRef.call(this, `#${anchor}`);
        }
      }
    });
    return localRefs;
    function checkAmbiguosRef(sch1, sch2, ref) {
      if (sch2 !== undefined && !equal(sch1, sch2))
        throw ambiguos(ref);
    }
    function ambiguos(ref) {
      return /* @__PURE__ */ new Error(`reference "${ref}" resolves to more than one schema`);
    }
  }
  exports.getSchemaRefs = getSchemaRefs;
});
var require_validate = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.getData = exports.KeywordCxt = exports.validateFunctionCode = undefined;
  const boolSchema_1 = require_boolSchema();
  const dataType_1 = require_dataType();
  const applicability_1 = require_applicability();
  const dataType_2 = require_dataType();
  const defaults_1 = require_defaults();
  const keyword_1 = require_keyword();
  const subschema_1 = require_subschema();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const resolve_1 = require_resolve();
  const util_1 = require_util();
  const errors_1 = require_errors();
  function validateFunctionCode(it) {
    if (isSchemaObj(it)) {
      checkKeywords(it);
      if (schemaCxtHasRules(it)) {
        topSchemaObjCode(it);
        return;
      }
    }
    validateFunction(it, () => (0, boolSchema_1.topBoolOrEmptySchema)(it));
  }
  exports.validateFunctionCode = validateFunctionCode;
  function validateFunction({ gen, validateName, schema, schemaEnv, opts }, body) {
    if (opts.code.es5)
      gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${names_1.default.valCxt}`, schemaEnv.$async, () => {
        gen.code((0, codegen_1._)`"use strict"; ${funcSourceUrl(schema, opts)}`);
        destructureValCxtES5(gen, opts);
        gen.code(body);
      });
    else
      gen.func(validateName, (0, codegen_1._)`${names_1.default.data}, ${destructureValCxt(opts)}`, schemaEnv.$async, () => gen.code(funcSourceUrl(schema, opts)).code(body));
  }
  function destructureValCxt(opts) {
    return (0, codegen_1._)`{${names_1.default.instancePath}="", ${names_1.default.parentData}, ${names_1.default.parentDataProperty}, ${names_1.default.rootData}=${names_1.default.data}${opts.dynamicRef ? (0, codegen_1._)`, ${names_1.default.dynamicAnchors}={}` : codegen_1.nil}}={}`;
  }
  function destructureValCxtES5(gen, opts) {
    gen.if(names_1.default.valCxt, () => {
      gen.var(names_1.default.instancePath, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.instancePath}`);
      gen.var(names_1.default.parentData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentData}`);
      gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.parentDataProperty}`);
      gen.var(names_1.default.rootData, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.rootData}`);
      if (opts.dynamicRef)
        gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`${names_1.default.valCxt}.${names_1.default.dynamicAnchors}`);
    }, () => {
      gen.var(names_1.default.instancePath, (0, codegen_1._)`""`);
      gen.var(names_1.default.parentData, (0, codegen_1._)`undefined`);
      gen.var(names_1.default.parentDataProperty, (0, codegen_1._)`undefined`);
      gen.var(names_1.default.rootData, names_1.default.data);
      if (opts.dynamicRef)
        gen.var(names_1.default.dynamicAnchors, (0, codegen_1._)`{}`);
    });
  }
  function topSchemaObjCode(it) {
    const { schema, opts, gen } = it;
    validateFunction(it, () => {
      if (opts.$comment && schema.$comment)
        commentKeyword(it);
      checkNoDefault(it);
      gen.let(names_1.default.vErrors, null);
      gen.let(names_1.default.errors, 0);
      if (opts.unevaluated)
        resetEvaluated(it);
      typeAndKeywords(it);
      returnResults(it);
    });
  }
  function resetEvaluated(it) {
    const { gen, validateName } = it;
    it.evaluated = gen.const("evaluated", (0, codegen_1._)`${validateName}.evaluated`);
    gen.if((0, codegen_1._)`${it.evaluated}.dynamicProps`, () => gen.assign((0, codegen_1._)`${it.evaluated}.props`, (0, codegen_1._)`undefined`));
    gen.if((0, codegen_1._)`${it.evaluated}.dynamicItems`, () => gen.assign((0, codegen_1._)`${it.evaluated}.items`, (0, codegen_1._)`undefined`));
  }
  function funcSourceUrl(schema, opts) {
    const schId = typeof schema == "object" && schema[opts.schemaId];
    return schId && (opts.code.source || opts.code.process) ? (0, codegen_1._)`/*# sourceURL=${schId} */` : codegen_1.nil;
  }
  function subschemaCode(it, valid) {
    if (isSchemaObj(it)) {
      checkKeywords(it);
      if (schemaCxtHasRules(it)) {
        subSchemaObjCode(it, valid);
        return;
      }
    }
    (0, boolSchema_1.boolOrEmptySchema)(it, valid);
  }
  function schemaCxtHasRules({ schema, self }) {
    if (typeof schema == "boolean")
      return !schema;
    for (const key in schema)
      if (self.RULES.all[key])
        return true;
    return false;
  }
  function isSchemaObj(it) {
    return typeof it.schema != "boolean";
  }
  function subSchemaObjCode(it, valid) {
    const { schema, gen, opts } = it;
    if (opts.$comment && schema.$comment)
      commentKeyword(it);
    updateContext(it);
    checkAsyncSchema(it);
    const errsCount = gen.const("_errs", names_1.default.errors);
    typeAndKeywords(it, errsCount);
    gen.var(valid, (0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
  }
  function checkKeywords(it) {
    (0, util_1.checkUnknownRules)(it);
    checkRefsAndKeywords(it);
  }
  function typeAndKeywords(it, errsCount) {
    if (it.opts.jtd)
      return schemaKeywords(it, [], false, errsCount);
    const types = (0, dataType_1.getSchemaTypes)(it.schema);
    schemaKeywords(it, types, !(0, dataType_1.coerceAndCheckDataType)(it, types), errsCount);
  }
  function checkRefsAndKeywords(it) {
    const { schema, errSchemaPath, opts, self } = it;
    if (schema.$ref && opts.ignoreKeywordsWithRef && (0, util_1.schemaHasRulesButRef)(schema, self.RULES))
      self.logger.warn(`$ref: keywords ignored in schema at path "${errSchemaPath}"`);
  }
  function checkNoDefault(it) {
    const { schema, opts } = it;
    if (schema.default !== undefined && opts.useDefaults && opts.strictSchema)
      (0, util_1.checkStrictMode)(it, "default is ignored in the schema root");
  }
  function updateContext(it) {
    const schId = it.schema[it.opts.schemaId];
    if (schId)
      it.baseId = (0, resolve_1.resolveUrl)(it.opts.uriResolver, it.baseId, schId);
  }
  function checkAsyncSchema(it) {
    if (it.schema.$async && !it.schemaEnv.$async)
      throw new Error("async schema in sync schema");
  }
  function commentKeyword({ gen, schemaEnv, schema, errSchemaPath, opts }) {
    const msg = schema.$comment;
    if (opts.$comment === true)
      gen.code((0, codegen_1._)`${names_1.default.self}.logger.log(${msg})`);
    else if (typeof opts.$comment == "function") {
      const schemaPath = (0, codegen_1.str)`${errSchemaPath}/$comment`;
      const rootName = gen.scopeValue("root", { ref: schemaEnv.root });
      gen.code((0, codegen_1._)`${names_1.default.self}.opts.$comment(${msg}, ${schemaPath}, ${rootName}.schema)`);
    }
  }
  function returnResults(it) {
    const { gen, schemaEnv, validateName, ValidationError, opts } = it;
    if (schemaEnv.$async)
      gen.if((0, codegen_1._)`${names_1.default.errors} === 0`, () => gen.return(names_1.default.data), () => gen.throw((0, codegen_1._)`new ${ValidationError}(${names_1.default.vErrors})`));
    else {
      gen.assign((0, codegen_1._)`${validateName}.errors`, names_1.default.vErrors);
      if (opts.unevaluated)
        assignEvaluated(it);
      gen.return((0, codegen_1._)`${names_1.default.errors} === 0`);
    }
  }
  function assignEvaluated({ gen, evaluated, props, items }) {
    if (props instanceof codegen_1.Name)
      gen.assign((0, codegen_1._)`${evaluated}.props`, props);
    if (items instanceof codegen_1.Name)
      gen.assign((0, codegen_1._)`${evaluated}.items`, items);
  }
  function schemaKeywords(it, types, typeErrors, errsCount) {
    const { gen, schema, data, allErrors, opts, self } = it;
    const { RULES } = self;
    if (schema.$ref && (opts.ignoreKeywordsWithRef || !(0, util_1.schemaHasRulesButRef)(schema, RULES))) {
      gen.block(() => keywordCode(it, "$ref", RULES.all.$ref.definition));
      return;
    }
    if (!opts.jtd)
      checkStrictTypes(it, types);
    gen.block(() => {
      for (const group of RULES.rules)
        groupKeywords(group);
      groupKeywords(RULES.post);
    });
    function groupKeywords(group) {
      if (!(0, applicability_1.shouldUseGroup)(schema, group))
        return;
      if (group.type) {
        gen.if((0, dataType_2.checkDataType)(group.type, data, opts.strictNumbers));
        iterateKeywords(it, group);
        if (types.length === 1 && types[0] === group.type && typeErrors) {
          gen.else();
          (0, dataType_2.reportTypeError)(it);
        }
        gen.endIf();
      } else
        iterateKeywords(it, group);
      if (!allErrors)
        gen.if((0, codegen_1._)`${names_1.default.errors} === ${errsCount || 0}`);
    }
  }
  function iterateKeywords(it, group) {
    const { gen, schema, opts: { useDefaults } } = it;
    if (useDefaults)
      (0, defaults_1.assignDefaults)(it, group.type);
    gen.block(() => {
      for (const rule of group.rules)
        if ((0, applicability_1.shouldUseRule)(schema, rule))
          keywordCode(it, rule.keyword, rule.definition, group.type);
    });
  }
  function checkStrictTypes(it, types) {
    if (it.schemaEnv.meta || !it.opts.strictTypes)
      return;
    checkContextTypes(it, types);
    if (!it.opts.allowUnionTypes)
      checkMultipleTypes(it, types);
    checkKeywordTypes(it, it.dataTypes);
  }
  function checkContextTypes(it, types) {
    if (!types.length)
      return;
    if (!it.dataTypes.length) {
      it.dataTypes = types;
      return;
    }
    types.forEach((t) => {
      if (!includesType(it.dataTypes, t))
        strictTypesError(it, `type "${t}" not allowed by context "${it.dataTypes.join(",")}"`);
    });
    narrowSchemaTypes(it, types);
  }
  function checkMultipleTypes(it, ts) {
    if (ts.length > 1 && !(ts.length === 2 && ts.includes("null")))
      strictTypesError(it, "use allowUnionTypes to allow union type keyword");
  }
  function checkKeywordTypes(it, ts) {
    const rules = it.self.RULES.all;
    for (const keyword in rules) {
      const rule = rules[keyword];
      if (typeof rule == "object" && (0, applicability_1.shouldUseRule)(it.schema, rule)) {
        const { type } = rule.definition;
        if (type.length && !type.some((t) => hasApplicableType(ts, t)))
          strictTypesError(it, `missing type "${type.join(",")}" for keyword "${keyword}"`);
      }
    }
  }
  function hasApplicableType(schTs, kwdT) {
    return schTs.includes(kwdT) || kwdT === "number" && schTs.includes("integer");
  }
  function includesType(ts, t) {
    return ts.includes(t) || t === "integer" && ts.includes("number");
  }
  function narrowSchemaTypes(it, withTypes) {
    const ts = [];
    for (const t of it.dataTypes)
      if (includesType(withTypes, t))
        ts.push(t);
      else if (withTypes.includes("integer") && t === "number")
        ts.push("integer");
    it.dataTypes = ts;
  }
  function strictTypesError(it, msg) {
    const schemaPath = it.schemaEnv.baseId + it.errSchemaPath;
    msg += ` at "${schemaPath}" (strictTypes)`;
    (0, util_1.checkStrictMode)(it, msg, it.opts.strictTypes);
  }
  var KeywordCxt = class {
    constructor(it, def, keyword) {
      (0, keyword_1.validateKeywordUsage)(it, def, keyword);
      this.gen = it.gen;
      this.allErrors = it.allErrors;
      this.keyword = keyword;
      this.data = it.data;
      this.schema = it.schema[keyword];
      this.$data = def.$data && it.opts.$data && this.schema && this.schema.$data;
      this.schemaValue = (0, util_1.schemaRefOrVal)(it, this.schema, keyword, this.$data);
      this.schemaType = def.schemaType;
      this.parentSchema = it.schema;
      this.params = {};
      this.it = it;
      this.def = def;
      if (this.$data)
        this.schemaCode = it.gen.const("vSchema", getData(this.$data, it));
      else {
        this.schemaCode = this.schemaValue;
        if (!(0, keyword_1.validSchemaType)(this.schema, def.schemaType, def.allowUndefined))
          throw new Error(`${keyword} value must be ${JSON.stringify(def.schemaType)}`);
      }
      if ("code" in def ? def.trackErrors : def.errors !== false)
        this.errsCount = it.gen.const("_errs", names_1.default.errors);
    }
    result(condition, successAction, failAction) {
      this.failResult((0, codegen_1.not)(condition), successAction, failAction);
    }
    failResult(condition, successAction, failAction) {
      this.gen.if(condition);
      if (failAction)
        failAction();
      else
        this.error();
      if (successAction) {
        this.gen.else();
        successAction();
        if (this.allErrors)
          this.gen.endIf();
      } else if (this.allErrors)
        this.gen.endIf();
      else
        this.gen.else();
    }
    pass(condition, failAction) {
      this.failResult((0, codegen_1.not)(condition), undefined, failAction);
    }
    fail(condition) {
      if (condition === undefined) {
        this.error();
        if (!this.allErrors)
          this.gen.if(false);
        return;
      }
      this.gen.if(condition);
      this.error();
      if (this.allErrors)
        this.gen.endIf();
      else
        this.gen.else();
    }
    fail$data(condition) {
      if (!this.$data)
        return this.fail(condition);
      const { schemaCode } = this;
      this.fail((0, codegen_1._)`${schemaCode} !== undefined && (${(0, codegen_1.or)(this.invalid$data(), condition)})`);
    }
    error(append, errorParams, errorPaths) {
      if (errorParams) {
        this.setParams(errorParams);
        this._error(append, errorPaths);
        this.setParams({});
        return;
      }
      this._error(append, errorPaths);
    }
    _error(append, errorPaths) {
      (append ? errors_1.reportExtraError : errors_1.reportError)(this, this.def.error, errorPaths);
    }
    $dataError() {
      (0, errors_1.reportError)(this, this.def.$dataError || errors_1.keyword$DataError);
    }
    reset() {
      if (this.errsCount === undefined)
        throw new Error('add "trackErrors" to keyword definition');
      (0, errors_1.resetErrorsCount)(this.gen, this.errsCount);
    }
    ok(cond) {
      if (!this.allErrors)
        this.gen.if(cond);
    }
    setParams(obj, assign) {
      if (assign)
        Object.assign(this.params, obj);
      else
        this.params = obj;
    }
    block$data(valid, codeBlock, $dataValid = codegen_1.nil) {
      this.gen.block(() => {
        this.check$data(valid, $dataValid);
        codeBlock();
      });
    }
    check$data(valid = codegen_1.nil, $dataValid = codegen_1.nil) {
      if (!this.$data)
        return;
      const { gen, schemaCode, schemaType, def } = this;
      gen.if((0, codegen_1.or)((0, codegen_1._)`${schemaCode} === undefined`, $dataValid));
      if (valid !== codegen_1.nil)
        gen.assign(valid, true);
      if (schemaType.length || def.validateSchema) {
        gen.elseIf(this.invalid$data());
        this.$dataError();
        if (valid !== codegen_1.nil)
          gen.assign(valid, false);
      }
      gen.else();
    }
    invalid$data() {
      const { gen, schemaCode, schemaType, def, it } = this;
      return (0, codegen_1.or)(wrong$DataType(), invalid$DataSchema());
      function wrong$DataType() {
        if (schemaType.length) {
          if (!(schemaCode instanceof codegen_1.Name))
            throw new Error("ajv implementation error");
          const st = Array.isArray(schemaType) ? schemaType : [schemaType];
          return (0, codegen_1._)`${(0, dataType_2.checkDataTypes)(st, schemaCode, it.opts.strictNumbers, dataType_2.DataType.Wrong)}`;
        }
        return codegen_1.nil;
      }
      function invalid$DataSchema() {
        if (def.validateSchema) {
          const validateSchemaRef = gen.scopeValue("validate$data", { ref: def.validateSchema });
          return (0, codegen_1._)`!${validateSchemaRef}(${schemaCode})`;
        }
        return codegen_1.nil;
      }
    }
    subschema(appl, valid) {
      const subschema = (0, subschema_1.getSubschema)(this.it, appl);
      (0, subschema_1.extendSubschemaData)(subschema, this.it, appl);
      (0, subschema_1.extendSubschemaMode)(subschema, appl);
      const nextContext = {
        ...this.it,
        ...subschema,
        items: undefined,
        props: undefined
      };
      subschemaCode(nextContext, valid);
      return nextContext;
    }
    mergeEvaluated(schemaCxt, toName) {
      const { it, gen } = this;
      if (!it.opts.unevaluated)
        return;
      if (it.props !== true && schemaCxt.props !== undefined)
        it.props = util_1.mergeEvaluated.props(gen, schemaCxt.props, it.props, toName);
      if (it.items !== true && schemaCxt.items !== undefined)
        it.items = util_1.mergeEvaluated.items(gen, schemaCxt.items, it.items, toName);
    }
    mergeValidEvaluated(schemaCxt, valid) {
      const { it, gen } = this;
      if (it.opts.unevaluated && (it.props !== true || it.items !== true)) {
        gen.if(valid, () => this.mergeEvaluated(schemaCxt, codegen_1.Name));
        return true;
      }
    }
  };
  exports.KeywordCxt = KeywordCxt;
  function keywordCode(it, keyword, def, ruleType) {
    const cxt = new KeywordCxt(it, def, keyword);
    if ("code" in def)
      def.code(cxt, ruleType);
    else if (cxt.$data && def.validate)
      (0, keyword_1.funcKeywordCode)(cxt, def);
    else if ("macro" in def)
      (0, keyword_1.macroKeywordCode)(cxt, def);
    else if (def.compile || def.validate)
      (0, keyword_1.funcKeywordCode)(cxt, def);
  }
  const JSON_POINTER = /^\/(?:[^~]|~0|~1)*$/;
  const RELATIVE_JSON_POINTER = /^([0-9]+)(#|\/(?:[^~]|~0|~1)*)?$/;
  function getData($data, { dataLevel, dataNames, dataPathArr }) {
    let jsonPointer;
    let data;
    if ($data === "")
      return names_1.default.rootData;
    if ($data[0] === "/") {
      if (!JSON_POINTER.test($data))
        throw new Error(`Invalid JSON-pointer: ${$data}`);
      jsonPointer = $data;
      data = names_1.default.rootData;
    } else {
      const matches = RELATIVE_JSON_POINTER.exec($data);
      if (!matches)
        throw new Error(`Invalid JSON-pointer: ${$data}`);
      const up = +matches[1];
      jsonPointer = matches[2];
      if (jsonPointer === "#") {
        if (up >= dataLevel)
          throw new Error(errorMsg("property/index", up));
        return dataPathArr[dataLevel - up];
      }
      if (up > dataLevel)
        throw new Error(errorMsg("data", up));
      data = dataNames[dataLevel - up];
      if (!jsonPointer)
        return data;
    }
    let expr = data;
    const segments = jsonPointer.split("/");
    for (const segment of segments)
      if (segment) {
        data = (0, codegen_1._)`${data}${(0, codegen_1.getProperty)((0, util_1.unescapeJsonPointer)(segment))}`;
        expr = (0, codegen_1._)`${expr} && ${data}`;
      }
    return expr;
    function errorMsg(pointerType, up) {
      return `Cannot access ${pointerType} ${up} levels up, current level is ${dataLevel}`;
    }
  }
  exports.getData = getData;
});
var require_validation_error = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  var ValidationError = class extends Error {
    constructor(errors) {
      super("validation failed");
      this.errors = errors;
      this.ajv = this.validation = true;
    }
  };
  exports.default = ValidationError;
});
var require_ref_error = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const resolve_1 = require_resolve();
  var MissingRefError = class extends Error {
    constructor(resolver, baseId, ref, msg) {
      super(msg || `can't resolve reference ${ref} from id ${baseId}`);
      this.missingRef = (0, resolve_1.resolveUrl)(resolver, baseId, ref);
      this.missingSchema = (0, resolve_1.normalizeId)((0, resolve_1.getFullPath)(resolver, this.missingRef));
    }
  };
  exports.default = MissingRefError;
});
var require_compile = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.resolveSchema = exports.getCompilingSchema = exports.resolveRef = exports.compileSchema = exports.SchemaEnv = undefined;
  const codegen_1 = require_codegen();
  const validation_error_1 = require_validation_error();
  const names_1 = require_names();
  const resolve_1 = require_resolve();
  const util_1 = require_util();
  const validate_1 = require_validate();
  var SchemaEnv = class {
    constructor(env) {
      var _a;
      this.refs = {};
      this.dynamicAnchors = {};
      let schema;
      if (typeof env.schema == "object")
        schema = env.schema;
      this.schema = env.schema;
      this.schemaId = env.schemaId;
      this.root = env.root || this;
      this.baseId = (_a = env.baseId) !== null && _a !== undefined ? _a : (0, resolve_1.normalizeId)(schema === null || schema === undefined ? undefined : schema[env.schemaId || "$id"]);
      this.schemaPath = env.schemaPath;
      this.localRefs = env.localRefs;
      this.meta = env.meta;
      this.$async = schema === null || schema === undefined ? undefined : schema.$async;
      this.refs = {};
    }
  };
  exports.SchemaEnv = SchemaEnv;
  function compileSchema(sch) {
    const _sch = getCompilingSchema.call(this, sch);
    if (_sch)
      return _sch;
    const rootId = (0, resolve_1.getFullPath)(this.opts.uriResolver, sch.root.baseId);
    const { es5, lines } = this.opts.code;
    const { ownProperties } = this.opts;
    const gen = new codegen_1.CodeGen(this.scope, {
      es5,
      lines,
      ownProperties
    });
    let _ValidationError;
    if (sch.$async)
      _ValidationError = gen.scopeValue("Error", {
        ref: validation_error_1.default,
        code: (0, codegen_1._)`require("ajv/dist/runtime/validation_error").default`
      });
    const validateName = gen.scopeName("validate");
    sch.validateName = validateName;
    const schemaCxt = {
      gen,
      allErrors: this.opts.allErrors,
      data: names_1.default.data,
      parentData: names_1.default.parentData,
      parentDataProperty: names_1.default.parentDataProperty,
      dataNames: [names_1.default.data],
      dataPathArr: [codegen_1.nil],
      dataLevel: 0,
      dataTypes: [],
      definedProperties: /* @__PURE__ */ new Set,
      topSchemaRef: gen.scopeValue("schema", this.opts.code.source === true ? {
        ref: sch.schema,
        code: (0, codegen_1.stringify)(sch.schema)
      } : { ref: sch.schema }),
      validateName,
      ValidationError: _ValidationError,
      schema: sch.schema,
      schemaEnv: sch,
      rootId,
      baseId: sch.baseId || rootId,
      schemaPath: codegen_1.nil,
      errSchemaPath: sch.schemaPath || (this.opts.jtd ? "" : "#"),
      errorPath: (0, codegen_1._)`""`,
      opts: this.opts,
      self: this
    };
    let sourceCode;
    try {
      this._compilations.add(sch);
      (0, validate_1.validateFunctionCode)(schemaCxt);
      gen.optimize(this.opts.code.optimize);
      const validateCode = gen.toString();
      sourceCode = `${gen.scopeRefs(names_1.default.scope)}return ${validateCode}`;
      if (this.opts.code.process)
        sourceCode = this.opts.code.process(sourceCode, sch);
      const validate = new Function(`${names_1.default.self}`, `${names_1.default.scope}`, sourceCode)(this, this.scope.get());
      this.scope.value(validateName, { ref: validate });
      validate.errors = null;
      validate.schema = sch.schema;
      validate.schemaEnv = sch;
      if (sch.$async)
        validate.$async = true;
      if (this.opts.code.source === true)
        validate.source = {
          validateName,
          validateCode,
          scopeValues: gen._values
        };
      if (this.opts.unevaluated) {
        const { props, items } = schemaCxt;
        validate.evaluated = {
          props: props instanceof codegen_1.Name ? undefined : props,
          items: items instanceof codegen_1.Name ? undefined : items,
          dynamicProps: props instanceof codegen_1.Name,
          dynamicItems: items instanceof codegen_1.Name
        };
        if (validate.source)
          validate.source.evaluated = (0, codegen_1.stringify)(validate.evaluated);
      }
      sch.validate = validate;
      return sch;
    } catch (e) {
      delete sch.validate;
      delete sch.validateName;
      if (sourceCode)
        this.logger.error("Error compiling schema, function code:", sourceCode);
      throw e;
    } finally {
      this._compilations.delete(sch);
    }
  }
  exports.compileSchema = compileSchema;
  function resolveRef(root, baseId, ref) {
    var _a;
    ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, ref);
    const schOrFunc = root.refs[ref];
    if (schOrFunc)
      return schOrFunc;
    let _sch = resolve.call(this, root, ref);
    if (_sch === undefined) {
      const schema = (_a = root.localRefs) === null || _a === undefined ? undefined : _a[ref];
      const { schemaId } = this.opts;
      if (schema)
        _sch = new SchemaEnv({
          schema,
          schemaId,
          root,
          baseId
        });
    }
    if (_sch === undefined)
      return;
    return root.refs[ref] = inlineOrCompile.call(this, _sch);
  }
  exports.resolveRef = resolveRef;
  function inlineOrCompile(sch) {
    if ((0, resolve_1.inlineRef)(sch.schema, this.opts.inlineRefs))
      return sch.schema;
    return sch.validate ? sch : compileSchema.call(this, sch);
  }
  function getCompilingSchema(schEnv) {
    for (const sch of this._compilations)
      if (sameSchemaEnv(sch, schEnv))
        return sch;
  }
  exports.getCompilingSchema = getCompilingSchema;
  function sameSchemaEnv(s1, s2) {
    return s1.schema === s2.schema && s1.root === s2.root && s1.baseId === s2.baseId;
  }
  function resolve(root, ref) {
    let sch;
    while (typeof (sch = this.refs[ref]) == "string")
      ref = sch;
    return sch || this.schemas[ref] || resolveSchema.call(this, root, ref);
  }
  function resolveSchema(root, ref) {
    const p = this.opts.uriResolver.parse(ref);
    const refPath = (0, resolve_1._getFullPath)(this.opts.uriResolver, p);
    let baseId = (0, resolve_1.getFullPath)(this.opts.uriResolver, root.baseId, undefined);
    if (Object.keys(root.schema).length > 0 && refPath === baseId)
      return getJsonPointer.call(this, p, root);
    const id = (0, resolve_1.normalizeId)(refPath);
    const schOrRef = this.refs[id] || this.schemas[id];
    if (typeof schOrRef == "string") {
      const sch = resolveSchema.call(this, root, schOrRef);
      if (typeof (sch === null || sch === undefined ? undefined : sch.schema) !== "object")
        return;
      return getJsonPointer.call(this, p, sch);
    }
    if (typeof (schOrRef === null || schOrRef === undefined ? undefined : schOrRef.schema) !== "object")
      return;
    if (!schOrRef.validate)
      compileSchema.call(this, schOrRef);
    if (id === (0, resolve_1.normalizeId)(ref)) {
      const { schema } = schOrRef;
      const { schemaId } = this.opts;
      const schId = schema[schemaId];
      if (schId)
        baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
      return new SchemaEnv({
        schema,
        schemaId,
        root,
        baseId
      });
    }
    return getJsonPointer.call(this, p, schOrRef);
  }
  exports.resolveSchema = resolveSchema;
  const PREVENT_SCOPE_CHANGE = new Set([
    "properties",
    "patternProperties",
    "enum",
    "dependencies",
    "definitions"
  ]);
  function getJsonPointer(parsedRef, { baseId, schema, root }) {
    var _a;
    if (((_a = parsedRef.fragment) === null || _a === undefined ? undefined : _a[0]) !== "/")
      return;
    for (const part of parsedRef.fragment.slice(1).split("/")) {
      if (typeof schema === "boolean")
        return;
      const partSchema = schema[(0, util_1.unescapeFragment)(part)];
      if (partSchema === undefined)
        return;
      schema = partSchema;
      const schId = typeof schema === "object" && schema[this.opts.schemaId];
      if (!PREVENT_SCOPE_CHANGE.has(part) && schId)
        baseId = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schId);
    }
    let env;
    if (typeof schema != "boolean" && schema.$ref && !(0, util_1.schemaHasRulesButRef)(schema, this.RULES)) {
      const $ref = (0, resolve_1.resolveUrl)(this.opts.uriResolver, baseId, schema.$ref);
      env = resolveSchema.call(this, root, $ref);
    }
    const { schemaId } = this.opts;
    env = env || new SchemaEnv({
      schema,
      schemaId,
      root,
      baseId
    });
    if (env.schema !== env.root.schema)
      return env;
  }
});
var require_data = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $id: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#",
    description: "Meta-schema for $data reference (JSON AnySchema extension proposal)",
    type: "object",
    required: ["$data"],
    properties: { $data: {
      type: "string",
      anyOf: [{ format: "relative-json-pointer" }, { format: "json-pointer" }]
    } },
    additionalProperties: false
  };
});
var require_utils = /* @__PURE__ */ __commonJSMin((exports, module) => {
  const isUUID = RegExp.prototype.test.bind(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
  const isIPv4 = RegExp.prototype.test.bind(/^(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)$/u);
  const isPort = RegExp.prototype.test.bind(/^\d*$/u);
  const isHexPair = RegExp.prototype.test.bind(/^[\da-f]{2}$/iu);
  const isUnreserved = RegExp.prototype.test.bind(/^[\da-z\-._~]$/iu);
  const isPathCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/]$/u);
  const isQueryFragmentCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/u);
  const isUserinfoCharacter = RegExp.prototype.test.bind(/^[A-Za-z0-9\-._~!$&'()*+,;=:]$/u);
  const BYTE_HEX = new Array(256);
  {
    const HEX_DIGITS = "0123456789ABCDEF";
    for (let i = 0;i < 256; i++)
      BYTE_HEX[i] = "%" + HEX_DIGITS[i >> 4] + HEX_DIGITS[i & 15];
  }
  function percentEncodeNonAscii(cp) {
    if (cp < 2048)
      return BYTE_HEX[192 | cp >> 6] + BYTE_HEX[128 | cp & 63];
    if (cp < 65536)
      return BYTE_HEX[224 | cp >> 12] + BYTE_HEX[128 | cp >> 6 & 63] + BYTE_HEX[128 | cp & 63];
    return BYTE_HEX[240 | cp >> 18] + BYTE_HEX[128 | cp >> 12 & 63] + BYTE_HEX[128 | cp >> 6 & 63] + BYTE_HEX[128 | cp & 63];
  }
  function stringArrayToHexStripped(input) {
    let acc = "";
    let code = 0;
    let i = 0;
    for (i = 0;i < input.length; i++) {
      code = input[i].charCodeAt(0);
      if (code === 48)
        continue;
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102))
        return "";
      acc += input[i];
      break;
    }
    for (i += 1;i < input.length; i++) {
      code = input[i].charCodeAt(0);
      if (!(code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102))
        return "";
      acc += input[i];
    }
    return acc;
  }
  const isHextet = RegExp.prototype.test.bind(/^[\dA-Fa-f]{1,4}$/);
  const isIPvFuture = RegExp.prototype.test.bind(/^[vV][\dA-Fa-f]+\.[A-Za-z\d\-._~!$&'()*+,;=:]+$/);
  const isZoneCharacter = RegExp.prototype.test.bind(/^[A-Za-z\d\-._~]$/);
  const nonSimpleDomain = RegExp.prototype.test.bind(/[^!"$&'()*+,\-.;=_`a-z{}~]/u);
  function isZoneIdentifier(zone) {
    if (zone.length === 0)
      return false;
    for (let i = 0;i < zone.length; i++) {
      if (isZoneCharacter(zone[i]))
        continue;
      if (zone[i] === "%" && i + 2 < zone.length && isHexPair(zone.slice(i + 1, i + 3))) {
        i += 2;
        continue;
      }
      return false;
    }
    return true;
  }
  function compressIPv6ZeroRun(hextets) {
    let bestStart = -1;
    let bestLength = 0;
    let runStart = -1;
    let runLength = 0;
    for (let i = 0;i < hextets.length; i++)
      if (hextets[i] === "0") {
        if (runStart === -1)
          runStart = i;
        runLength++;
        if (runLength > bestLength) {
          bestLength = runLength;
          bestStart = runStart;
        }
      } else {
        runStart = -1;
        runLength = 0;
      }
    if (bestLength < 2)
      return hextets.join(":");
    const head = hextets.slice(0, bestStart).join(":");
    const tail = hextets.slice(bestStart + bestLength).join(":");
    return head + "::" + tail;
  }
  function normalizeIPv6Address(input) {
    const compression = input.indexOf("::");
    if (compression !== -1 && input.indexOf("::", compression + 1) !== -1)
      return;
    const left = compression === -1 ? input.split(":") : input.slice(0, compression).split(":");
    const right = compression === -1 ? [] : input.slice(compression + 2).split(":");
    if (compression !== -1) {
      if (left.length === 1 && left[0] === "")
        left.length = 0;
      if (right.length === 1 && right[0] === "")
        right.length = 0;
    }
    const parts = left.concat(right);
    let hextetCount = 0;
    for (let i = 0;i < parts.length; i++) {
      const part = parts[i];
      if (part === "")
        return;
      if (part.indexOf(".") !== -1) {
        if (i !== parts.length - 1 || compression !== -1 && right.length === 0 || !isIPv4(part))
          return;
        hextetCount += 2;
        continue;
      }
      if (!isHextet(part))
        return;
      parts[i] = parseInt(part, 16).toString(16);
      hextetCount++;
    }
    if (compression === -1) {
      if (hextetCount !== 8)
        return;
      return compressIPv6ZeroRun(parts);
    }
    if (hextetCount >= 8)
      return;
    const expanded = parts.slice(0, left.length);
    for (let i = hextetCount;i < 8; i++)
      expanded.push("0");
    for (let i = left.length;i < parts.length; i++)
      expanded.push(parts[i]);
    return compressIPv6ZeroRun(expanded);
  }
  function normalizeIPv6(host) {
    const bracketed = host[0] === "[" && host[host.length - 1] === "]";
    if ((host[0] === "[" || host[host.length - 1] === "]") && !bracketed)
      return {
        host,
        isIPV6: false,
        error: true
      };
    let input = bracketed ? host.slice(1, -1) : host;
    if (bracketed && isIPvFuture(input)) {
      input = input.toLowerCase();
      return {
        host: `[${input}]`,
        escapedHost: input,
        isIPV6: false,
        isIPVFuture: true
      };
    }
    if (findToken(input, ":") < 2)
      return {
        host,
        isIPV6: false,
        error: bracketed
      };
    let zoneIdentifier = "";
    const zoneSeparator = input.indexOf("%");
    if (zoneSeparator !== -1) {
      const separatorLength = input.slice(zoneSeparator, zoneSeparator + 3).toLowerCase() === "%25" ? 3 : 1;
      zoneIdentifier = input.slice(zoneSeparator + separatorLength);
      if (!isZoneIdentifier(zoneIdentifier))
        return {
          host,
          isIPV6: false,
          error: true
        };
      input = input.slice(0, zoneSeparator);
    }
    const address = normalizeIPv6Address(input);
    if (address === undefined)
      return {
        host,
        isIPV6: false,
        error: true
      };
    return {
      host: address + (zoneIdentifier ? "%" + zoneIdentifier : ""),
      escapedHost: address + (zoneIdentifier ? "%25" + zoneIdentifier : ""),
      isIPV6: true
    };
  }
  function findToken(str, token) {
    let ind = 0;
    for (let i = 0;i < str.length; i++)
      if (str[i] === token)
        ind++;
    return ind;
  }
  function removeDotSegments(path) {
    let input = path;
    const output = [];
    let nextSlash = -1;
    let len = 0;
    while (len = input.length) {
      if (len === 1)
        if (input === ".")
          break;
        else if (input === "/") {
          output.push("/");
          break;
        } else {
          output.push(input);
          break;
        }
      else if (len === 2) {
        if (input[0] === ".") {
          if (input[1] === ".")
            break;
          else if (input[1] === "/") {
            input = input.slice(2);
            continue;
          }
        } else if (input[0] === "/") {
          if (input[1] === "." || input[1] === "/") {
            output.push("/");
            break;
          }
        }
      } else if (len === 3) {
        if (input === "/..") {
          if (output.length !== 0)
            output.pop();
          output.push("/");
          break;
        }
      }
      if (input[0] === ".") {
        if (input[1] === ".") {
          if (input[2] === "/") {
            input = input.slice(3);
            continue;
          }
        } else if (input[1] === "/") {
          input = input.slice(2);
          continue;
        }
      } else if (input[0] === "/") {
        if (input[1] === ".") {
          if (input[2] === "/") {
            input = input.slice(2);
            continue;
          } else if (input[2] === ".") {
            if (input[3] === "/") {
              input = input.slice(3);
              if (output.length !== 0)
                output.pop();
              continue;
            }
          }
        }
      }
      if ((nextSlash = input.indexOf("/", 1)) === -1) {
        output.push(input);
        break;
      } else {
        output.push(input.slice(0, nextSlash));
        input = input.slice(nextSlash);
      }
    }
    return output.join("");
  }
  const HOST_DELIMS = {
    "@": "%40",
    "/": "%2F",
    "?": "%3F",
    "#": "%23",
    ":": "%3A"
  };
  const HOST_DELIM_RE = /[@/?#:]/g;
  const HOST_DELIM_NO_COLON_RE = /[@/?#]/g;
  function reescapeHostDelimiters(host, isIP) {
    const re = isIP ? HOST_DELIM_NO_COLON_RE : HOST_DELIM_RE;
    re.lastIndex = 0;
    return host.replace(re, (ch) => HOST_DELIMS[ch]);
  }
  function normalizePercentEncoding(input, decodeUnreserved = false) {
    if (input.indexOf("%") === -1)
      return input;
    let output = "";
    for (let i = 0;i < input.length; i++) {
      if (input[i] === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (isHexPair(hex)) {
          const normalizedHex = hex.toUpperCase();
          const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
          if (decodeUnreserved && isUnreserved(decoded))
            output += decoded;
          else
            output += "%" + normalizedHex;
          i += 2;
          continue;
        }
      }
      output += input[i];
    }
    return output;
  }
  function normalizePathEncoding(input) {
    let output = "";
    for (let i = 0;i < input.length; i++) {
      const ch = input[i];
      if (ch === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (isHexPair(hex)) {
          const normalizedHex = hex.toUpperCase();
          const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
          if (decoded !== "." && isUnreserved(decoded))
            output += decoded;
          else
            output += "%" + normalizedHex;
          i += 2;
          continue;
        }
      }
      if (isPathCharacter(ch))
        output += ch;
      else {
        const code = input.charCodeAt(i);
        if (code < 128)
          output += isEscapeSafe(code) ? ch : BYTE_HEX[code];
        else if (code < 55296 || code > 57343)
          output += percentEncodeNonAscii(code);
        else if (code <= 56319 && i + 1 < input.length) {
          const low = input.charCodeAt(i + 1);
          if (low >= 56320 && low <= 57343) {
            output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
            i++;
          } else
            output += percentEncodeNonAscii(65533);
        } else
          output += percentEncodeNonAscii(65533);
      }
    }
    return output;
  }
  function serializePathEncoding(input, pathNoScheme = false) {
    let output = "";
    let firstSegment = pathNoScheme && input[0] !== "/";
    for (let i = 0;i < input.length; i++) {
      const ch = input[i];
      if (ch === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (isHexPair(hex)) {
          output += "%" + hex.toUpperCase();
          i += 2;
          continue;
        }
      }
      if (ch === "/")
        firstSegment = false;
      if (isPathCharacter(ch) && (ch !== ":" || !firstSegment))
        output += ch;
      else {
        const code = input.charCodeAt(i);
        if (code < 128)
          output += BYTE_HEX[code];
        else if (code < 55296 || code > 57343)
          output += percentEncodeNonAscii(code);
        else if (code <= 56319 && i + 1 < input.length) {
          const low = input.charCodeAt(i + 1);
          if (low >= 56320 && low <= 57343) {
            output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
            i++;
          } else
            output += percentEncodeNonAscii(65533);
        } else
          output += percentEncodeNonAscii(65533);
      }
    }
    return output;
  }
  function encodeComponent(input, isAllowed) {
    let output = "";
    for (let i = 0;i < input.length; i++) {
      const ch = input[i];
      if (ch === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (isHexPair(hex)) {
          output += "%" + hex.toUpperCase();
          i += 2;
          continue;
        }
      }
      if (isAllowed(ch))
        output += ch;
      else {
        const code = input.charCodeAt(i);
        if (code < 128)
          output += BYTE_HEX[code];
        else if (code < 55296 || code > 57343)
          output += percentEncodeNonAscii(code);
        else if (code <= 56319 && i + 1 < input.length) {
          const low = input.charCodeAt(i + 1);
          if (low >= 56320 && low <= 57343) {
            output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
            i++;
          } else
            output += percentEncodeNonAscii(65533);
        } else
          output += percentEncodeNonAscii(65533);
      }
    }
    return output;
  }
  function encodeUserinfo(input) {
    return encodeComponent(input, isUserinfoCharacter);
  }
  function encodeQuery(input) {
    return encodeComponent(input, isQueryFragmentCharacter);
  }
  function encodeFragment(input) {
    return encodeComponent(input, isQueryFragmentCharacter);
  }
  function isEscapeSafe(cp) {
    return cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp === 42 || cp === 43 || cp === 45 || cp === 46 || cp === 47 || cp === 64 || cp === 95;
  }
  function normalizeQueryFragmentEncoding(input) {
    let output = "";
    for (let i = 0;i < input.length; i++) {
      const ch = input[i];
      if (ch === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (isHexPair(hex)) {
          const normalizedHex = hex.toUpperCase();
          const decoded = String.fromCharCode(parseInt(normalizedHex, 16));
          if (isUnreserved(decoded))
            output += decoded;
          else
            output += "%" + normalizedHex;
          i += 2;
          continue;
        }
      }
      if (isQueryFragmentCharacter(ch))
        output += ch;
      else {
        const code = input.charCodeAt(i);
        if (code < 128)
          output += isEscapeSafe(code) ? ch : BYTE_HEX[code];
        else if (code < 55296 || code > 57343)
          output += percentEncodeNonAscii(code);
        else if (code <= 56319 && i + 1 < input.length) {
          const low = input.charCodeAt(i + 1);
          if (low >= 56320 && low <= 57343) {
            output += percentEncodeNonAscii(65536 + (code - 55296 << 10) + (low - 56320));
            i++;
          } else
            output += percentEncodeNonAscii(65533);
        } else
          output += percentEncodeNonAscii(65533);
      }
    }
    return output;
  }
  function escapePreservingEscapes(input) {
    let output = "";
    for (let i = 0;i < input.length; i++) {
      if (input[i] === "%" && i + 2 < input.length) {
        const hex = input.slice(i + 1, i + 3);
        if (isHexPair(hex)) {
          output += "%" + hex.toUpperCase();
          i += 2;
          continue;
        }
      }
      output += escape(input[i]);
    }
    return output;
  }
  function recomposeAuthority(component) {
    const uriTokens = [];
    if (component.userinfo !== undefined) {
      uriTokens.push(encodeUserinfo(component.userinfo));
      uriTokens.push("@");
    }
    if (component.host !== undefined) {
      let host = component.host;
      if (!isIPv4(host)) {
        let ipV6res = normalizeIPv6(host);
        if (ipV6res.isIPV6 !== true && ipV6res.isIPVFuture !== true) {
          host = normalizePercentEncoding(host, true);
          ipV6res = normalizeIPv6(host);
        }
        if (ipV6res.isIPV6 === true || ipV6res.isIPVFuture === true)
          host = `[${ipV6res.escapedHost}]`;
        else
          host = reescapeHostDelimiters(host, false);
      }
      uriTokens.push(host);
    }
    if (typeof component.port === "number" || typeof component.port === "string") {
      const port = String(component.port);
      if (!isPort(port))
        throw new TypeError("URI port is malformed.");
      uriTokens.push(":");
      uriTokens.push(port);
    }
    return uriTokens.length ? uriTokens.join("") : undefined;
  }
  module.exports = {
    nonSimpleDomain,
    recomposeAuthority,
    reescapeHostDelimiters,
    normalizePercentEncoding,
    normalizePathEncoding,
    serializePathEncoding,
    normalizeQueryFragmentEncoding,
    encodeUserinfo,
    encodeQuery,
    encodeFragment,
    escapePreservingEscapes,
    removeDotSegments,
    isIPv4,
    isUUID,
    normalizeIPv6,
    stringArrayToHexStripped
  };
});
var require_schemes = /* @__PURE__ */ __commonJSMin((exports, module) => {
  const { isUUID } = require_utils();
  const URN_REG = /^([\da-z][\d\-a-z]{0,31}):((?:[\w!$'()*+,\-./:;=@]|%[\da-f]{2})+)$/iu;
  const supportedSchemeNames = [
    "http",
    "https",
    "ws",
    "wss",
    "urn",
    "urn:uuid"
  ];
  function isValidSchemeName(name) {
    return supportedSchemeNames.indexOf(name) !== -1;
  }
  function wsIsSecure(wsComponent) {
    if (wsComponent.secure === true)
      return true;
    else if (wsComponent.secure === false)
      return false;
    else if (wsComponent.scheme)
      return wsComponent.scheme.length === 3 && (wsComponent.scheme[0] === "w" || wsComponent.scheme[0] === "W") && (wsComponent.scheme[1] === "s" || wsComponent.scheme[1] === "S") && (wsComponent.scheme[2] === "s" || wsComponent.scheme[2] === "S");
    else
      return false;
  }
  function httpParse(component) {
    if (!component.host)
      component.error = component.error || "HTTP URIs must have a host.";
    return component;
  }
  function httpSerialize(component) {
    const secure = String(component.scheme).toLowerCase() === "https";
    if (component.port === (secure ? 443 : 80) || component.port === "")
      component.port = undefined;
    if (!component.path)
      component.path = "/";
    return component;
  }
  function wsParse(wsComponent) {
    wsComponent.secure = wsIsSecure(wsComponent);
    wsComponent.resourceName = (wsComponent.path || "/") + (wsComponent.query ? "?" + wsComponent.query : "");
    wsComponent.path = undefined;
    wsComponent.query = undefined;
    return wsComponent;
  }
  function wsSerialize(wsComponent) {
    if (wsComponent.port === (wsIsSecure(wsComponent) ? 443 : 80) || wsComponent.port === "")
      wsComponent.port = undefined;
    if (typeof wsComponent.secure === "boolean") {
      wsComponent.scheme = wsComponent.secure ? "wss" : "ws";
      wsComponent.secure = undefined;
    }
    if (wsComponent.resourceName) {
      const queryIndex = wsComponent.resourceName.indexOf("?");
      const path = queryIndex === -1 ? wsComponent.resourceName : wsComponent.resourceName.slice(0, queryIndex);
      wsComponent.path = path && path !== "/" ? path : undefined;
      wsComponent.query = queryIndex === -1 ? undefined : wsComponent.resourceName.slice(queryIndex + 1);
      wsComponent.resourceName = undefined;
    }
    wsComponent.fragment = undefined;
    return wsComponent;
  }
  function urnParse(urnComponent, options) {
    if (!urnComponent.path) {
      urnComponent.error = "URN can not be parsed";
      return urnComponent;
    }
    const matches = urnComponent.path.match(URN_REG);
    if (matches && matches[0] === urnComponent.path) {
      const scheme = options.scheme || urnComponent.scheme || "urn";
      urnComponent.nid = matches[1].toLowerCase();
      urnComponent.nss = matches[2];
      const schemeHandler = getSchemeHandler(`${scheme}:${options.nid || urnComponent.nid}`);
      urnComponent.path = undefined;
      if (schemeHandler)
        urnComponent = schemeHandler.parse(urnComponent, options);
    } else
      urnComponent.error = urnComponent.error || "URN can not be parsed.";
    return urnComponent;
  }
  function urnSerialize(urnComponent, options) {
    if (urnComponent.nid === undefined)
      throw new Error("URN without nid cannot be serialized");
    const scheme = options.scheme || urnComponent.scheme || "urn";
    const nid = urnComponent.nid.toLowerCase();
    const schemeHandler = getSchemeHandler(`${scheme}:${options.nid || nid}`);
    if (schemeHandler)
      urnComponent = schemeHandler.serialize(urnComponent, options);
    const uriComponent = urnComponent;
    const nss = urnComponent.nss;
    uriComponent.path = `${nid || options.nid}:${nss}`;
    options.skipEscape = true;
    return uriComponent;
  }
  function urnuuidParse(urnComponent, options) {
    const uuidComponent = urnComponent;
    uuidComponent.uuid = uuidComponent.nss;
    uuidComponent.nss = undefined;
    if (!options.tolerant && (!uuidComponent.uuid || !isUUID(uuidComponent.uuid)))
      uuidComponent.error = uuidComponent.error || "UUID is not valid.";
    return uuidComponent;
  }
  function urnuuidSerialize(uuidComponent) {
    const urnComponent = uuidComponent;
    urnComponent.nss = (uuidComponent.uuid || "").toLowerCase();
    return urnComponent;
  }
  const http = {
    scheme: "http",
    domainHost: true,
    parse: httpParse,
    serialize: httpSerialize
  };
  const https = {
    scheme: "https",
    domainHost: http.domainHost,
    parse: httpParse,
    serialize: httpSerialize
  };
  const ws = {
    scheme: "ws",
    domainHost: true,
    parse: wsParse,
    serialize: wsSerialize
  };
  const wss = {
    scheme: "wss",
    domainHost: ws.domainHost,
    parse: ws.parse,
    serialize: ws.serialize
  };
  const urn = {
    scheme: "urn",
    parse: urnParse,
    serialize: urnSerialize,
    skipNormalize: true
  };
  const urnuuid = {
    scheme: "urn:uuid",
    parse: urnuuidParse,
    serialize: urnuuidSerialize,
    skipNormalize: true
  };
  const SCHEMES = {
    http,
    https,
    ws,
    wss,
    urn,
    "urn:uuid": urnuuid
  };
  Object.setPrototypeOf(SCHEMES, null);
  function getSchemeHandler(scheme) {
    return scheme && (SCHEMES[scheme] || SCHEMES[scheme.toLowerCase()]) || undefined;
  }
  module.exports = {
    wsIsSecure,
    SCHEMES,
    isValidSchemeName,
    getSchemeHandler
  };
});
var require_fast_uri = /* @__PURE__ */ __commonJSMin((exports, module) => {
  const { normalizeIPv6, removeDotSegments, recomposeAuthority, normalizePercentEncoding, normalizePathEncoding, serializePathEncoding, normalizeQueryFragmentEncoding, encodeQuery, encodeFragment, reescapeHostDelimiters, isIPv4, nonSimpleDomain } = require_utils();
  const { SCHEMES, getSchemeHandler } = require_schemes();
  const VALID_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/u;
  const MALFORMED_SCHEME_ERROR = "URI scheme is malformed.";
  function decodeValidScheme(scheme) {
    const decodedScheme = unescape(String(scheme));
    if (!VALID_SCHEME.test(decodedScheme))
      throw new TypeError(MALFORMED_SCHEME_ERROR);
    return decodedScheme;
  }
  function normalize(uri, options) {
    if (typeof uri === "string")
      uri = normalizeString(uri, options);
    else if (typeof uri === "object")
      uri = parse(serialize(uri, options), options);
    return uri;
  }
  function resolve(baseURI, relativeURI, options) {
    const schemelessOptions = options ? Object.assign({ scheme: "null" }, options) : { scheme: "null" };
    const { parsed: baseParsed, malformedAuthorityOrPort: baseMalformed, malformedPercentEncoding: baseMalformedPercentEncoding, malformedSchemeSpecific: baseMalformedSchemeSpecific, malformedHost: baseMalformedHost, malformedScheme: baseMalformedScheme } = parseWithStatus(baseURI, schemelessOptions);
    const { parsed: relativeParsed, malformedAuthorityOrPort: relativeMalformed, malformedPercentEncoding: relativeMalformedPercentEncoding, malformedSchemeSpecific: relativeMalformedSchemeSpecific, malformedHost: relativeMalformedHost, malformedScheme: relativeMalformedScheme } = parseWithStatus(relativeURI, schemelessOptions);
    if (baseMalformed || relativeMalformed || baseMalformedPercentEncoding || relativeMalformedPercentEncoding || baseMalformedSchemeSpecific || relativeMalformedSchemeSpecific || baseMalformedHost || relativeMalformedHost || baseMalformedScheme || relativeMalformedScheme)
      throw new Error(baseParsed.error || relativeParsed.error || "URI is malformed.");
    const resolved = resolveComponent(baseParsed, relativeParsed, schemelessOptions, true);
    const resolvedSchemeHandler = getSchemeHandler(options && options.scheme || resolved.scheme);
    const resolvedHost = resolved.host;
    const resolvedHostIsIP = resolvedHost !== undefined && resolvedHost !== "" && (isIPv4(resolvedHost) || normalizeIPv6(resolvedHost).isIPV6);
    canonicalizeHost(resolved, options || {}, resolvedSchemeHandler, resolvedHostIsIP);
    const encodedASCIIHost = resolvedHost && resolvedHost.indexOf("%") !== -1 && !/\P{ASCII}/u.test(resolvedHost);
    if (resolved.error && !encodedASCIIHost)
      throw new Error(resolved.error);
    schemelessOptions.skipEscape = true;
    return serialize(resolved, schemelessOptions);
  }
  function resolveComponent(base, relative, options, skipNormalization) {
    const target = {};
    if (!skipNormalization) {
      base = parse(serialize(base, options), options);
      relative = parse(serialize(relative, options), options);
    }
    options = options || {};
    if (!options.tolerant && relative.scheme) {
      target.scheme = relative.scheme;
      target.userinfo = relative.userinfo;
      target.host = relative.host;
      target.port = relative.port;
      target.path = removeDotSegments(relative.path || "");
      target.query = relative.query;
    } else {
      if (relative.userinfo !== undefined || relative.host !== undefined || relative.port !== undefined) {
        target.userinfo = relative.userinfo;
        target.host = relative.host;
        target.port = relative.port;
        target.path = removeDotSegments(relative.path || "");
        target.query = relative.query;
      } else {
        if (!relative.path) {
          target.path = base.path;
          if (relative.query !== undefined)
            target.query = relative.query;
          else
            target.query = base.query;
        } else {
          if (relative.path[0] === "/")
            target.path = removeDotSegments(relative.path);
          else {
            if ((base.userinfo !== undefined || base.host !== undefined || base.port !== undefined) && !base.path)
              target.path = "/" + relative.path;
            else if (!base.path)
              target.path = relative.path;
            else
              target.path = base.path.slice(0, base.path.lastIndexOf("/") + 1) + relative.path;
            target.path = removeDotSegments(target.path);
          }
          target.query = relative.query;
        }
        target.userinfo = base.userinfo;
        target.host = base.host;
        target.port = base.port;
      }
      target.scheme = base.scheme;
    }
    target.fragment = relative.fragment;
    return target;
  }
  function equal(uriA, uriB, options) {
    const normalizedA = normalizeComparableURI(uriA, options);
    const normalizedB = normalizeComparableURI(uriB, options);
    return normalizedA !== undefined && normalizedB !== undefined && normalizedA === normalizedB;
  }
  function serialize(cmpts, opts) {
    const component = {
      host: cmpts.host,
      scheme: cmpts.scheme,
      userinfo: cmpts.userinfo,
      port: cmpts.port,
      path: cmpts.path,
      query: cmpts.query,
      nid: cmpts.nid,
      nss: cmpts.nss,
      uuid: cmpts.uuid,
      fragment: cmpts.fragment,
      reference: cmpts.reference,
      resourceName: cmpts.resourceName,
      secure: cmpts.secure,
      error: ""
    };
    const options = Object.assign({}, opts);
    const uriTokens = [];
    if (component.scheme)
      component.scheme = decodeValidScheme(component.scheme);
    const schemeHandler = getSchemeHandler(options.scheme || component.scheme);
    if (schemeHandler && schemeHandler.serialize)
      schemeHandler.serialize(component, options);
    const hasAuthority = component.userinfo !== undefined || component.host !== undefined || component.port !== undefined;
    const pathNoScheme = !options.skipEscape && component.scheme === undefined && !hasAuthority;
    if (component.path !== undefined)
      if (!options.skipEscape)
        component.path = serializePathEncoding(component.path, pathNoScheme);
      else
        component.path = normalizePercentEncoding(component.path);
    if (options.reference !== "suffix" && component.scheme) {
      component.scheme = decodeValidScheme(component.scheme);
      uriTokens.push(component.scheme, ":");
    }
    const authority = recomposeAuthority(component);
    if (authority !== undefined) {
      if (options.reference !== "suffix")
        uriTokens.push("//");
      uriTokens.push(authority);
      if (component.path && component.path[0] !== "/")
        uriTokens.push("/");
    }
    if (component.path !== undefined) {
      let s = component.path;
      if (!options.absolutePath && (!schemeHandler || !schemeHandler.absolutePath))
        s = removeDotSegments(s);
      if (pathNoScheme)
        s = serializePathEncoding(s, true);
      if (authority === undefined && s[0] === "/" && s[1] === "/")
        s = "/%2F" + s.slice(2);
      uriTokens.push(s);
    }
    if (component.query !== undefined)
      uriTokens.push("?", encodeQuery(component.query));
    if (component.fragment !== undefined)
      uriTokens.push("#", encodeFragment(component.fragment));
    return uriTokens.join("");
  }
  const URI_PARSE = /^(?:([^#/:?]+):)?(?:\/\/((?:([^#/?@]*)@)?(\[[^#/?\]]+\]|[^#/:?]*)(?::(\d*))?))?([^#?]*)(?:\?([^#]*))?(?:#((?:.|[\n\r])*))?/u;
  const AUTHORITY_PREFIX = /^(?:[^#/:?]+:)?\/\/([^/?#]*)/;
  const AUTHORITY_INTRODUCER_REGION = /^(?:[^#/:?]+:)?([/\\\t\n\r]*)/;
  function getParseError(parsed, matches) {
    if (matches[2] !== undefined && parsed.path && parsed.path[0] !== "/")
      return 'URI path must start with "/" when authority is present.';
    if (typeof parsed.port === "number" && (parsed.port < 0 || parsed.port > 65535))
      return "URI port is malformed.";
  }
  function hasMalformedPercentEncoding(component) {
    if (component === undefined)
      return false;
    let percent = component.indexOf("%");
    while (percent !== -1) {
      if (percent + 2 >= component.length || !/^[\da-f]{2}$/iu.test(component.slice(percent + 1, percent + 3)))
        return true;
      percent = component.indexOf("%", percent + 3);
    }
    return false;
  }
  function isIPLiteral(host) {
    return host[0] === "[" && host[host.length - 1] === "]";
  }
  function hasMalformedComponentPercentEncoding(matches) {
    const host = matches[4];
    return hasMalformedPercentEncoding(matches[3]) || host !== undefined && !isIPLiteral(host) && hasMalformedPercentEncoding(host) || hasMalformedPercentEncoding(matches[6]) || hasMalformedPercentEncoding(matches[7]) || hasMalformedPercentEncoding(matches[8]);
  }
  function canonicalizeHost(parsed, options, schemeHandler, isIP) {
    if (!options.unicodeSupport && (!schemeHandler || !schemeHandler.unicodeSupport) && parsed.host && !isIPLiteral(parsed.host) && (options.domainHost || schemeHandler && schemeHandler.domainHost) && isIP === false && nonSimpleDomain(parsed.host))
      try {
        parsed.host = new URL("http://" + parsed.host).hostname;
      } catch (e) {
        parsed.error = parsed.error || "Host's domain name can not be converted to ASCII: " + e;
        return true;
      }
    return false;
  }
  function parseWithStatus(uri, opts) {
    const options = Object.assign({}, opts);
    const parsed = {
      scheme: undefined,
      userinfo: undefined,
      host: "",
      port: undefined,
      path: "",
      query: undefined,
      fragment: undefined
    };
    let malformedAuthorityOrPort = false;
    let malformedPercentEncoding = false;
    let malformedSchemeSpecific = false;
    let malformedHost = false;
    let malformedIPLiteral = false;
    let malformedScheme = false;
    let isIP = false;
    if (options.reference === "suffix")
      if (options.scheme)
        uri = options.scheme + ":" + uri;
      else
        uri = "//" + uri;
    const authorityMatch = uri.match(AUTHORITY_PREFIX);
    if (authorityMatch !== null && authorityMatch[1].indexOf("\\") !== -1) {
      parsed.error = "URI authority must not contain a literal backslash.";
      malformedAuthorityOrPort = true;
    }
    const introducerMatch = uri.match(AUTHORITY_INTRODUCER_REGION);
    if (introducerMatch !== null) {
      const region = introducerMatch[1];
      const normalizedRegion = region.replace(/[\t\n\r]/g, "");
      if (normalizedRegion.length >= 2) {
        if (normalizedRegion.slice(0, 2) !== "//") {
          parsed.error = parsed.error || "URI authority must not contain a literal backslash.";
          malformedAuthorityOrPort = true;
        } else if (region.length !== normalizedRegion.length) {
          parsed.error = parsed.error || "URI authority introducer must not contain whitespace.";
          malformedAuthorityOrPort = true;
        }
      }
    }
    const matches = uri.match(URI_PARSE);
    if (matches) {
      parsed.scheme = matches[1];
      parsed.userinfo = matches[3];
      parsed.host = matches[4];
      parsed.port = parseInt(matches[5], 10);
      parsed.path = matches[6] || "";
      parsed.query = matches[7];
      parsed.fragment = matches[8];
      if (parsed.scheme !== undefined) {
        const decodedScheme = unescape(parsed.scheme);
        if (VALID_SCHEME.test(decodedScheme))
          parsed.scheme = decodedScheme.toLowerCase();
        else {
          parsed.error = parsed.error || MALFORMED_SCHEME_ERROR;
          malformedScheme = true;
        }
      }
      malformedPercentEncoding = hasMalformedComponentPercentEncoding(matches);
      if (malformedPercentEncoding)
        parsed.error = parsed.error || "URI contains malformed percent-encoding.";
      if (isNaN(parsed.port))
        parsed.port = matches[5];
      const parseError = getParseError(parsed, matches);
      if (parseError !== undefined) {
        parsed.error = parsed.error || parseError;
        malformedAuthorityOrPort = true;
      }
      if (parsed.host)
        if (isIPv4(parsed.host) === false) {
          const bracketedIPLiteral = isIPLiteral(parsed.host);
          const hasIPLiteralBracket = parsed.host.indexOf("[") !== -1 || parsed.host.indexOf("]") !== -1;
          const ipv6result = normalizeIPv6(parsed.host);
          isIP = ipv6result.isIPV6 || ipv6result.isIPVFuture === true;
          malformedIPLiteral = hasIPLiteralBracket && (!bracketedIPLiteral || ipv6result.error === true);
          parsed.host = isIP ? ipv6result.host : ipv6result.host.toLowerCase();
          if (malformedIPLiteral) {
            parsed.error = parsed.error || "URI host is malformed.";
            malformedAuthorityOrPort = true;
          }
        } else
          isIP = true;
      if (parsed.scheme === undefined && parsed.userinfo === undefined && parsed.host === undefined && parsed.port === undefined && parsed.query === undefined && !parsed.path)
        parsed.reference = "same-document";
      else if (parsed.scheme === undefined)
        parsed.reference = "relative";
      else if (parsed.fragment === undefined)
        parsed.reference = "absolute";
      else
        parsed.reference = "uri";
      if (options.reference && options.reference !== "suffix" && options.reference !== parsed.reference)
        parsed.error = parsed.error || "URI is not a " + options.reference + " reference.";
      const schemeHandler = getSchemeHandler(options.scheme || parsed.scheme);
      if (!malformedIPLiteral)
        malformedHost = canonicalizeHost(parsed, options, schemeHandler, isIP);
      if (uri.indexOf("%") !== -1 && parsed.host !== undefined && !malformedIPLiteral) {
        let host = isIP ? parsed.host : normalizePercentEncoding(parsed.host, true);
        if (!isIP)
          host = normalizePercentEncoding(host.toLowerCase());
        parsed.host = reescapeHostDelimiters(host, isIP);
      }
      if (!schemeHandler || schemeHandler && !schemeHandler.skipNormalize) {
        if (parsed.path)
          parsed.path = normalizePathEncoding(parsed.path);
        if (parsed.query)
          parsed.query = normalizeQueryFragmentEncoding(parsed.query);
        if (parsed.fragment)
          parsed.fragment = normalizeQueryFragmentEncoding(parsed.fragment);
      }
      if (schemeHandler && schemeHandler.parse) {
        schemeHandler.parse(parsed, options);
        if (schemeHandler === SCHEMES.urn && parsed.nid === undefined)
          malformedSchemeSpecific = true;
      }
    } else
      parsed.error = parsed.error || "URI can not be parsed.";
    return {
      parsed,
      malformedAuthorityOrPort,
      malformedPercentEncoding,
      malformedSchemeSpecific,
      malformedHost,
      malformedScheme
    };
  }
  function parse(uri, opts) {
    return parseWithStatus(uri, opts).parsed;
  }
  function normalizeString(uri, opts) {
    return normalizeStringWithStatus(uri, opts).normalized;
  }
  function normalizeStringWithStatus(uri, opts) {
    const { parsed, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme } = parseWithStatus(uri, opts);
    return {
      normalized: malformedAuthorityOrPort || malformedPercentEncoding || malformedSchemeSpecific || malformedHost || malformedScheme ? uri : serialize(parsed, opts),
      malformedAuthorityOrPort,
      malformedPercentEncoding,
      malformedSchemeSpecific,
      malformedHost,
      malformedScheme
    };
  }
  function normalizeComparableURI(uri, opts) {
    if (typeof uri !== "string" && typeof uri !== "object")
      return;
    let value;
    try {
      value = typeof uri === "string" ? uri : serialize(uri, opts);
    } catch {
      return;
    }
    const { normalized, malformedAuthorityOrPort, malformedPercentEncoding, malformedSchemeSpecific, malformedHost, malformedScheme } = normalizeStringWithStatus(value, opts);
    return malformedAuthorityOrPort || malformedPercentEncoding || malformedSchemeSpecific || malformedHost || malformedScheme ? undefined : normalized;
  }
  const fastUri = {
    SCHEMES,
    normalize,
    resolve,
    resolveComponent,
    equal,
    serialize,
    parse
  };
  module.exports = fastUri;
  module.exports.default = fastUri;
  module.exports.fastUri = fastUri;
});
var require_uri = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const uri = require_fast_uri();
  uri.code = 'require("ajv/dist/runtime/uri").default';
  exports.default = uri;
});
var require_core$3 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = undefined;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  const validation_error_1 = require_validation_error();
  const ref_error_1 = require_ref_error();
  const rules_1 = require_rules();
  const compile_1 = require_compile();
  const codegen_2 = require_codegen();
  const resolve_1 = require_resolve();
  const dataType_1 = require_dataType();
  const util_1 = require_util();
  const $dataRefSchema = require_data();
  const uri_1 = require_uri();
  const defaultRegExp = (str, flags) => new RegExp(str, flags);
  defaultRegExp.code = "new RegExp";
  const META_IGNORE_OPTIONS = [
    "removeAdditional",
    "useDefaults",
    "coerceTypes"
  ];
  const EXT_SCOPE_NAMES = new Set([
    "validate",
    "serialize",
    "parse",
    "wrapper",
    "root",
    "schema",
    "keyword",
    "pattern",
    "formats",
    "validate$data",
    "func",
    "obj",
    "Error"
  ]);
  const removedOptions = {
    errorDataPath: "",
    format: "`validateFormats: false` can be used instead.",
    nullable: '"nullable" keyword is supported by default.',
    jsonPointers: "Deprecated jsPropertySyntax can be used instead.",
    extendRefs: "Deprecated ignoreKeywordsWithRef can be used instead.",
    missingRefs: "Pass empty schema with $id that should be ignored to ajv.addSchema.",
    processCode: "Use option `code: {process: (code, schemaEnv: object) => string}`",
    sourceCode: "Use option `code: {source: true}`",
    strictDefaults: "It is default now, see option `strict`.",
    strictKeywords: "It is default now, see option `strict`.",
    uniqueItems: '"uniqueItems" keyword is always validated.',
    unknownFormats: "Disable strict mode or pass `true` to `ajv.addFormat` (or `formats` option).",
    cache: "Map is used as cache, schema object as key.",
    serialize: "Map is used as cache, schema object as key.",
    ajvErrors: "It is default now."
  };
  const deprecatedOptions = {
    ignoreKeywordsWithRef: "",
    jsPropertySyntax: "",
    unicode: '"minLength"/"maxLength" account for unicode characters by default.'
  };
  const MAX_EXPRESSION = 200;
  function requiredOptions(o) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0;
    const s = o.strict;
    const _optz = (_a = o.code) === null || _a === undefined ? undefined : _a.optimize;
    const optimize = _optz === true || _optz === undefined ? 1 : _optz || 0;
    const regExp = (_c = (_b = o.code) === null || _b === undefined ? undefined : _b.regExp) !== null && _c !== undefined ? _c : defaultRegExp;
    const uriResolver = (_d = o.uriResolver) !== null && _d !== undefined ? _d : uri_1.default;
    return {
      strictSchema: (_f = (_e = o.strictSchema) !== null && _e !== undefined ? _e : s) !== null && _f !== undefined ? _f : true,
      strictNumbers: (_h = (_g = o.strictNumbers) !== null && _g !== undefined ? _g : s) !== null && _h !== undefined ? _h : true,
      strictTypes: (_k = (_j = o.strictTypes) !== null && _j !== undefined ? _j : s) !== null && _k !== undefined ? _k : "log",
      strictTuples: (_m = (_l = o.strictTuples) !== null && _l !== undefined ? _l : s) !== null && _m !== undefined ? _m : "log",
      strictRequired: (_p = (_o = o.strictRequired) !== null && _o !== undefined ? _o : s) !== null && _p !== undefined ? _p : false,
      code: o.code ? {
        ...o.code,
        optimize,
        regExp
      } : {
        optimize,
        regExp
      },
      loopRequired: (_q = o.loopRequired) !== null && _q !== undefined ? _q : MAX_EXPRESSION,
      loopEnum: (_r = o.loopEnum) !== null && _r !== undefined ? _r : MAX_EXPRESSION,
      meta: (_s = o.meta) !== null && _s !== undefined ? _s : true,
      messages: (_t = o.messages) !== null && _t !== undefined ? _t : true,
      inlineRefs: (_u = o.inlineRefs) !== null && _u !== undefined ? _u : true,
      schemaId: (_v = o.schemaId) !== null && _v !== undefined ? _v : "$id",
      addUsedSchema: (_w = o.addUsedSchema) !== null && _w !== undefined ? _w : true,
      validateSchema: (_x = o.validateSchema) !== null && _x !== undefined ? _x : true,
      validateFormats: (_y = o.validateFormats) !== null && _y !== undefined ? _y : true,
      unicodeRegExp: (_z = o.unicodeRegExp) !== null && _z !== undefined ? _z : true,
      int32range: (_0 = o.int32range) !== null && _0 !== undefined ? _0 : true,
      uriResolver
    };
  }
  var Ajv = class {
    constructor(opts = {}) {
      this.schemas = {};
      this.refs = {};
      this.formats = {};
      this._compilations = /* @__PURE__ */ new Set;
      this._loading = {};
      this._cache = /* @__PURE__ */ new Map;
      opts = this.opts = {
        ...opts,
        ...requiredOptions(opts)
      };
      const { es5, lines } = this.opts.code;
      this.scope = new codegen_2.ValueScope({
        scope: {},
        prefixes: EXT_SCOPE_NAMES,
        es5,
        lines
      });
      this.logger = getLogger(opts.logger);
      const formatOpt = opts.validateFormats;
      opts.validateFormats = false;
      this.RULES = (0, rules_1.getRules)();
      checkOptions.call(this, removedOptions, opts, "NOT SUPPORTED");
      checkOptions.call(this, deprecatedOptions, opts, "DEPRECATED", "warn");
      this._metaOpts = getMetaSchemaOptions.call(this);
      if (opts.formats)
        addInitialFormats.call(this);
      this._addVocabularies();
      this._addDefaultMetaSchema();
      if (opts.keywords)
        addInitialKeywords.call(this, opts.keywords);
      if (typeof opts.meta == "object")
        this.addMetaSchema(opts.meta);
      addInitialSchemas.call(this);
      opts.validateFormats = formatOpt;
    }
    _addVocabularies() {
      this.addKeyword("$async");
    }
    _addDefaultMetaSchema() {
      const { $data, meta, schemaId } = this.opts;
      let _dataRefSchema = $dataRefSchema;
      if (schemaId === "id") {
        _dataRefSchema = { ...$dataRefSchema };
        _dataRefSchema.id = _dataRefSchema.$id;
        delete _dataRefSchema.$id;
      }
      if (meta && $data)
        this.addMetaSchema(_dataRefSchema, _dataRefSchema[schemaId], false);
    }
    defaultMeta() {
      const { meta, schemaId } = this.opts;
      return this.opts.defaultMeta = typeof meta == "object" ? meta[schemaId] || meta : undefined;
    }
    validate(schemaKeyRef, data) {
      let v;
      if (typeof schemaKeyRef == "string") {
        v = this.getSchema(schemaKeyRef);
        if (!v)
          throw new Error(`no schema with key or ref "${schemaKeyRef}"`);
      } else
        v = this.compile(schemaKeyRef);
      const valid = v(data);
      if (!("$async" in v))
        this.errors = v.errors;
      return valid;
    }
    compile(schema, _meta) {
      const sch = this._addSchema(schema, _meta);
      return sch.validate || this._compileSchemaEnv(sch);
    }
    compileAsync(schema, meta) {
      if (typeof this.opts.loadSchema != "function")
        throw new Error("options.loadSchema should be a function");
      const { loadSchema } = this.opts;
      return runCompileAsync.call(this, schema, meta);
      async function runCompileAsync(_schema, _meta) {
        await loadMetaSchema.call(this, _schema.$schema);
        const sch = this._addSchema(_schema, _meta);
        return sch.validate || _compileAsync.call(this, sch);
      }
      async function loadMetaSchema($ref) {
        if ($ref && !this.getSchema($ref))
          await runCompileAsync.call(this, { $ref }, true);
      }
      async function _compileAsync(sch) {
        try {
          return this._compileSchemaEnv(sch);
        } catch (e) {
          if (!(e instanceof ref_error_1.default))
            throw e;
          checkLoaded.call(this, e);
          await loadMissingSchema.call(this, e.missingSchema);
          return _compileAsync.call(this, sch);
        }
      }
      function checkLoaded({ missingSchema: ref, missingRef }) {
        if (this.refs[ref])
          throw new Error(`AnySchema ${ref} is loaded but ${missingRef} cannot be resolved`);
      }
      async function loadMissingSchema(ref) {
        const _schema = await _loadSchema.call(this, ref);
        if (!this.refs[ref])
          await loadMetaSchema.call(this, _schema.$schema);
        if (!this.refs[ref])
          this.addSchema(_schema, ref, meta);
      }
      async function _loadSchema(ref) {
        const p = this._loading[ref];
        if (p)
          return p;
        try {
          return await (this._loading[ref] = loadSchema(ref));
        } finally {
          delete this._loading[ref];
        }
      }
    }
    addSchema(schema, key, _meta, _validateSchema = this.opts.validateSchema) {
      if (Array.isArray(schema)) {
        for (const sch of schema)
          this.addSchema(sch, undefined, _meta, _validateSchema);
        return this;
      }
      let id;
      if (typeof schema === "object") {
        const { schemaId } = this.opts;
        id = schema[schemaId];
        if (id !== undefined && typeof id != "string")
          throw new Error(`schema ${schemaId} must be string`);
      }
      key = (0, resolve_1.normalizeId)(key || id);
      this._checkUnique(key);
      this.schemas[key] = this._addSchema(schema, _meta, key, _validateSchema, true);
      return this;
    }
    addMetaSchema(schema, key, _validateSchema = this.opts.validateSchema) {
      this.addSchema(schema, key, true, _validateSchema);
      return this;
    }
    validateSchema(schema, throwOrLogError) {
      if (typeof schema == "boolean")
        return true;
      let $schema;
      $schema = schema.$schema;
      if ($schema !== undefined && typeof $schema != "string")
        throw new Error("$schema must be a string");
      $schema = $schema || this.opts.defaultMeta || this.defaultMeta();
      if (!$schema) {
        this.logger.warn("meta-schema not available");
        this.errors = null;
        return true;
      }
      const valid = this.validate($schema, schema);
      if (!valid && throwOrLogError) {
        const message = "schema is invalid: " + this.errorsText();
        if (this.opts.validateSchema === "log")
          this.logger.error(message);
        else
          throw new Error(message);
      }
      return valid;
    }
    getSchema(keyRef) {
      let sch;
      while (typeof (sch = getSchEnv.call(this, keyRef)) == "string")
        keyRef = sch;
      if (sch === undefined) {
        const { schemaId } = this.opts;
        const root = new compile_1.SchemaEnv({
          schema: {},
          schemaId
        });
        sch = compile_1.resolveSchema.call(this, root, keyRef);
        if (!sch)
          return;
        this.refs[keyRef] = sch;
      }
      return sch.validate || this._compileSchemaEnv(sch);
    }
    removeSchema(schemaKeyRef) {
      if (schemaKeyRef instanceof RegExp) {
        this._removeAllSchemas(this.schemas, schemaKeyRef);
        this._removeAllSchemas(this.refs, schemaKeyRef);
        return this;
      }
      switch (typeof schemaKeyRef) {
        case "undefined":
          this._removeAllSchemas(this.schemas);
          this._removeAllSchemas(this.refs);
          this._cache.clear();
          return this;
        case "string": {
          const sch = getSchEnv.call(this, schemaKeyRef);
          if (typeof sch == "object")
            this._cache.delete(sch.schema);
          delete this.schemas[schemaKeyRef];
          delete this.refs[schemaKeyRef];
          return this;
        }
        case "object": {
          const cacheKey = schemaKeyRef;
          this._cache.delete(cacheKey);
          let id = schemaKeyRef[this.opts.schemaId];
          if (id) {
            id = (0, resolve_1.normalizeId)(id);
            delete this.schemas[id];
            delete this.refs[id];
          }
          return this;
        }
        default:
          throw new Error("ajv.removeSchema: invalid parameter");
      }
    }
    addVocabulary(definitions) {
      for (const def of definitions)
        this.addKeyword(def);
      return this;
    }
    addKeyword(kwdOrDef, def) {
      let keyword;
      if (typeof kwdOrDef == "string") {
        keyword = kwdOrDef;
        if (typeof def == "object") {
          this.logger.warn("these parameters are deprecated, see docs for addKeyword");
          def.keyword = keyword;
        }
      } else if (typeof kwdOrDef == "object" && def === undefined) {
        def = kwdOrDef;
        keyword = def.keyword;
        if (Array.isArray(keyword) && !keyword.length)
          throw new Error("addKeywords: keyword must be string or non-empty array");
      } else
        throw new Error("invalid addKeywords parameters");
      checkKeyword.call(this, keyword, def);
      if (!def) {
        (0, util_1.eachItem)(keyword, (kwd) => addRule.call(this, kwd));
        return this;
      }
      keywordMetaschema.call(this, def);
      const definition = {
        ...def,
        type: (0, dataType_1.getJSONTypes)(def.type),
        schemaType: (0, dataType_1.getJSONTypes)(def.schemaType)
      };
      (0, util_1.eachItem)(keyword, definition.type.length === 0 ? (k) => addRule.call(this, k, definition) : (k) => definition.type.forEach((t) => addRule.call(this, k, definition, t)));
      return this;
    }
    getKeyword(keyword) {
      const rule = this.RULES.all[keyword];
      return typeof rule == "object" ? rule.definition : !!rule;
    }
    removeKeyword(keyword) {
      const { RULES } = this;
      delete RULES.keywords[keyword];
      delete RULES.all[keyword];
      for (const group of RULES.rules) {
        const i = group.rules.findIndex((rule) => rule.keyword === keyword);
        if (i >= 0)
          group.rules.splice(i, 1);
      }
      return this;
    }
    addFormat(name, format) {
      if (typeof format == "string")
        format = new RegExp(format);
      this.formats[name] = format;
      return this;
    }
    errorsText(errors = this.errors, { separator = ", ", dataVar = "data" } = {}) {
      if (!errors || errors.length === 0)
        return "No errors";
      return errors.map((e) => `${dataVar}${e.instancePath} ${e.message}`).reduce((text, msg) => text + separator + msg);
    }
    $dataMetaSchema(metaSchema, keywordsJsonPointers) {
      const rules = this.RULES.all;
      metaSchema = JSON.parse(JSON.stringify(metaSchema));
      for (const jsonPointer of keywordsJsonPointers) {
        const segments = jsonPointer.split("/").slice(1);
        let keywords = metaSchema;
        for (const seg of segments)
          keywords = keywords[seg];
        for (const key in rules) {
          const rule = rules[key];
          if (typeof rule != "object")
            continue;
          const { $data } = rule.definition;
          const schema = keywords[key];
          if ($data && schema)
            keywords[key] = schemaOrData(schema);
        }
      }
      return metaSchema;
    }
    _removeAllSchemas(schemas, regex) {
      for (const keyRef in schemas) {
        const sch = schemas[keyRef];
        if (!regex || regex.test(keyRef)) {
          if (typeof sch == "string")
            delete schemas[keyRef];
          else if (sch && !sch.meta) {
            this._cache.delete(sch.schema);
            delete schemas[keyRef];
          }
        }
      }
    }
    _addSchema(schema, meta, baseId, validateSchema = this.opts.validateSchema, addSchema = this.opts.addUsedSchema) {
      let id;
      const { schemaId } = this.opts;
      if (typeof schema == "object")
        id = schema[schemaId];
      else if (this.opts.jtd)
        throw new Error("schema must be object");
      else if (typeof schema != "boolean")
        throw new Error("schema must be object or boolean");
      let sch = this._cache.get(schema);
      if (sch !== undefined)
        return sch;
      baseId = (0, resolve_1.normalizeId)(id || baseId);
      const localRefs = resolve_1.getSchemaRefs.call(this, schema, baseId);
      sch = new compile_1.SchemaEnv({
        schema,
        schemaId,
        meta,
        baseId,
        localRefs
      });
      this._cache.set(sch.schema, sch);
      if (addSchema && !baseId.startsWith("#")) {
        if (baseId)
          this._checkUnique(baseId);
        this.refs[baseId] = sch;
      }
      if (validateSchema)
        this.validateSchema(schema, true);
      return sch;
    }
    _checkUnique(id) {
      if (this.schemas[id] || this.refs[id])
        throw new Error(`schema with key or id "${id}" already exists`);
    }
    _compileSchemaEnv(sch) {
      if (sch.meta)
        this._compileMetaSchema(sch);
      else
        compile_1.compileSchema.call(this, sch);
      if (!sch.validate)
        throw new Error("ajv implementation error");
      return sch.validate;
    }
    _compileMetaSchema(sch) {
      const currentOpts = this.opts;
      this.opts = this._metaOpts;
      try {
        compile_1.compileSchema.call(this, sch);
      } finally {
        this.opts = currentOpts;
      }
    }
  };
  Ajv.ValidationError = validation_error_1.default;
  Ajv.MissingRefError = ref_error_1.default;
  exports.default = Ajv;
  function checkOptions(checkOpts, options, msg, log = "error") {
    for (const key in checkOpts) {
      const opt = key;
      if (opt in options)
        this.logger[log](`${msg}: option ${key}. ${checkOpts[opt]}`);
    }
  }
  function getSchEnv(keyRef) {
    keyRef = (0, resolve_1.normalizeId)(keyRef);
    return this.schemas[keyRef] || this.refs[keyRef];
  }
  function addInitialSchemas() {
    const optsSchemas = this.opts.schemas;
    if (!optsSchemas)
      return;
    if (Array.isArray(optsSchemas))
      this.addSchema(optsSchemas);
    else
      for (const key in optsSchemas)
        this.addSchema(optsSchemas[key], key);
  }
  function addInitialFormats() {
    for (const name in this.opts.formats) {
      const format = this.opts.formats[name];
      if (format)
        this.addFormat(name, format);
    }
  }
  function addInitialKeywords(defs) {
    if (Array.isArray(defs)) {
      this.addVocabulary(defs);
      return;
    }
    this.logger.warn("keywords option as map is deprecated, pass array");
    for (const keyword in defs) {
      const def = defs[keyword];
      if (!def.keyword)
        def.keyword = keyword;
      this.addKeyword(def);
    }
  }
  function getMetaSchemaOptions() {
    const metaOpts = { ...this.opts };
    for (const opt of META_IGNORE_OPTIONS)
      delete metaOpts[opt];
    return metaOpts;
  }
  const noLogs = {
    log() {},
    warn() {},
    error() {}
  };
  function getLogger(logger) {
    if (logger === false)
      return noLogs;
    if (logger === undefined)
      return console;
    if (logger.log && logger.warn && logger.error)
      return logger;
    throw new Error("logger must implement log, warn and error methods");
  }
  const KEYWORD_NAME = /^[a-z_$][a-z0-9_$:-]*$/i;
  function checkKeyword(keyword, def) {
    const { RULES } = this;
    (0, util_1.eachItem)(keyword, (kwd) => {
      if (RULES.keywords[kwd])
        throw new Error(`Keyword ${kwd} is already defined`);
      if (!KEYWORD_NAME.test(kwd))
        throw new Error(`Keyword ${kwd} has invalid name`);
    });
    if (!def)
      return;
    if (def.$data && !(("code" in def) || ("validate" in def)))
      throw new Error('$data keyword must have "code" or "validate" function');
  }
  function addRule(keyword, definition, dataType) {
    var _a;
    const post = definition === null || definition === undefined ? undefined : definition.post;
    if (dataType && post)
      throw new Error('keyword with "post" flag cannot have "type"');
    const { RULES } = this;
    let ruleGroup = post ? RULES.post : RULES.rules.find(({ type: t }) => t === dataType);
    if (!ruleGroup) {
      ruleGroup = {
        type: dataType,
        rules: []
      };
      RULES.rules.push(ruleGroup);
    }
    RULES.keywords[keyword] = true;
    if (!definition)
      return;
    const rule = {
      keyword,
      definition: {
        ...definition,
        type: (0, dataType_1.getJSONTypes)(definition.type),
        schemaType: (0, dataType_1.getJSONTypes)(definition.schemaType)
      }
    };
    if (definition.before)
      addBeforeRule.call(this, ruleGroup, rule, definition.before);
    else
      ruleGroup.rules.push(rule);
    RULES.all[keyword] = rule;
    (_a = definition.implements) === null || _a === undefined || _a.forEach((kwd) => this.addKeyword(kwd));
  }
  function addBeforeRule(ruleGroup, rule, before) {
    const i = ruleGroup.rules.findIndex((_rule) => _rule.keyword === before);
    if (i >= 0)
      ruleGroup.rules.splice(i, 0, rule);
    else {
      ruleGroup.rules.push(rule);
      this.logger.warn(`rule ${before} is not defined`);
    }
  }
  function keywordMetaschema(def) {
    let { metaSchema } = def;
    if (metaSchema === undefined)
      return;
    if (def.$data && this.opts.$data)
      metaSchema = schemaOrData(metaSchema);
    def.validateSchema = this.compile(metaSchema, true);
  }
  const $dataRef = { $ref: "https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#" };
  function schemaOrData(schema) {
    return { anyOf: [schema, $dataRef] };
  }
});
var require_id = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const def = {
    keyword: "id",
    code() {
      throw new Error('NOT SUPPORTED: keyword "id", use "$id" for schema ID');
    }
  };
  exports.default = def;
});
var require_ref = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.callRef = exports.getValidate = undefined;
  const ref_error_1 = require_ref_error();
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const compile_1 = require_compile();
  const util_1 = require_util();
  const def = {
    keyword: "$ref",
    schemaType: "string",
    code(cxt) {
      const { gen, schema: $ref, it } = cxt;
      const { baseId, schemaEnv: env, validateName, opts, self } = it;
      const { root } = env;
      if (($ref === "#" || $ref === "#/") && baseId === root.baseId)
        return callRootRef();
      const schOrEnv = compile_1.resolveRef.call(self, root, baseId, $ref);
      if (schOrEnv === undefined)
        throw new ref_error_1.default(it.opts.uriResolver, baseId, $ref);
      if (schOrEnv instanceof compile_1.SchemaEnv)
        return callValidate(schOrEnv);
      return inlineRefSchema(schOrEnv);
      function callRootRef() {
        if (env === root)
          return callRef(cxt, validateName, env, env.$async);
        const rootName = gen.scopeValue("root", { ref: root });
        return callRef(cxt, (0, codegen_1._)`${rootName}.validate`, root, root.$async);
      }
      function callValidate(sch) {
        callRef(cxt, getValidate(cxt, sch), sch, sch.$async);
      }
      function inlineRefSchema(sch) {
        const schName = gen.scopeValue("schema", opts.code.source === true ? {
          ref: sch,
          code: (0, codegen_1.stringify)(sch)
        } : { ref: sch });
        const valid = gen.name("valid");
        const schCxt = cxt.subschema({
          schema: sch,
          dataTypes: [],
          schemaPath: codegen_1.nil,
          topSchemaRef: schName,
          errSchemaPath: $ref
        }, valid);
        cxt.mergeEvaluated(schCxt);
        cxt.ok(valid);
      }
    }
  };
  function getValidate(cxt, sch) {
    const { gen } = cxt;
    return sch.validate ? gen.scopeValue("validate", { ref: sch.validate }) : (0, codegen_1._)`${gen.scopeValue("wrapper", { ref: sch })}.validate`;
  }
  exports.getValidate = getValidate;
  function callRef(cxt, v, sch, $async) {
    const { gen, it } = cxt;
    const { allErrors, schemaEnv: env, opts } = it;
    const passCxt = opts.passContext ? names_1.default.this : codegen_1.nil;
    if ($async)
      callAsyncRef();
    else
      callSyncRef();
    function callAsyncRef() {
      if (!env.$async)
        throw new Error("async schema referenced by sync schema");
      const valid = gen.let("valid");
      gen.try(() => {
        gen.code((0, codegen_1._)`await ${(0, code_1.callValidateCode)(cxt, v, passCxt)}`);
        addEvaluatedFrom(v);
        if (!allErrors)
          gen.assign(valid, true);
      }, (e) => {
        gen.if((0, codegen_1._)`!(${e} instanceof ${it.ValidationError})`, () => gen.throw(e));
        addErrorsFrom(e);
        if (!allErrors)
          gen.assign(valid, false);
      });
      cxt.ok(valid);
    }
    function callSyncRef() {
      cxt.result((0, code_1.callValidateCode)(cxt, v, passCxt), () => addEvaluatedFrom(v), () => addErrorsFrom(v));
    }
    function addErrorsFrom(source) {
      const errs = (0, codegen_1._)`${source}.errors`;
      gen.assign(names_1.default.vErrors, (0, codegen_1._)`${names_1.default.vErrors} === null ? ${errs} : ${names_1.default.vErrors}.concat(${errs})`);
      gen.assign(names_1.default.errors, (0, codegen_1._)`${names_1.default.vErrors}.length`);
    }
    function addEvaluatedFrom(source) {
      var _a;
      if (!it.opts.unevaluated)
        return;
      const schEvaluated = (_a = sch === null || sch === undefined ? undefined : sch.validate) === null || _a === undefined ? undefined : _a.evaluated;
      if (it.props !== true)
        if (schEvaluated && !schEvaluated.dynamicProps) {
          if (schEvaluated.props !== undefined)
            it.props = util_1.mergeEvaluated.props(gen, schEvaluated.props, it.props);
        } else {
          const props = gen.var("props", (0, codegen_1._)`${source}.evaluated.props`);
          it.props = util_1.mergeEvaluated.props(gen, props, it.props, codegen_1.Name);
        }
      if (it.items !== true)
        if (schEvaluated && !schEvaluated.dynamicItems) {
          if (schEvaluated.items !== undefined)
            it.items = util_1.mergeEvaluated.items(gen, schEvaluated.items, it.items);
        } else {
          const items = gen.var("items", (0, codegen_1._)`${source}.evaluated.items`);
          it.items = util_1.mergeEvaluated.items(gen, items, it.items, codegen_1.Name);
        }
    }
  }
  exports.callRef = callRef;
  exports.default = def;
});
var require_core$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const id_1 = require_id();
  const ref_1 = require_ref();
  const core = [
    "$schema",
    "$id",
    "$defs",
    "$vocabulary",
    { keyword: "$comment" },
    "definitions",
    id_1.default,
    ref_1.default
  ];
  exports.default = core;
});
var require_limitNumber = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const ops = codegen_1.operators;
  const KWDs = {
    maximum: {
      okStr: "<=",
      ok: ops.LTE,
      fail: ops.GT
    },
    minimum: {
      okStr: ">=",
      ok: ops.GTE,
      fail: ops.LT
    },
    exclusiveMaximum: {
      okStr: "<",
      ok: ops.LT,
      fail: ops.GTE
    },
    exclusiveMinimum: {
      okStr: ">",
      ok: ops.GT,
      fail: ops.LTE
    }
  };
  const def = {
    keyword: Object.keys(KWDs),
    type: "number",
    schemaType: "number",
    $data: true,
    error: {
      message: ({ keyword, schemaCode }) => (0, codegen_1.str)`must be ${KWDs[keyword].okStr} ${schemaCode}`,
      params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      cxt.fail$data((0, codegen_1._)`${data} ${KWDs[keyword].fail} ${schemaCode} || isNaN(${data})`);
    }
  };
  exports.default = def;
});
var require_multipleOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: "multipleOf",
    type: "number",
    schemaType: "number",
    $data: true,
    error: {
      message: ({ schemaCode }) => (0, codegen_1.str)`must be multiple of ${schemaCode}`,
      params: ({ schemaCode }) => (0, codegen_1._)`{multipleOf: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, schemaCode, it } = cxt;
      const prec = it.opts.multipleOfPrecision;
      const res = gen.let("res");
      const invalid = prec ? (0, codegen_1._)`Math.abs(Math.round(${res}) - ${res}) > 1e-${prec}` : (0, codegen_1._)`${res} !== parseInt(${res})`;
      cxt.fail$data((0, codegen_1._)`(${schemaCode} === 0 || (${res} = ${data}/${schemaCode}, ${invalid}))`);
    }
  };
  exports.default = def;
});
var require_ucs2length = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  function ucs2length(str) {
    const len = str.length;
    let length = 0;
    let pos = 0;
    let value;
    while (pos < len) {
      length++;
      value = str.charCodeAt(pos++);
      if (value >= 55296 && value <= 56319 && pos < len) {
        value = str.charCodeAt(pos);
        if ((value & 64512) === 56320)
          pos++;
      }
    }
    return length;
  }
  exports.default = ucs2length;
  ucs2length.code = 'require("ajv/dist/runtime/ucs2length").default';
});
var require_limitLength = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const ucs2length_1 = require_ucs2length();
  const def = {
    keyword: ["maxLength", "minLength"],
    type: "string",
    schemaType: "number",
    $data: true,
    error: {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxLength" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} characters`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode, it } = cxt;
      const op = keyword === "maxLength" ? codegen_1.operators.GT : codegen_1.operators.LT;
      const len = it.opts.unicode === false ? (0, codegen_1._)`${data}.length` : (0, codegen_1._)`${(0, util_1.useFunc)(cxt.gen, ucs2length_1.default)}(${data})`;
      cxt.fail$data((0, codegen_1._)`${len} ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});
var require_pattern = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const util_1 = require_util();
  const codegen_1 = require_codegen();
  const def = {
    keyword: "pattern",
    type: "string",
    schemaType: "string",
    $data: true,
    error: {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match pattern "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{pattern: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      const u = it.opts.unicodeRegExp ? "u" : "";
      if ($data) {
        const { regExp } = it.opts.code;
        const regExpCode = regExp.code === "new RegExp" ? (0, codegen_1._)`new RegExp` : (0, util_1.useFunc)(gen, regExp);
        const valid = gen.let("valid");
        gen.try(() => gen.assign(valid, (0, codegen_1._)`${regExpCode}(${schemaCode}, ${u}).test(${data})`), () => gen.assign(valid, false));
        cxt.fail$data((0, codegen_1._)`!${valid}`);
      } else {
        const regExp = (0, code_1.usePattern)(cxt, schema);
        cxt.fail$data((0, codegen_1._)`!${regExp}.test(${data})`);
      }
    }
  };
  exports.default = def;
});
var require_limitProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: ["maxProperties", "minProperties"],
    type: "object",
    schemaType: "number",
    $data: true,
    error: {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxProperties" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} properties`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      const op = keyword === "maxProperties" ? codegen_1.operators.GT : codegen_1.operators.LT;
      cxt.fail$data((0, codegen_1._)`Object.keys(${data}).length ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});
var require_required = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "required",
    type: "object",
    schemaType: "array",
    $data: true,
    error: {
      message: ({ params: { missingProperty } }) => (0, codegen_1.str)`must have required property '${missingProperty}'`,
      params: ({ params: { missingProperty } }) => (0, codegen_1._)`{missingProperty: ${missingProperty}}`
    },
    code(cxt) {
      const { gen, schema, schemaCode, data, $data, it } = cxt;
      const { opts } = it;
      if (!$data && schema.length === 0)
        return;
      const useLoop = schema.length >= opts.loopRequired;
      if (it.allErrors)
        allErrorsMode();
      else
        exitOnErrorMode();
      if (opts.strictRequired) {
        const props = cxt.parentSchema.properties;
        const { definedProperties } = cxt.it;
        for (const requiredKey of schema)
          if ((props === null || props === undefined ? undefined : props[requiredKey]) === undefined && !definedProperties.has(requiredKey)) {
            const msg = `required property "${requiredKey}" is not defined at "${it.schemaEnv.baseId + it.errSchemaPath}" (strictRequired)`;
            (0, util_1.checkStrictMode)(it, msg, it.opts.strictRequired);
          }
      }
      function allErrorsMode() {
        if (useLoop || $data)
          cxt.block$data(codegen_1.nil, loopAllRequired);
        else
          for (const prop of schema)
            (0, code_1.checkReportMissingProp)(cxt, prop);
      }
      function exitOnErrorMode() {
        const missing = gen.let("missing");
        if (useLoop || $data) {
          const valid = gen.let("valid", true);
          cxt.block$data(valid, () => loopUntilMissing(missing, valid));
          cxt.ok(valid);
        } else {
          gen.if((0, code_1.checkMissingProp)(cxt, schema, missing));
          (0, code_1.reportMissingProp)(cxt, missing);
          gen.else();
        }
      }
      function loopAllRequired() {
        gen.forOf("prop", schemaCode, (prop) => {
          cxt.setParams({ missingProperty: prop });
          gen.if((0, code_1.noPropertyInData)(gen, data, prop, opts.ownProperties), () => cxt.error());
        });
      }
      function loopUntilMissing(missing, valid) {
        cxt.setParams({ missingProperty: missing });
        gen.forOf(missing, schemaCode, () => {
          gen.assign(valid, (0, code_1.propertyInData)(gen, data, missing, opts.ownProperties));
          gen.if((0, codegen_1.not)(valid), () => {
            cxt.error();
            gen.break();
          });
        }, codegen_1.nil);
      }
    }
  };
  exports.default = def;
});
var require_limitItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: ["maxItems", "minItems"],
    type: "array",
    schemaType: "number",
    $data: true,
    error: {
      message({ keyword, schemaCode }) {
        const comp = keyword === "maxItems" ? "more" : "fewer";
        return (0, codegen_1.str)`must NOT have ${comp} than ${schemaCode} items`;
      },
      params: ({ schemaCode }) => (0, codegen_1._)`{limit: ${schemaCode}}`
    },
    code(cxt) {
      const { keyword, data, schemaCode } = cxt;
      const op = keyword === "maxItems" ? codegen_1.operators.GT : codegen_1.operators.LT;
      cxt.fail$data((0, codegen_1._)`${data}.length ${op} ${schemaCode}`);
    }
  };
  exports.default = def;
});
var require_equal = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const equal = require_fast_deep_equal();
  equal.code = 'require("ajv/dist/runtime/equal").default';
  exports.default = equal;
});
var require_uniqueItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dataType_1 = require_dataType();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const equal_1 = require_equal();
  const def = {
    keyword: "uniqueItems",
    type: "array",
    schemaType: "boolean",
    $data: true,
    error: {
      message: ({ params: { i, j } }) => (0, codegen_1.str)`must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
      params: ({ params: { i, j } }) => (0, codegen_1._)`{i: ${i}, j: ${j}}`
    },
    code(cxt) {
      const { gen, data, $data, schema, parentSchema, schemaCode, it } = cxt;
      if (!$data && !schema)
        return;
      const valid = gen.let("valid");
      const itemTypes = parentSchema.items ? (0, dataType_1.getSchemaTypes)(parentSchema.items) : [];
      cxt.block$data(valid, validateUniqueItems, (0, codegen_1._)`${schemaCode} === false`);
      cxt.ok(valid);
      function validateUniqueItems() {
        const i = gen.let("i", (0, codegen_1._)`${data}.length`);
        const j = gen.let("j");
        cxt.setParams({
          i,
          j
        });
        gen.assign(valid, true);
        gen.if((0, codegen_1._)`${i} > 1`, () => (canOptimize() ? loopN : loopN2)(i, j));
      }
      function canOptimize() {
        return itemTypes.length > 0 && !itemTypes.some((t) => t === "object" || t === "array");
      }
      function loopN(i, j) {
        const item = gen.name("item");
        const wrongType = (0, dataType_1.checkDataTypes)(itemTypes, item, it.opts.strictNumbers, dataType_1.DataType.Wrong);
        const indices = gen.const("indices", (0, codegen_1._)`{}`);
        gen.for((0, codegen_1._)`;${i}--;`, () => {
          gen.let(item, (0, codegen_1._)`${data}[${i}]`);
          gen.if(wrongType, (0, codegen_1._)`continue`);
          if (itemTypes.length > 1)
            gen.if((0, codegen_1._)`typeof ${item} == "string"`, (0, codegen_1._)`${item} += "_"`);
          gen.if((0, codegen_1._)`typeof ${indices}[${item}] == "number"`, () => {
            gen.assign(j, (0, codegen_1._)`${indices}[${item}]`);
            cxt.error();
            gen.assign(valid, false).break();
          }).code((0, codegen_1._)`${indices}[${item}] = ${i}`);
        });
      }
      function loopN2(i, j) {
        const eql = (0, util_1.useFunc)(gen, equal_1.default);
        const outer = gen.name("outer");
        gen.label(outer).for((0, codegen_1._)`;${i}--;`, () => gen.for((0, codegen_1._)`${j} = ${i}; ${j}--;`, () => gen.if((0, codegen_1._)`${eql}(${data}[${i}], ${data}[${j}])`, () => {
          cxt.error();
          gen.assign(valid, false).break(outer);
        })));
      }
    }
  };
  exports.default = def;
});
var require_const = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const equal_1 = require_equal();
  const def = {
    keyword: "const",
    $data: true,
    error: {
      message: "must be equal to constant",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValue: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, $data, schemaCode, schema } = cxt;
      if ($data || schema && typeof schema == "object")
        cxt.fail$data((0, codegen_1._)`!${(0, util_1.useFunc)(gen, equal_1.default)}(${data}, ${schemaCode})`);
      else
        cxt.fail((0, codegen_1._)`${schema} !== ${data}`);
    }
  };
  exports.default = def;
});
var require_enum = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const equal_1 = require_equal();
  const def = {
    keyword: "enum",
    schemaType: "array",
    $data: true,
    error: {
      message: "must be equal to one of the allowed values",
      params: ({ schemaCode }) => (0, codegen_1._)`{allowedValues: ${schemaCode}}`
    },
    code(cxt) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      if (!$data && schema.length === 0)
        throw new Error("enum must have non-empty array");
      const useLoop = schema.length >= it.opts.loopEnum;
      let eql;
      const getEql = () => eql !== null && eql !== undefined ? eql : eql = (0, util_1.useFunc)(gen, equal_1.default);
      let valid;
      if (useLoop || $data) {
        valid = gen.let("valid");
        cxt.block$data(valid, loopEnum);
      } else {
        if (!Array.isArray(schema))
          throw new Error("ajv implementation error");
        const vSchema = gen.const("vSchema", schemaCode);
        valid = (0, codegen_1.or)(...schema.map((_x, i) => equalCode(vSchema, i)));
      }
      cxt.pass(valid);
      function loopEnum() {
        gen.assign(valid, false);
        gen.forOf("v", schemaCode, (v) => gen.if((0, codegen_1._)`${getEql()}(${data}, ${v})`, () => gen.assign(valid, true).break()));
      }
      function equalCode(vSchema, i) {
        const sch = schema[i];
        return typeof sch === "object" && sch !== null ? (0, codegen_1._)`${getEql()}(${data}, ${vSchema}[${i}])` : (0, codegen_1._)`${data} === ${sch}`;
      }
    }
  };
  exports.default = def;
});
var require_validation$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const limitNumber_1 = require_limitNumber();
  const multipleOf_1 = require_multipleOf();
  const limitLength_1 = require_limitLength();
  const pattern_1 = require_pattern();
  const limitProperties_1 = require_limitProperties();
  const required_1 = require_required();
  const limitItems_1 = require_limitItems();
  const uniqueItems_1 = require_uniqueItems();
  const const_1 = require_const();
  const enum_1 = require_enum();
  const validation = [
    limitNumber_1.default,
    multipleOf_1.default,
    limitLength_1.default,
    pattern_1.default,
    limitProperties_1.default,
    required_1.default,
    limitItems_1.default,
    uniqueItems_1.default,
    {
      keyword: "type",
      schemaType: ["string", "array"]
    },
    {
      keyword: "nullable",
      schemaType: "boolean"
    },
    const_1.default,
    enum_1.default
  ];
  exports.default = validation;
});
var require_additionalItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateAdditionalItems = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "additionalItems",
    type: "array",
    schemaType: ["boolean", "object"],
    before: "uniqueItems",
    error: {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    },
    code(cxt) {
      const { parentSchema, it } = cxt;
      const { items } = parentSchema;
      if (!Array.isArray(items)) {
        (0, util_1.checkStrictMode)(it, '"additionalItems" is ignored when "items" is not an array of schemas');
        return;
      }
      validateAdditionalItems(cxt, items);
    }
  };
  function validateAdditionalItems(cxt, items) {
    const { gen, schema, data, keyword, it } = cxt;
    it.items = true;
    const len = gen.const("len", (0, codegen_1._)`${data}.length`);
    if (schema === false) {
      cxt.setParams({ len: items.length });
      cxt.pass((0, codegen_1._)`${len} <= ${items.length}`);
    } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
      const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items.length}`);
      gen.if((0, codegen_1.not)(valid), () => validateItems(valid));
      cxt.ok(valid);
    }
    function validateItems(valid) {
      gen.forRange("i", items.length, len, (i) => {
        cxt.subschema({
          keyword,
          dataProp: i,
          dataPropType: util_1.Type.Num
        }, valid);
        if (!it.allErrors)
          gen.if((0, codegen_1.not)(valid), () => gen.break());
      });
    }
  }
  exports.validateAdditionalItems = validateAdditionalItems;
  exports.default = def;
});
var require_items = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateTuple = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const code_1 = require_code();
  const def = {
    keyword: "items",
    type: "array",
    schemaType: [
      "object",
      "array",
      "boolean"
    ],
    before: "uniqueItems",
    code(cxt) {
      const { schema, it } = cxt;
      if (Array.isArray(schema))
        return validateTuple(cxt, "additionalItems", schema);
      it.items = true;
      if ((0, util_1.alwaysValidSchema)(it, schema))
        return;
      cxt.ok((0, code_1.validateArray)(cxt));
    }
  };
  function validateTuple(cxt, extraItems, schArr = cxt.schema) {
    const { gen, parentSchema, data, keyword, it } = cxt;
    checkStrictTuple(parentSchema);
    if (it.opts.unevaluated && schArr.length && it.items !== true)
      it.items = util_1.mergeEvaluated.items(gen, schArr.length, it.items);
    const valid = gen.name("valid");
    const len = gen.const("len", (0, codegen_1._)`${data}.length`);
    schArr.forEach((sch, i) => {
      if ((0, util_1.alwaysValidSchema)(it, sch))
        return;
      gen.if((0, codegen_1._)`${len} > ${i}`, () => cxt.subschema({
        keyword,
        schemaProp: i,
        dataProp: i
      }, valid));
      cxt.ok(valid);
    });
    function checkStrictTuple(sch) {
      const { opts, errSchemaPath } = it;
      const l = schArr.length;
      const fullTuple = l === sch.minItems && (l === sch.maxItems || sch[extraItems] === false);
      if (opts.strictTuples && !fullTuple) {
        const msg = `"${keyword}" is ${l}-tuple, but minItems or maxItems/${extraItems} are not specified or different at path "${errSchemaPath}"`;
        (0, util_1.checkStrictMode)(it, msg, opts.strictTuples);
      }
    }
  }
  exports.validateTuple = validateTuple;
  exports.default = def;
});
var require_prefixItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const items_1 = require_items();
  const def = {
    keyword: "prefixItems",
    type: "array",
    schemaType: ["array"],
    before: "uniqueItems",
    code: (cxt) => (0, items_1.validateTuple)(cxt, "items")
  };
  exports.default = def;
});
var require_items2020 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const code_1 = require_code();
  const additionalItems_1 = require_additionalItems();
  const def = {
    keyword: "items",
    type: "array",
    schemaType: ["object", "boolean"],
    before: "uniqueItems",
    error: {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    },
    code(cxt) {
      const { schema, parentSchema, it } = cxt;
      const { prefixItems } = parentSchema;
      it.items = true;
      if ((0, util_1.alwaysValidSchema)(it, schema))
        return;
      if (prefixItems)
        (0, additionalItems_1.validateAdditionalItems)(cxt, prefixItems);
      else
        cxt.ok((0, code_1.validateArray)(cxt));
    }
  };
  exports.default = def;
});
var require_contains = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "contains",
    type: "array",
    schemaType: ["object", "boolean"],
    before: "uniqueItems",
    trackErrors: true,
    error: {
      message: ({ params: { min, max } }) => max === undefined ? (0, codegen_1.str)`must contain at least ${min} valid item(s)` : (0, codegen_1.str)`must contain at least ${min} and no more than ${max} valid item(s)`,
      params: ({ params: { min, max } }) => max === undefined ? (0, codegen_1._)`{minContains: ${min}}` : (0, codegen_1._)`{minContains: ${min}, maxContains: ${max}}`
    },
    code(cxt) {
      const { gen, schema, parentSchema, data, it } = cxt;
      let min;
      let max;
      const { minContains, maxContains } = parentSchema;
      if (it.opts.next) {
        min = minContains === undefined ? 1 : minContains;
        max = maxContains;
      } else
        min = 1;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      cxt.setParams({
        min,
        max
      });
      if (max === undefined && min === 0) {
        (0, util_1.checkStrictMode)(it, `"minContains" == 0 without "maxContains": "contains" keyword ignored`);
        return;
      }
      if (max !== undefined && min > max) {
        (0, util_1.checkStrictMode)(it, `"minContains" > "maxContains" is always invalid`);
        cxt.fail();
        return;
      }
      if ((0, util_1.alwaysValidSchema)(it, schema)) {
        let cond = (0, codegen_1._)`${len} >= ${min}`;
        if (max !== undefined)
          cond = (0, codegen_1._)`${cond} && ${len} <= ${max}`;
        cxt.pass(cond);
        return;
      }
      it.items = true;
      const valid = gen.name("valid");
      if (max === undefined && min === 1)
        validateItems(valid, () => gen.if(valid, () => gen.break()));
      else if (min === 0) {
        gen.let(valid, true);
        if (max !== undefined)
          gen.if((0, codegen_1._)`${data}.length > 0`, validateItemsWithCount);
      } else {
        gen.let(valid, false);
        validateItemsWithCount();
      }
      cxt.result(valid, () => cxt.reset());
      function validateItemsWithCount() {
        const schValid = gen.name("_valid");
        const count = gen.let("count", 0);
        validateItems(schValid, () => gen.if(schValid, () => checkLimits(count)));
      }
      function validateItems(_valid, block) {
        gen.forRange("i", 0, len, (i) => {
          cxt.subschema({
            keyword: "contains",
            dataProp: i,
            dataPropType: util_1.Type.Num,
            compositeRule: true
          }, _valid);
          block();
        });
      }
      function checkLimits(count) {
        gen.code((0, codegen_1._)`${count}++`);
        if (max === undefined)
          gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true).break());
        else {
          gen.if((0, codegen_1._)`${count} > ${max}`, () => gen.assign(valid, false).break());
          if (min === 1)
            gen.assign(valid, true);
          else
            gen.if((0, codegen_1._)`${count} >= ${min}`, () => gen.assign(valid, true));
        }
      }
    }
  };
  exports.default = def;
});
var require_dependencies = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.validateSchemaDeps = exports.validatePropertyDeps = exports.error = undefined;
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const code_1 = require_code();
  exports.error = {
    message: ({ params: { property, depsCount, deps } }) => {
      const property_ies = depsCount === 1 ? "property" : "properties";
      return (0, codegen_1.str)`must have ${property_ies} ${deps} when property ${property} is present`;
    },
    params: ({ params: { property, depsCount, deps, missingProperty } }) => (0, codegen_1._)`{property: ${property},
    missingProperty: ${missingProperty},
    depsCount: ${depsCount},
    deps: ${deps}}`
  };
  const def = {
    keyword: "dependencies",
    type: "object",
    schemaType: "object",
    error: exports.error,
    code(cxt) {
      const [propDeps, schDeps] = splitDependencies(cxt);
      validatePropertyDeps(cxt, propDeps);
      validateSchemaDeps(cxt, schDeps);
    }
  };
  function splitDependencies({ schema }) {
    const propertyDeps = {};
    const schemaDeps = {};
    for (const key in schema) {
      if (key === "__proto__")
        continue;
      const deps = Array.isArray(schema[key]) ? propertyDeps : schemaDeps;
      deps[key] = schema[key];
    }
    return [propertyDeps, schemaDeps];
  }
  function validatePropertyDeps(cxt, propertyDeps = cxt.schema) {
    const { gen, data, it } = cxt;
    if (Object.keys(propertyDeps).length === 0)
      return;
    const missing = gen.let("missing");
    for (const prop in propertyDeps) {
      const deps = propertyDeps[prop];
      if (deps.length === 0)
        continue;
      const hasProperty = (0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties);
      cxt.setParams({
        property: prop,
        depsCount: deps.length,
        deps: deps.join(", ")
      });
      if (it.allErrors)
        gen.if(hasProperty, () => {
          for (const depProp of deps)
            (0, code_1.checkReportMissingProp)(cxt, depProp);
        });
      else {
        gen.if((0, codegen_1._)`${hasProperty} && (${(0, code_1.checkMissingProp)(cxt, deps, missing)})`);
        (0, code_1.reportMissingProp)(cxt, missing);
        gen.else();
      }
    }
  }
  exports.validatePropertyDeps = validatePropertyDeps;
  function validateSchemaDeps(cxt, schemaDeps = cxt.schema) {
    const { gen, data, keyword, it } = cxt;
    const valid = gen.name("valid");
    for (const prop in schemaDeps) {
      if ((0, util_1.alwaysValidSchema)(it, schemaDeps[prop]))
        continue;
      gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties), () => {
        const schCxt = cxt.subschema({
          keyword,
          schemaProp: prop
        }, valid);
        cxt.mergeValidEvaluated(schCxt, valid);
      }, () => gen.var(valid, true));
      cxt.ok(valid);
    }
  }
  exports.validateSchemaDeps = validateSchemaDeps;
  exports.default = def;
});
var require_propertyNames = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "propertyNames",
    type: "object",
    schemaType: ["object", "boolean"],
    error: {
      message: "property name must be valid",
      params: ({ params }) => (0, codegen_1._)`{propertyName: ${params.propertyName}}`
    },
    code(cxt) {
      const { gen, schema, data, it } = cxt;
      if ((0, util_1.alwaysValidSchema)(it, schema))
        return;
      const valid = gen.name("valid");
      gen.forIn("key", data, (key) => {
        cxt.setParams({ propertyName: key });
        cxt.subschema({
          keyword: "propertyNames",
          data: key,
          dataTypes: ["string"],
          propertyName: key,
          compositeRule: true
        }, valid);
        gen.if((0, codegen_1.not)(valid), () => {
          cxt.error(true);
          if (!it.allErrors)
            gen.break();
        });
      });
      cxt.ok(valid);
    }
  };
  exports.default = def;
});
var require_additionalProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const util_1 = require_util();
  const def = {
    keyword: "additionalProperties",
    type: ["object"],
    schemaType: ["boolean", "object"],
    allowUndefined: true,
    trackErrors: true,
    error: {
      message: "must NOT have additional properties",
      params: ({ params }) => (0, codegen_1._)`{additionalProperty: ${params.additionalProperty}}`
    },
    code(cxt) {
      const { gen, schema, parentSchema, data, errsCount, it } = cxt;
      if (!errsCount)
        throw new Error("ajv implementation error");
      const { allErrors, opts } = it;
      it.props = true;
      if (opts.removeAdditional !== "all" && (0, util_1.alwaysValidSchema)(it, schema))
        return;
      const props = (0, code_1.allSchemaProperties)(parentSchema.properties);
      const patProps = (0, code_1.allSchemaProperties)(parentSchema.patternProperties);
      checkAdditionalProperties();
      cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
      function checkAdditionalProperties() {
        gen.forIn("key", data, (key) => {
          if (!props.length && !patProps.length)
            additionalPropertyCode(key);
          else
            gen.if(isAdditional(key), () => additionalPropertyCode(key));
        });
      }
      function isAdditional(key) {
        let definedProp;
        if (props.length > 8) {
          const propsSchema = (0, util_1.schemaRefOrVal)(it, parentSchema.properties, "properties");
          definedProp = (0, code_1.isOwnProperty)(gen, propsSchema, key);
        } else if (props.length)
          definedProp = (0, codegen_1.or)(...props.map((p) => (0, codegen_1._)`${key} === ${p}`));
        else
          definedProp = codegen_1.nil;
        if (patProps.length)
          definedProp = (0, codegen_1.or)(definedProp, ...patProps.map((p) => (0, codegen_1._)`${(0, code_1.usePattern)(cxt, p)}.test(${key})`));
        return (0, codegen_1.not)(definedProp);
      }
      function deleteAdditional(key) {
        gen.code((0, codegen_1._)`delete ${data}[${key}]`);
      }
      function additionalPropertyCode(key) {
        if (opts.removeAdditional === "all" || opts.removeAdditional && schema === false) {
          deleteAdditional(key);
          return;
        }
        if (schema === false) {
          cxt.setParams({ additionalProperty: key });
          cxt.error();
          if (!allErrors)
            gen.break();
          return;
        }
        if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.name("valid");
          if (opts.removeAdditional === "failing") {
            applyAdditionalSchema(key, valid, false);
            gen.if((0, codegen_1.not)(valid), () => {
              cxt.reset();
              deleteAdditional(key);
            });
          } else {
            applyAdditionalSchema(key, valid);
            if (!allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          }
        }
      }
      function applyAdditionalSchema(key, valid, errors) {
        const subschema = {
          keyword: "additionalProperties",
          dataProp: key,
          dataPropType: util_1.Type.Str
        };
        if (errors === false)
          Object.assign(subschema, {
            compositeRule: true,
            createErrors: false,
            allErrors: false
          });
        cxt.subschema(subschema, valid);
      }
    }
  };
  exports.default = def;
});
var require_properties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const validate_1 = require_validate();
  const code_1 = require_code();
  const util_1 = require_util();
  const additionalProperties_1 = require_additionalProperties();
  const def = {
    keyword: "properties",
    type: "object",
    schemaType: "object",
    code(cxt) {
      const { gen, schema, parentSchema, data, it } = cxt;
      if (it.opts.removeAdditional === "all" && parentSchema.additionalProperties === undefined)
        additionalProperties_1.default.code(new validate_1.KeywordCxt(it, additionalProperties_1.default, "additionalProperties"));
      const allProps = (0, code_1.allSchemaProperties)(schema);
      for (const prop of allProps)
        it.definedProperties.add(prop);
      if (it.opts.unevaluated && allProps.length && it.props !== true)
        it.props = util_1.mergeEvaluated.props(gen, (0, util_1.toHash)(allProps), it.props);
      const properties = allProps.filter((p) => !(0, util_1.alwaysValidSchema)(it, schema[p]));
      if (properties.length === 0)
        return;
      const valid = gen.name("valid");
      for (const prop of properties) {
        if (hasDefault(prop))
          applyPropertySchema(prop);
        else {
          gen.if((0, code_1.propertyInData)(gen, data, prop, it.opts.ownProperties));
          applyPropertySchema(prop);
          if (!it.allErrors)
            gen.else().var(valid, true);
          gen.endIf();
        }
        cxt.it.definedProperties.add(prop);
        cxt.ok(valid);
      }
      function hasDefault(prop) {
        return it.opts.useDefaults && !it.compositeRule && schema[prop].default !== undefined;
      }
      function applyPropertySchema(prop) {
        cxt.subschema({
          keyword: "properties",
          schemaProp: prop,
          dataProp: prop
        }, valid);
      }
    }
  };
  exports.default = def;
});
var require_patternProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const code_1 = require_code();
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const util_2 = require_util();
  const def = {
    keyword: "patternProperties",
    type: "object",
    schemaType: "object",
    code(cxt) {
      const { gen, schema, data, parentSchema, it } = cxt;
      const { opts } = it;
      const patterns = (0, code_1.allSchemaProperties)(schema);
      const alwaysValidPatterns = patterns.filter((p) => (0, util_1.alwaysValidSchema)(it, schema[p]));
      if (patterns.length === 0 || alwaysValidPatterns.length === patterns.length && (!it.opts.unevaluated || it.props === true))
        return;
      const checkProperties = opts.strictSchema && !opts.allowMatchingProperties && parentSchema.properties;
      const valid = gen.name("valid");
      if (it.props !== true && !(it.props instanceof codegen_1.Name))
        it.props = (0, util_2.evaluatedPropsToName)(gen, it.props);
      const { props } = it;
      validatePatternProperties();
      function validatePatternProperties() {
        for (const pat of patterns) {
          if (checkProperties)
            checkMatchingProperties(pat);
          if (it.allErrors)
            validateProperties(pat);
          else {
            gen.var(valid, true);
            validateProperties(pat);
            gen.if(valid);
          }
        }
      }
      function checkMatchingProperties(pat) {
        for (const prop in checkProperties)
          if (new RegExp(pat).test(prop))
            (0, util_1.checkStrictMode)(it, `property ${prop} matches pattern ${pat} (use allowMatchingProperties)`);
      }
      function validateProperties(pat) {
        gen.forIn("key", data, (key) => {
          gen.if((0, codegen_1._)`${(0, code_1.usePattern)(cxt, pat)}.test(${key})`, () => {
            const alwaysValid = alwaysValidPatterns.includes(pat);
            if (!alwaysValid)
              cxt.subschema({
                keyword: "patternProperties",
                schemaProp: pat,
                dataProp: key,
                dataPropType: util_2.Type.Str
              }, valid);
            if (it.opts.unevaluated && props !== true)
              gen.assign((0, codegen_1._)`${props}[${key}]`, true);
            else if (!alwaysValid && !it.allErrors)
              gen.if((0, codegen_1.not)(valid), () => gen.break());
          });
        });
      }
    }
  };
  exports.default = def;
});
var require_not = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: "not",
    schemaType: ["object", "boolean"],
    trackErrors: true,
    code(cxt) {
      const { gen, schema, it } = cxt;
      if ((0, util_1.alwaysValidSchema)(it, schema)) {
        cxt.fail();
        return;
      }
      const valid = gen.name("valid");
      cxt.subschema({
        keyword: "not",
        compositeRule: true,
        createErrors: false,
        allErrors: false
      }, valid);
      cxt.failResult(valid, () => cxt.reset(), () => cxt.error());
    },
    error: { message: "must NOT be valid" }
  };
  exports.default = def;
});
var require_anyOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const def = {
    keyword: "anyOf",
    schemaType: "array",
    trackErrors: true,
    code: require_code().validateUnion,
    error: { message: "must match a schema in anyOf" }
  };
  exports.default = def;
});
var require_oneOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "oneOf",
    schemaType: "array",
    trackErrors: true,
    error: {
      message: "must match exactly one schema in oneOf",
      params: ({ params }) => (0, codegen_1._)`{passingSchemas: ${params.passing}}`
    },
    code(cxt) {
      const { gen, schema, parentSchema, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      if (it.opts.discriminator && parentSchema.discriminator)
        return;
      const schArr = schema;
      const valid = gen.let("valid", false);
      const passing = gen.let("passing", null);
      const schValid = gen.name("_valid");
      cxt.setParams({ passing });
      gen.block(validateOneOf);
      cxt.result(valid, () => cxt.reset(), () => cxt.error(true));
      function validateOneOf() {
        schArr.forEach((sch, i) => {
          let schCxt;
          if ((0, util_1.alwaysValidSchema)(it, sch))
            gen.var(schValid, true);
          else
            schCxt = cxt.subschema({
              keyword: "oneOf",
              schemaProp: i,
              compositeRule: true
            }, schValid);
          if (i > 0)
            gen.if((0, codegen_1._)`${schValid} && ${valid}`).assign(valid, false).assign(passing, (0, codegen_1._)`[${passing}, ${i}]`).else();
          gen.if(schValid, () => {
            gen.assign(valid, true);
            gen.assign(passing, i);
            if (schCxt)
              cxt.mergeEvaluated(schCxt, codegen_1.Name);
          });
        });
      }
    }
  };
  exports.default = def;
});
var require_allOf = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: "allOf",
    schemaType: "array",
    code(cxt) {
      const { gen, schema, it } = cxt;
      if (!Array.isArray(schema))
        throw new Error("ajv implementation error");
      const valid = gen.name("valid");
      schema.forEach((sch, i) => {
        if ((0, util_1.alwaysValidSchema)(it, sch))
          return;
        const schCxt = cxt.subschema({
          keyword: "allOf",
          schemaProp: i
        }, valid);
        cxt.ok(valid);
        cxt.mergeEvaluated(schCxt);
      });
    }
  };
  exports.default = def;
});
var require_if = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "if",
    schemaType: ["object", "boolean"],
    trackErrors: true,
    error: {
      message: ({ params }) => (0, codegen_1.str)`must match "${params.ifClause}" schema`,
      params: ({ params }) => (0, codegen_1._)`{failingKeyword: ${params.ifClause}}`
    },
    code(cxt) {
      const { gen, parentSchema, it } = cxt;
      if (parentSchema.then === undefined && parentSchema.else === undefined)
        (0, util_1.checkStrictMode)(it, '"if" without "then" and "else" is ignored');
      const hasThen = hasSchema(it, "then");
      const hasElse = hasSchema(it, "else");
      if (!hasThen && !hasElse)
        return;
      const valid = gen.let("valid", true);
      const schValid = gen.name("_valid");
      validateIf();
      cxt.reset();
      if (hasThen && hasElse) {
        const ifClause = gen.let("ifClause");
        cxt.setParams({ ifClause });
        gen.if(schValid, validateClause("then", ifClause), validateClause("else", ifClause));
      } else if (hasThen)
        gen.if(schValid, validateClause("then"));
      else
        gen.if((0, codegen_1.not)(schValid), validateClause("else"));
      cxt.pass(valid, () => cxt.error(true));
      function validateIf() {
        const schCxt = cxt.subschema({
          keyword: "if",
          compositeRule: true,
          createErrors: false,
          allErrors: false
        }, schValid);
        cxt.mergeEvaluated(schCxt);
      }
      function validateClause(keyword, ifClause) {
        return () => {
          const schCxt = cxt.subschema({ keyword }, schValid);
          gen.assign(valid, schValid);
          cxt.mergeValidEvaluated(schCxt, valid);
          if (ifClause)
            gen.assign(ifClause, (0, codegen_1._)`${keyword}`);
          else
            cxt.setParams({ ifClause: keyword });
        };
      }
    }
  };
  function hasSchema(it, keyword) {
    const schema = it.schema[keyword];
    return schema !== undefined && !(0, util_1.alwaysValidSchema)(it, schema);
  }
  exports.default = def;
});
var require_thenElse = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: ["then", "else"],
    schemaType: ["object", "boolean"],
    code({ keyword, parentSchema, it }) {
      if (parentSchema.if === undefined)
        (0, util_1.checkStrictMode)(it, `"${keyword}" without "if" is ignored`);
    }
  };
  exports.default = def;
});
var require_applicator$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const additionalItems_1 = require_additionalItems();
  const prefixItems_1 = require_prefixItems();
  const items_1 = require_items();
  const items2020_1 = require_items2020();
  const contains_1 = require_contains();
  const dependencies_1 = require_dependencies();
  const propertyNames_1 = require_propertyNames();
  const additionalProperties_1 = require_additionalProperties();
  const properties_1 = require_properties();
  const patternProperties_1 = require_patternProperties();
  const not_1 = require_not();
  const anyOf_1 = require_anyOf();
  const oneOf_1 = require_oneOf();
  const allOf_1 = require_allOf();
  const if_1 = require_if();
  const thenElse_1 = require_thenElse();
  function getApplicator(draft2020 = false) {
    const applicator = [
      not_1.default,
      anyOf_1.default,
      oneOf_1.default,
      allOf_1.default,
      if_1.default,
      thenElse_1.default,
      propertyNames_1.default,
      additionalProperties_1.default,
      dependencies_1.default,
      properties_1.default,
      patternProperties_1.default
    ];
    if (draft2020)
      applicator.push(prefixItems_1.default, items2020_1.default);
    else
      applicator.push(additionalItems_1.default, items_1.default);
    applicator.push(contains_1.default);
    return applicator;
  }
  exports.default = getApplicator;
});
var require_format$2 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const def = {
    keyword: "format",
    type: ["number", "string"],
    schemaType: "string",
    $data: true,
    error: {
      message: ({ schemaCode }) => (0, codegen_1.str)`must match format "${schemaCode}"`,
      params: ({ schemaCode }) => (0, codegen_1._)`{format: ${schemaCode}}`
    },
    code(cxt, ruleType) {
      const { gen, data, $data, schema, schemaCode, it } = cxt;
      const { opts, errSchemaPath, schemaEnv, self } = it;
      if (!opts.validateFormats)
        return;
      if ($data)
        validate$DataFormat();
      else
        validateFormat();
      function validate$DataFormat() {
        const fmts = gen.scopeValue("formats", {
          ref: self.formats,
          code: opts.code.formats
        });
        const fDef = gen.const("fDef", (0, codegen_1._)`${fmts}[${schemaCode}]`);
        const fType = gen.let("fType");
        const format = gen.let("format");
        gen.if((0, codegen_1._)`typeof ${fDef} == "object" && !(${fDef} instanceof RegExp)`, () => gen.assign(fType, (0, codegen_1._)`${fDef}.type || "string"`).assign(format, (0, codegen_1._)`${fDef}.validate`), () => gen.assign(fType, (0, codegen_1._)`"string"`).assign(format, fDef));
        cxt.fail$data((0, codegen_1.or)(unknownFmt(), invalidFmt()));
        function unknownFmt() {
          if (opts.strictSchema === false)
            return codegen_1.nil;
          return (0, codegen_1._)`${schemaCode} && !${format}`;
        }
        function invalidFmt() {
          const callFormat = schemaEnv.$async ? (0, codegen_1._)`(${fDef}.async ? await ${format}(${data}) : ${format}(${data}))` : (0, codegen_1._)`${format}(${data})`;
          const validData = (0, codegen_1._)`(typeof ${format} == "function" ? ${callFormat} : ${format}.test(${data}))`;
          return (0, codegen_1._)`${format} && ${format} !== true && ${fType} === ${ruleType} && !${validData}`;
        }
      }
      function validateFormat() {
        const formatDef = self.formats[schema];
        if (!formatDef) {
          unknownFormat();
          return;
        }
        if (formatDef === true)
          return;
        const [fmtType, format, fmtRef] = getFormat(formatDef);
        if (fmtType === ruleType)
          cxt.pass(validCondition());
        function unknownFormat() {
          if (opts.strictSchema === false) {
            self.logger.warn(unknownMsg());
            return;
          }
          throw new Error(unknownMsg());
          function unknownMsg() {
            return `unknown format "${schema}" ignored in schema at path "${errSchemaPath}"`;
          }
        }
        function getFormat(fmtDef) {
          const code = fmtDef instanceof RegExp ? (0, codegen_1.regexpCode)(fmtDef) : opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(schema)}` : undefined;
          const fmt = gen.scopeValue("formats", {
            key: schema,
            ref: fmtDef,
            code
          });
          if (typeof fmtDef == "object" && !(fmtDef instanceof RegExp))
            return [
              fmtDef.type || "string",
              fmtDef.validate,
              (0, codegen_1._)`${fmt}.validate`
            ];
          return [
            "string",
            fmtDef,
            fmt
          ];
        }
        function validCondition() {
          if (typeof formatDef == "object" && !(formatDef instanceof RegExp) && formatDef.async) {
            if (!schemaEnv.$async)
              throw new Error("async format in sync schema");
            return (0, codegen_1._)`await ${fmtRef}(${data})`;
          }
          return typeof format == "function" ? (0, codegen_1._)`${fmtRef}(${data})` : (0, codegen_1._)`${fmtRef}.test(${data})`;
        }
      }
    }
  };
  exports.default = def;
});
var require_format$1 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const format = [require_format$2().default];
  exports.default = format;
});
var require_metadata = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.contentVocabulary = exports.metadataVocabulary = undefined;
  exports.metadataVocabulary = [
    "title",
    "description",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
    "examples"
  ];
  exports.contentVocabulary = [
    "contentMediaType",
    "contentEncoding",
    "contentSchema"
  ];
});
var require_draft7 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const core_1 = require_core$2();
  const validation_1 = require_validation$2();
  const applicator_1 = require_applicator$2();
  const format_1 = require_format$1();
  const metadata_1 = require_metadata();
  const draft7Vocabularies = [
    core_1.default,
    validation_1.default,
    (0, applicator_1.default)(),
    format_1.default,
    metadata_1.metadataVocabulary,
    metadata_1.contentVocabulary
  ];
  exports.default = draft7Vocabularies;
});
var require_types = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.DiscrError = undefined;
  var DiscrError;
  (function(DiscrError) {
    DiscrError["Tag"] = "tag";
    DiscrError["Mapping"] = "mapping";
  })(DiscrError || (exports.DiscrError = DiscrError = {}));
});
var require_discriminator = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const types_1 = require_types();
  const compile_1 = require_compile();
  const ref_error_1 = require_ref_error();
  const util_1 = require_util();
  const def = {
    keyword: "discriminator",
    type: "object",
    schemaType: "object",
    error: {
      message: ({ params: { discrError, tagName } }) => discrError === types_1.DiscrError.Tag ? `tag "${tagName}" must be string` : `value of tag "${tagName}" must be in oneOf`,
      params: ({ params: { discrError, tag, tagName } }) => (0, codegen_1._)`{error: ${discrError}, tag: ${tagName}, tagValue: ${tag}}`
    },
    code(cxt) {
      const { gen, data, schema, parentSchema, it } = cxt;
      const { oneOf } = parentSchema;
      if (!it.opts.discriminator)
        throw new Error("discriminator: requires discriminator option");
      const tagName = schema.propertyName;
      if (typeof tagName != "string")
        throw new Error("discriminator: requires propertyName");
      if (schema.mapping)
        throw new Error("discriminator: mapping is not supported");
      if (!oneOf)
        throw new Error("discriminator: requires oneOf keyword");
      const valid = gen.let("valid", false);
      const tag = gen.const("tag", (0, codegen_1._)`${data}${(0, codegen_1.getProperty)(tagName)}`);
      gen.if((0, codegen_1._)`typeof ${tag} == "string"`, () => validateMapping(), () => cxt.error(false, {
        discrError: types_1.DiscrError.Tag,
        tag,
        tagName
      }));
      cxt.ok(valid);
      function validateMapping() {
        const mapping = getMapping();
        gen.if(false);
        for (const tagValue in mapping) {
          gen.elseIf((0, codegen_1._)`${tag} === ${tagValue}`);
          gen.assign(valid, applyTagSchema(mapping[tagValue]));
        }
        gen.else();
        cxt.error(false, {
          discrError: types_1.DiscrError.Mapping,
          tag,
          tagName
        });
        gen.endIf();
      }
      function applyTagSchema(schemaProp) {
        const _valid = gen.name("valid");
        const schCxt = cxt.subschema({
          keyword: "oneOf",
          schemaProp
        }, _valid);
        cxt.mergeEvaluated(schCxt, codegen_1.Name);
        return _valid;
      }
      function getMapping() {
        var _a;
        const oneOfMapping = {};
        const topRequired = hasRequired(parentSchema);
        let tagRequired = true;
        for (let i = 0;i < oneOf.length; i++) {
          let sch = oneOf[i];
          if ((sch === null || sch === undefined ? undefined : sch.$ref) && !(0, util_1.schemaHasRulesButRef)(sch, it.self.RULES)) {
            const ref = sch.$ref;
            sch = compile_1.resolveRef.call(it.self, it.schemaEnv.root, it.baseId, ref);
            if (sch instanceof compile_1.SchemaEnv)
              sch = sch.schema;
            if (sch === undefined)
              throw new ref_error_1.default(it.opts.uriResolver, it.baseId, ref);
          }
          const propSch = (_a = sch === null || sch === undefined ? undefined : sch.properties) === null || _a === undefined ? undefined : _a[tagName];
          if (typeof propSch != "object")
            throw new Error(`discriminator: oneOf subschemas (or referenced schemas) must have "properties/${tagName}"`);
          tagRequired = tagRequired && (topRequired || hasRequired(sch));
          addMappings(propSch, i);
        }
        if (!tagRequired)
          throw new Error(`discriminator: "${tagName}" must be required`);
        return oneOfMapping;
        function hasRequired({ required }) {
          return Array.isArray(required) && required.includes(tagName);
        }
        function addMappings(sch, i) {
          if (sch.const)
            addMapping(sch.const, i);
          else if (sch.enum)
            for (const tagValue of sch.enum)
              addMapping(tagValue, i);
          else
            throw new Error(`discriminator: "properties/${tagName}" must have "const" or "enum"`);
        }
        function addMapping(tagValue, i) {
          if (typeof tagValue != "string" || tagValue in oneOfMapping)
            throw new Error(`discriminator: "${tagName}" values must be unique strings`);
          oneOfMapping[tagValue] = i;
        }
      }
    }
  };
  exports.default = def;
});
var require_json_schema_draft_07 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "http://json-schema.org/draft-07/schema#",
    title: "Core schema meta-schema",
    definitions: {
      schemaArray: {
        type: "array",
        minItems: 1,
        items: { $ref: "#" }
      },
      nonNegativeInteger: {
        type: "integer",
        minimum: 0
      },
      nonNegativeIntegerDefault0: { allOf: [{ $ref: "#/definitions/nonNegativeInteger" }, { default: 0 }] },
      simpleTypes: { enum: [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
      ] },
      stringArray: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        default: []
      }
    },
    type: ["object", "boolean"],
    properties: {
      $id: {
        type: "string",
        format: "uri-reference"
      },
      $schema: {
        type: "string",
        format: "uri"
      },
      $ref: {
        type: "string",
        format: "uri-reference"
      },
      $comment: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      default: true,
      readOnly: {
        type: "boolean",
        default: false
      },
      examples: {
        type: "array",
        items: true
      },
      multipleOf: {
        type: "number",
        exclusiveMinimum: 0
      },
      maximum: { type: "number" },
      exclusiveMaximum: { type: "number" },
      minimum: { type: "number" },
      exclusiveMinimum: { type: "number" },
      maxLength: { $ref: "#/definitions/nonNegativeInteger" },
      minLength: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
      pattern: {
        type: "string",
        format: "regex"
      },
      additionalItems: { $ref: "#" },
      items: {
        anyOf: [{ $ref: "#" }, { $ref: "#/definitions/schemaArray" }],
        default: true
      },
      maxItems: { $ref: "#/definitions/nonNegativeInteger" },
      minItems: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
      uniqueItems: {
        type: "boolean",
        default: false
      },
      contains: { $ref: "#" },
      maxProperties: { $ref: "#/definitions/nonNegativeInteger" },
      minProperties: { $ref: "#/definitions/nonNegativeIntegerDefault0" },
      required: { $ref: "#/definitions/stringArray" },
      additionalProperties: { $ref: "#" },
      definitions: {
        type: "object",
        additionalProperties: { $ref: "#" },
        default: {}
      },
      properties: {
        type: "object",
        additionalProperties: { $ref: "#" },
        default: {}
      },
      patternProperties: {
        type: "object",
        additionalProperties: { $ref: "#" },
        propertyNames: { format: "regex" },
        default: {}
      },
      dependencies: {
        type: "object",
        additionalProperties: { anyOf: [{ $ref: "#" }, { $ref: "#/definitions/stringArray" }] }
      },
      propertyNames: { $ref: "#" },
      const: true,
      enum: {
        type: "array",
        items: true,
        minItems: 1,
        uniqueItems: true
      },
      type: { anyOf: [{ $ref: "#/definitions/simpleTypes" }, {
        type: "array",
        items: { $ref: "#/definitions/simpleTypes" },
        minItems: 1,
        uniqueItems: true
      }] },
      format: { type: "string" },
      contentMediaType: { type: "string" },
      contentEncoding: { type: "string" },
      if: { $ref: "#" },
      then: { $ref: "#" },
      else: { $ref: "#" },
      allOf: { $ref: "#/definitions/schemaArray" },
      anyOf: { $ref: "#/definitions/schemaArray" },
      oneOf: { $ref: "#/definitions/schemaArray" },
      not: { $ref: "#" }
    },
    default: true
  };
});
var require_ajv = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv = undefined;
  const core_1 = require_core$3();
  const draft7_1 = require_draft7();
  const discriminator_1 = require_discriminator();
  const draft7MetaSchema = require_json_schema_draft_07();
  const META_SUPPORT_DATA = ["/properties"];
  const META_SCHEMA_ID = "http://json-schema.org/draft-07/schema";
  var Ajv = class extends core_1.default {
    _addVocabularies() {
      super._addVocabularies();
      draft7_1.default.forEach((v) => this.addVocabulary(v));
      if (this.opts.discriminator)
        this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      if (!this.opts.meta)
        return;
      const metaSchema = this.opts.$data ? this.$dataMetaSchema(draft7MetaSchema, META_SUPPORT_DATA) : draft7MetaSchema;
      this.addMetaSchema(metaSchema, META_SCHEMA_ID, false);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : undefined);
    }
  };
  exports.Ajv = Ajv;
  module.exports = exports = Ajv;
  module.exports.Ajv = Ajv;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", {
    enumerable: true,
    get: function() {
      return validation_error_1.default;
    }
  });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", {
    enumerable: true,
    get: function() {
      return ref_error_1.default;
    }
  });
});
var require_dynamicAnchor = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.dynamicAnchor = undefined;
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const compile_1 = require_compile();
  const ref_1 = require_ref();
  const def = {
    keyword: "$dynamicAnchor",
    schemaType: "string",
    code: (cxt) => dynamicAnchor(cxt, cxt.schema)
  };
  function dynamicAnchor(cxt, anchor) {
    const { gen, it } = cxt;
    it.schemaEnv.root.dynamicAnchors[anchor] = true;
    const v = (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`;
    const validate = it.errSchemaPath === "#" ? it.validateName : _getValidate(cxt);
    gen.if((0, codegen_1._)`!${v}`, () => gen.assign(v, validate));
  }
  exports.dynamicAnchor = dynamicAnchor;
  function _getValidate(cxt) {
    const { schemaEnv, schema, self } = cxt.it;
    const { root, baseId, localRefs, meta } = schemaEnv.root;
    const { schemaId } = self.opts;
    const sch = new compile_1.SchemaEnv({
      schema,
      schemaId,
      root,
      baseId,
      localRefs,
      meta
    });
    compile_1.compileSchema.call(self, sch);
    return (0, ref_1.getValidate)(cxt, sch);
  }
  exports.default = def;
});
var require_dynamicRef = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.dynamicRef = undefined;
  const codegen_1 = require_codegen();
  const names_1 = require_names();
  const ref_1 = require_ref();
  const def = {
    keyword: "$dynamicRef",
    schemaType: "string",
    code: (cxt) => dynamicRef(cxt, cxt.schema)
  };
  function dynamicRef(cxt, ref) {
    const { gen, keyword, it } = cxt;
    if (ref[0] !== "#")
      throw new Error(`"${keyword}" only supports hash fragment reference`);
    const anchor = ref.slice(1);
    if (it.allErrors)
      _dynamicRef();
    else {
      const valid = gen.let("valid", false);
      _dynamicRef(valid);
      cxt.ok(valid);
    }
    function _dynamicRef(valid) {
      if (it.schemaEnv.root.dynamicAnchors[anchor]) {
        const v = gen.let("_v", (0, codegen_1._)`${names_1.default.dynamicAnchors}${(0, codegen_1.getProperty)(anchor)}`);
        gen.if(v, _callRef(v, valid), _callRef(it.validateName, valid));
      } else
        _callRef(it.validateName, valid)();
    }
    function _callRef(validate, valid) {
      return valid ? () => gen.block(() => {
        (0, ref_1.callRef)(cxt, validate);
        gen.let(valid, true);
      }) : () => (0, ref_1.callRef)(cxt, validate);
    }
  }
  exports.dynamicRef = dynamicRef;
  exports.default = def;
});
var require_recursiveAnchor = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dynamicAnchor_1 = require_dynamicAnchor();
  const util_1 = require_util();
  const def = {
    keyword: "$recursiveAnchor",
    schemaType: "boolean",
    code(cxt) {
      if (cxt.schema)
        (0, dynamicAnchor_1.dynamicAnchor)(cxt, "");
      else
        (0, util_1.checkStrictMode)(cxt.it, "$recursiveAnchor: false is ignored");
    }
  };
  exports.default = def;
});
var require_recursiveRef = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dynamicRef_1 = require_dynamicRef();
  const def = {
    keyword: "$recursiveRef",
    schemaType: "string",
    code: (cxt) => (0, dynamicRef_1.dynamicRef)(cxt, cxt.schema)
  };
  exports.default = def;
});
var require_dynamic = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dynamicAnchor_1 = require_dynamicAnchor();
  const dynamicRef_1 = require_dynamicRef();
  const recursiveAnchor_1 = require_recursiveAnchor();
  const recursiveRef_1 = require_recursiveRef();
  const dynamic = [
    dynamicAnchor_1.default,
    dynamicRef_1.default,
    recursiveAnchor_1.default,
    recursiveRef_1.default
  ];
  exports.default = dynamic;
});
var require_dependentRequired = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dependencies_1 = require_dependencies();
  const def = {
    keyword: "dependentRequired",
    type: "object",
    schemaType: "object",
    error: dependencies_1.error,
    code: (cxt) => (0, dependencies_1.validatePropertyDeps)(cxt)
  };
  exports.default = def;
});
var require_dependentSchemas = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dependencies_1 = require_dependencies();
  const def = {
    keyword: "dependentSchemas",
    type: "object",
    schemaType: "object",
    code: (cxt) => (0, dependencies_1.validateSchemaDeps)(cxt)
  };
  exports.default = def;
});
var require_limitContains = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const util_1 = require_util();
  const def = {
    keyword: ["maxContains", "minContains"],
    type: "array",
    schemaType: "number",
    code({ keyword, parentSchema, it }) {
      if (parentSchema.contains === undefined)
        (0, util_1.checkStrictMode)(it, `"${keyword}" without "contains" is ignored`);
    }
  };
  exports.default = def;
});
var require_next = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const dependentRequired_1 = require_dependentRequired();
  const dependentSchemas_1 = require_dependentSchemas();
  const limitContains_1 = require_limitContains();
  const next = [
    dependentRequired_1.default,
    dependentSchemas_1.default,
    limitContains_1.default
  ];
  exports.default = next;
});
var require_unevaluatedProperties = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const names_1 = require_names();
  const def = {
    keyword: "unevaluatedProperties",
    type: "object",
    schemaType: ["boolean", "object"],
    trackErrors: true,
    error: {
      message: "must NOT have unevaluated properties",
      params: ({ params }) => (0, codegen_1._)`{unevaluatedProperty: ${params.unevaluatedProperty}}`
    },
    code(cxt) {
      const { gen, schema, data, errsCount, it } = cxt;
      if (!errsCount)
        throw new Error("ajv implementation error");
      const { allErrors, props } = it;
      if (props instanceof codegen_1.Name)
        gen.if((0, codegen_1._)`${props} !== true`, () => gen.forIn("key", data, (key) => gen.if(unevaluatedDynamic(props, key), () => unevaluatedPropCode(key))));
      else if (props !== true)
        gen.forIn("key", data, (key) => props === undefined ? unevaluatedPropCode(key) : gen.if(unevaluatedStatic(props, key), () => unevaluatedPropCode(key)));
      it.props = true;
      cxt.ok((0, codegen_1._)`${errsCount} === ${names_1.default.errors}`);
      function unevaluatedPropCode(key) {
        if (schema === false) {
          cxt.setParams({ unevaluatedProperty: key });
          cxt.error();
          if (!allErrors)
            gen.break();
          return;
        }
        if (!(0, util_1.alwaysValidSchema)(it, schema)) {
          const valid = gen.name("valid");
          cxt.subschema({
            keyword: "unevaluatedProperties",
            dataProp: key,
            dataPropType: util_1.Type.Str
          }, valid);
          if (!allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        }
      }
      function unevaluatedDynamic(evaluatedProps, key) {
        return (0, codegen_1._)`!${evaluatedProps} || !${evaluatedProps}[${key}]`;
      }
      function unevaluatedStatic(evaluatedProps, key) {
        const ps = [];
        for (const p in evaluatedProps)
          if (evaluatedProps[p] === true)
            ps.push((0, codegen_1._)`${key} !== ${p}`);
        return (0, codegen_1.and)(...ps);
      }
    }
  };
  exports.default = def;
});
var require_unevaluatedItems = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const codegen_1 = require_codegen();
  const util_1 = require_util();
  const def = {
    keyword: "unevaluatedItems",
    type: "array",
    schemaType: ["boolean", "object"],
    error: {
      message: ({ params: { len } }) => (0, codegen_1.str)`must NOT have more than ${len} items`,
      params: ({ params: { len } }) => (0, codegen_1._)`{limit: ${len}}`
    },
    code(cxt) {
      const { gen, schema, data, it } = cxt;
      const items = it.items || 0;
      if (items === true)
        return;
      const len = gen.const("len", (0, codegen_1._)`${data}.length`);
      if (schema === false) {
        cxt.setParams({ len: items });
        cxt.fail((0, codegen_1._)`${len} > ${items}`);
      } else if (typeof schema == "object" && !(0, util_1.alwaysValidSchema)(it, schema)) {
        const valid = gen.var("valid", (0, codegen_1._)`${len} <= ${items}`);
        gen.if((0, codegen_1.not)(valid), () => validateItems(valid, items));
        cxt.ok(valid);
      }
      it.items = true;
      function validateItems(valid, from) {
        gen.forRange("i", from, len, (i) => {
          cxt.subschema({
            keyword: "unevaluatedItems",
            dataProp: i,
            dataPropType: util_1.Type.Num
          }, valid);
          if (!it.allErrors)
            gen.if((0, codegen_1.not)(valid), () => gen.break());
        });
      }
    }
  };
  exports.default = def;
});
var require_unevaluated$1 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const unevaluatedProperties_1 = require_unevaluatedProperties();
  const unevaluatedItems_1 = require_unevaluatedItems();
  const unevaluated = [unevaluatedProperties_1.default, unevaluatedItems_1.default];
  exports.default = unevaluated;
});
var require_schema$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/schema",
    $vocabulary: {
      "https://json-schema.org/draft/2019-09/vocab/core": true,
      "https://json-schema.org/draft/2019-09/vocab/applicator": true,
      "https://json-schema.org/draft/2019-09/vocab/validation": true,
      "https://json-schema.org/draft/2019-09/vocab/meta-data": true,
      "https://json-schema.org/draft/2019-09/vocab/format": false,
      "https://json-schema.org/draft/2019-09/vocab/content": true
    },
    $recursiveAnchor: true,
    title: "Core and Validation specifications meta-schema",
    allOf: [
      { $ref: "meta/core" },
      { $ref: "meta/applicator" },
      { $ref: "meta/validation" },
      { $ref: "meta/meta-data" },
      { $ref: "meta/format" },
      { $ref: "meta/content" }
    ],
    type: ["object", "boolean"],
    properties: {
      definitions: {
        $comment: "While no longer an official keyword as it is replaced by $defs, this keyword is retained in the meta-schema to prevent incompatible extensions as it remains in common use.",
        type: "object",
        additionalProperties: { $recursiveRef: "#" },
        default: {}
      },
      dependencies: {
        $comment: '"dependencies" is no longer a keyword, but schema authors should avoid redefining it to facilitate a smooth transition to "dependentSchemas" and "dependentRequired"',
        type: "object",
        additionalProperties: { anyOf: [{ $recursiveRef: "#" }, { $ref: "meta/validation#/$defs/stringArray" }] }
      }
    }
  };
});
var require_applicator$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/meta/applicator",
    $vocabulary: { "https://json-schema.org/draft/2019-09/vocab/applicator": true },
    $recursiveAnchor: true,
    title: "Applicator vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      additionalItems: { $recursiveRef: "#" },
      unevaluatedItems: { $recursiveRef: "#" },
      items: { anyOf: [{ $recursiveRef: "#" }, { $ref: "#/$defs/schemaArray" }] },
      contains: { $recursiveRef: "#" },
      additionalProperties: { $recursiveRef: "#" },
      unevaluatedProperties: { $recursiveRef: "#" },
      properties: {
        type: "object",
        additionalProperties: { $recursiveRef: "#" },
        default: {}
      },
      patternProperties: {
        type: "object",
        additionalProperties: { $recursiveRef: "#" },
        propertyNames: { format: "regex" },
        default: {}
      },
      dependentSchemas: {
        type: "object",
        additionalProperties: { $recursiveRef: "#" }
      },
      propertyNames: { $recursiveRef: "#" },
      if: { $recursiveRef: "#" },
      then: { $recursiveRef: "#" },
      else: { $recursiveRef: "#" },
      allOf: { $ref: "#/$defs/schemaArray" },
      anyOf: { $ref: "#/$defs/schemaArray" },
      oneOf: { $ref: "#/$defs/schemaArray" },
      not: { $recursiveRef: "#" }
    },
    $defs: { schemaArray: {
      type: "array",
      minItems: 1,
      items: { $recursiveRef: "#" }
    } }
  };
});
var require_content$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/meta/content",
    $vocabulary: { "https://json-schema.org/draft/2019-09/vocab/content": true },
    $recursiveAnchor: true,
    title: "Content vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      contentMediaType: { type: "string" },
      contentEncoding: { type: "string" },
      contentSchema: { $recursiveRef: "#" }
    }
  };
});
var require_core$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/meta/core",
    $vocabulary: { "https://json-schema.org/draft/2019-09/vocab/core": true },
    $recursiveAnchor: true,
    title: "Core vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      $id: {
        type: "string",
        format: "uri-reference",
        $comment: "Non-empty fragments not allowed.",
        pattern: "^[^#]*#?$"
      },
      $schema: {
        type: "string",
        format: "uri"
      },
      $anchor: {
        type: "string",
        pattern: "^[A-Za-z][-A-Za-z0-9.:_]*$"
      },
      $ref: {
        type: "string",
        format: "uri-reference"
      },
      $recursiveRef: {
        type: "string",
        format: "uri-reference"
      },
      $recursiveAnchor: {
        type: "boolean",
        default: false
      },
      $vocabulary: {
        type: "object",
        propertyNames: {
          type: "string",
          format: "uri"
        },
        additionalProperties: { type: "boolean" }
      },
      $comment: { type: "string" },
      $defs: {
        type: "object",
        additionalProperties: { $recursiveRef: "#" },
        default: {}
      }
    }
  };
});
var require_format = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/meta/format",
    $vocabulary: { "https://json-schema.org/draft/2019-09/vocab/format": true },
    $recursiveAnchor: true,
    title: "Format vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: { format: { type: "string" } }
  };
});
var require_meta_data$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/meta/meta-data",
    $vocabulary: { "https://json-schema.org/draft/2019-09/vocab/meta-data": true },
    $recursiveAnchor: true,
    title: "Meta-data vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      default: true,
      deprecated: {
        type: "boolean",
        default: false
      },
      readOnly: {
        type: "boolean",
        default: false
      },
      writeOnly: {
        type: "boolean",
        default: false
      },
      examples: {
        type: "array",
        items: true
      }
    }
  };
});
var require_validation$1 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2019-09/schema",
    $id: "https://json-schema.org/draft/2019-09/meta/validation",
    $vocabulary: { "https://json-schema.org/draft/2019-09/vocab/validation": true },
    $recursiveAnchor: true,
    title: "Validation vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      multipleOf: {
        type: "number",
        exclusiveMinimum: 0
      },
      maximum: { type: "number" },
      exclusiveMaximum: { type: "number" },
      minimum: { type: "number" },
      exclusiveMinimum: { type: "number" },
      maxLength: { $ref: "#/$defs/nonNegativeInteger" },
      minLength: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
      pattern: {
        type: "string",
        format: "regex"
      },
      maxItems: { $ref: "#/$defs/nonNegativeInteger" },
      minItems: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
      uniqueItems: {
        type: "boolean",
        default: false
      },
      maxContains: { $ref: "#/$defs/nonNegativeInteger" },
      minContains: {
        $ref: "#/$defs/nonNegativeInteger",
        default: 1
      },
      maxProperties: { $ref: "#/$defs/nonNegativeInteger" },
      minProperties: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
      required: { $ref: "#/$defs/stringArray" },
      dependentRequired: {
        type: "object",
        additionalProperties: { $ref: "#/$defs/stringArray" }
      },
      const: true,
      enum: {
        type: "array",
        items: true
      },
      type: { anyOf: [{ $ref: "#/$defs/simpleTypes" }, {
        type: "array",
        items: { $ref: "#/$defs/simpleTypes" },
        minItems: 1,
        uniqueItems: true
      }] }
    },
    $defs: {
      nonNegativeInteger: {
        type: "integer",
        minimum: 0
      },
      nonNegativeIntegerDefault0: {
        $ref: "#/$defs/nonNegativeInteger",
        default: 0
      },
      simpleTypes: { enum: [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
      ] },
      stringArray: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        default: []
      }
    }
  };
});
var require_json_schema_2019_09 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const metaSchema = require_schema$1();
  const applicator = require_applicator$1();
  const content = require_content$1();
  const core = require_core$1();
  const format = require_format();
  const metadata = require_meta_data$1();
  const validation = require_validation$1();
  const META_SUPPORT_DATA = ["/properties"];
  function addMetaSchema2019($data) {
    [
      metaSchema,
      applicator,
      content,
      core,
      with$data(this, format),
      metadata,
      with$data(this, validation)
    ].forEach((sch) => this.addMetaSchema(sch, undefined, false));
    return this;
    function with$data(ajv, sch) {
      return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
    }
  }
  exports.default = addMetaSchema2019;
});
var require__2019 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2019 = undefined;
  const core_1 = require_core$3();
  const draft7_1 = require_draft7();
  const dynamic_1 = require_dynamic();
  const next_1 = require_next();
  const unevaluated_1 = require_unevaluated$1();
  const discriminator_1 = require_discriminator();
  const json_schema_2019_09_1 = require_json_schema_2019_09();
  const META_SCHEMA_ID = "https://json-schema.org/draft/2019-09/schema";
  var Ajv2019 = class extends core_1.default {
    constructor(opts = {}) {
      super({
        ...opts,
        dynamicRef: true,
        next: true,
        unevaluated: true
      });
    }
    _addVocabularies() {
      super._addVocabularies();
      this.addVocabulary(dynamic_1.default);
      draft7_1.default.forEach((v) => this.addVocabulary(v));
      this.addVocabulary(next_1.default);
      this.addVocabulary(unevaluated_1.default);
      if (this.opts.discriminator)
        this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      const { $data, meta } = this.opts;
      if (!meta)
        return;
      json_schema_2019_09_1.default.call(this, $data);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : undefined);
    }
  };
  exports.Ajv2019 = Ajv2019;
  module.exports = exports = Ajv2019;
  module.exports.Ajv2019 = Ajv2019;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv2019;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", {
    enumerable: true,
    get: function() {
      return validation_error_1.default;
    }
  });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", {
    enumerable: true,
    get: function() {
      return ref_error_1.default;
    }
  });
});
var require_draft2020 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const core_1 = require_core$2();
  const validation_1 = require_validation$2();
  const applicator_1 = require_applicator$2();
  const dynamic_1 = require_dynamic();
  const next_1 = require_next();
  const unevaluated_1 = require_unevaluated$1();
  const format_1 = require_format$1();
  const metadata_1 = require_metadata();
  const draft2020Vocabularies = [
    dynamic_1.default,
    core_1.default,
    validation_1.default,
    (0, applicator_1.default)(true),
    format_1.default,
    metadata_1.metadataVocabulary,
    metadata_1.contentVocabulary,
    next_1.default,
    unevaluated_1.default
  ];
  exports.default = draft2020Vocabularies;
});
var require_schema = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/schema",
    $vocabulary: {
      "https://json-schema.org/draft/2020-12/vocab/core": true,
      "https://json-schema.org/draft/2020-12/vocab/applicator": true,
      "https://json-schema.org/draft/2020-12/vocab/unevaluated": true,
      "https://json-schema.org/draft/2020-12/vocab/validation": true,
      "https://json-schema.org/draft/2020-12/vocab/meta-data": true,
      "https://json-schema.org/draft/2020-12/vocab/format-annotation": true,
      "https://json-schema.org/draft/2020-12/vocab/content": true
    },
    $dynamicAnchor: "meta",
    title: "Core and Validation specifications meta-schema",
    allOf: [
      { $ref: "meta/core" },
      { $ref: "meta/applicator" },
      { $ref: "meta/unevaluated" },
      { $ref: "meta/validation" },
      { $ref: "meta/meta-data" },
      { $ref: "meta/format-annotation" },
      { $ref: "meta/content" }
    ],
    type: ["object", "boolean"],
    $comment: "This meta-schema also defines keywords that have appeared in previous drafts in order to prevent incompatible extensions as they remain in common use.",
    properties: {
      definitions: {
        $comment: '"definitions" has been replaced by "$defs".',
        type: "object",
        additionalProperties: { $dynamicRef: "#meta" },
        deprecated: true,
        default: {}
      },
      dependencies: {
        $comment: '"dependencies" has been split and replaced by "dependentSchemas" and "dependentRequired" in order to serve their differing semantics.',
        type: "object",
        additionalProperties: { anyOf: [{ $dynamicRef: "#meta" }, { $ref: "meta/validation#/$defs/stringArray" }] },
        deprecated: true,
        default: {}
      },
      $recursiveAnchor: {
        $comment: '"$recursiveAnchor" has been replaced by "$dynamicAnchor".',
        $ref: "meta/core#/$defs/anchorString",
        deprecated: true
      },
      $recursiveRef: {
        $comment: '"$recursiveRef" has been replaced by "$dynamicRef".',
        $ref: "meta/core#/$defs/uriReferenceString",
        deprecated: true
      }
    }
  };
});
var require_applicator = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/applicator",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/applicator": true },
    $dynamicAnchor: "meta",
    title: "Applicator vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      prefixItems: { $ref: "#/$defs/schemaArray" },
      items: { $dynamicRef: "#meta" },
      contains: { $dynamicRef: "#meta" },
      additionalProperties: { $dynamicRef: "#meta" },
      properties: {
        type: "object",
        additionalProperties: { $dynamicRef: "#meta" },
        default: {}
      },
      patternProperties: {
        type: "object",
        additionalProperties: { $dynamicRef: "#meta" },
        propertyNames: { format: "regex" },
        default: {}
      },
      dependentSchemas: {
        type: "object",
        additionalProperties: { $dynamicRef: "#meta" },
        default: {}
      },
      propertyNames: { $dynamicRef: "#meta" },
      if: { $dynamicRef: "#meta" },
      then: { $dynamicRef: "#meta" },
      else: { $dynamicRef: "#meta" },
      allOf: { $ref: "#/$defs/schemaArray" },
      anyOf: { $ref: "#/$defs/schemaArray" },
      oneOf: { $ref: "#/$defs/schemaArray" },
      not: { $dynamicRef: "#meta" }
    },
    $defs: { schemaArray: {
      type: "array",
      minItems: 1,
      items: { $dynamicRef: "#meta" }
    } }
  };
});
var require_unevaluated = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/unevaluated",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/unevaluated": true },
    $dynamicAnchor: "meta",
    title: "Unevaluated applicator vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      unevaluatedItems: { $dynamicRef: "#meta" },
      unevaluatedProperties: { $dynamicRef: "#meta" }
    }
  };
});
var require_content = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/content",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/content": true },
    $dynamicAnchor: "meta",
    title: "Content vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      contentEncoding: { type: "string" },
      contentMediaType: { type: "string" },
      contentSchema: { $dynamicRef: "#meta" }
    }
  };
});
var require_core = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/core",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/core": true },
    $dynamicAnchor: "meta",
    title: "Core vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      $id: {
        $ref: "#/$defs/uriReferenceString",
        $comment: "Non-empty fragments not allowed.",
        pattern: "^[^#]*#?$"
      },
      $schema: { $ref: "#/$defs/uriString" },
      $ref: { $ref: "#/$defs/uriReferenceString" },
      $anchor: { $ref: "#/$defs/anchorString" },
      $dynamicRef: { $ref: "#/$defs/uriReferenceString" },
      $dynamicAnchor: { $ref: "#/$defs/anchorString" },
      $vocabulary: {
        type: "object",
        propertyNames: { $ref: "#/$defs/uriString" },
        additionalProperties: { type: "boolean" }
      },
      $comment: { type: "string" },
      $defs: {
        type: "object",
        additionalProperties: { $dynamicRef: "#meta" }
      }
    },
    $defs: {
      anchorString: {
        type: "string",
        pattern: "^[A-Za-z_][-A-Za-z0-9._]*$"
      },
      uriString: {
        type: "string",
        format: "uri"
      },
      uriReferenceString: {
        type: "string",
        format: "uri-reference"
      }
    }
  };
});
var require_format_annotation = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/format-annotation",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/format-annotation": true },
    $dynamicAnchor: "meta",
    title: "Format vocabulary meta-schema for annotation results",
    type: ["object", "boolean"],
    properties: { format: { type: "string" } }
  };
});
var require_meta_data = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/meta-data",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/meta-data": true },
    $dynamicAnchor: "meta",
    title: "Meta-data vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      default: true,
      deprecated: {
        type: "boolean",
        default: false
      },
      readOnly: {
        type: "boolean",
        default: false
      },
      writeOnly: {
        type: "boolean",
        default: false
      },
      examples: {
        type: "array",
        items: true
      }
    }
  };
});
var require_validation = /* @__PURE__ */ __commonJSMin((exports, module) => {
  module.exports = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://json-schema.org/draft/2020-12/meta/validation",
    $vocabulary: { "https://json-schema.org/draft/2020-12/vocab/validation": true },
    $dynamicAnchor: "meta",
    title: "Validation vocabulary meta-schema",
    type: ["object", "boolean"],
    properties: {
      type: { anyOf: [{ $ref: "#/$defs/simpleTypes" }, {
        type: "array",
        items: { $ref: "#/$defs/simpleTypes" },
        minItems: 1,
        uniqueItems: true
      }] },
      const: true,
      enum: {
        type: "array",
        items: true
      },
      multipleOf: {
        type: "number",
        exclusiveMinimum: 0
      },
      maximum: { type: "number" },
      exclusiveMaximum: { type: "number" },
      minimum: { type: "number" },
      exclusiveMinimum: { type: "number" },
      maxLength: { $ref: "#/$defs/nonNegativeInteger" },
      minLength: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
      pattern: {
        type: "string",
        format: "regex"
      },
      maxItems: { $ref: "#/$defs/nonNegativeInteger" },
      minItems: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
      uniqueItems: {
        type: "boolean",
        default: false
      },
      maxContains: { $ref: "#/$defs/nonNegativeInteger" },
      minContains: {
        $ref: "#/$defs/nonNegativeInteger",
        default: 1
      },
      maxProperties: { $ref: "#/$defs/nonNegativeInteger" },
      minProperties: { $ref: "#/$defs/nonNegativeIntegerDefault0" },
      required: { $ref: "#/$defs/stringArray" },
      dependentRequired: {
        type: "object",
        additionalProperties: { $ref: "#/$defs/stringArray" }
      }
    },
    $defs: {
      nonNegativeInteger: {
        type: "integer",
        minimum: 0
      },
      nonNegativeIntegerDefault0: {
        $ref: "#/$defs/nonNegativeInteger",
        default: 0
      },
      simpleTypes: { enum: [
        "array",
        "boolean",
        "integer",
        "null",
        "number",
        "object",
        "string"
      ] },
      stringArray: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        default: []
      }
    }
  };
});
var require_json_schema_2020_12 = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const metaSchema = require_schema();
  const applicator = require_applicator();
  const unevaluated = require_unevaluated();
  const content = require_content();
  const core = require_core();
  const format = require_format_annotation();
  const metadata = require_meta_data();
  const validation = require_validation();
  const META_SUPPORT_DATA = ["/properties"];
  function addMetaSchema2020($data) {
    [
      metaSchema,
      applicator,
      unevaluated,
      content,
      core,
      with$data(this, format),
      metadata,
      with$data(this, validation)
    ].forEach((sch) => this.addMetaSchema(sch, undefined, false));
    return this;
    function with$data(ajv, sch) {
      return $data ? ajv.$dataMetaSchema(sch, META_SUPPORT_DATA) : sch;
    }
  }
  exports.default = addMetaSchema2020;
});
var require__2020 = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.MissingRefError = exports.ValidationError = exports.CodeGen = exports.Name = exports.nil = exports.stringify = exports.str = exports._ = exports.KeywordCxt = exports.Ajv2020 = undefined;
  const core_1 = require_core$3();
  const draft2020_1 = require_draft2020();
  const discriminator_1 = require_discriminator();
  const json_schema_2020_12_1 = require_json_schema_2020_12();
  const META_SCHEMA_ID = "https://json-schema.org/draft/2020-12/schema";
  var Ajv2020 = class extends core_1.default {
    constructor(opts = {}) {
      super({
        ...opts,
        dynamicRef: true,
        next: true,
        unevaluated: true
      });
    }
    _addVocabularies() {
      super._addVocabularies();
      draft2020_1.default.forEach((v) => this.addVocabulary(v));
      if (this.opts.discriminator)
        this.addKeyword(discriminator_1.default);
    }
    _addDefaultMetaSchema() {
      super._addDefaultMetaSchema();
      const { $data, meta } = this.opts;
      if (!meta)
        return;
      json_schema_2020_12_1.default.call(this, $data);
      this.refs["http://json-schema.org/schema"] = META_SCHEMA_ID;
    }
    defaultMeta() {
      return this.opts.defaultMeta = super.defaultMeta() || (this.getSchema(META_SCHEMA_ID) ? META_SCHEMA_ID : undefined);
    }
  };
  exports.Ajv2020 = Ajv2020;
  module.exports = exports = Ajv2020;
  module.exports.Ajv2020 = Ajv2020;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = Ajv2020;
  var validate_1 = require_validate();
  Object.defineProperty(exports, "KeywordCxt", {
    enumerable: true,
    get: function() {
      return validate_1.KeywordCxt;
    }
  });
  var codegen_1 = require_codegen();
  Object.defineProperty(exports, "_", {
    enumerable: true,
    get: function() {
      return codegen_1._;
    }
  });
  Object.defineProperty(exports, "str", {
    enumerable: true,
    get: function() {
      return codegen_1.str;
    }
  });
  Object.defineProperty(exports, "stringify", {
    enumerable: true,
    get: function() {
      return codegen_1.stringify;
    }
  });
  Object.defineProperty(exports, "nil", {
    enumerable: true,
    get: function() {
      return codegen_1.nil;
    }
  });
  Object.defineProperty(exports, "Name", {
    enumerable: true,
    get: function() {
      return codegen_1.Name;
    }
  });
  Object.defineProperty(exports, "CodeGen", {
    enumerable: true,
    get: function() {
      return codegen_1.CodeGen;
    }
  });
  var validation_error_1 = require_validation_error();
  Object.defineProperty(exports, "ValidationError", {
    enumerable: true,
    get: function() {
      return validation_error_1.default;
    }
  });
  var ref_error_1 = require_ref_error();
  Object.defineProperty(exports, "MissingRefError", {
    enumerable: true,
    get: function() {
      return ref_error_1.default;
    }
  });
});
var require_formats = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.formatNames = exports.fastFormats = exports.fullFormats = undefined;
  function fmtDef(validate, compare) {
    return {
      validate,
      compare
    };
  }
  exports.fullFormats = {
    date: fmtDef(date, compareDate),
    time: fmtDef(getTime(true), compareTime),
    "date-time": fmtDef(getDateTime(true), compareDateTime),
    "iso-time": fmtDef(getTime(), compareIsoTime),
    "iso-date-time": fmtDef(getDateTime(), compareIsoDateTime),
    duration: /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/,
    uri,
    "uri-reference": /^(?:[a-z][a-z0-9+\-.]*:)?(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'"()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'"()*+,;=:@]|%[0-9a-f]{2})*)*)?(?:\?(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'"()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i,
    "uri-template": /^(?:(?:[^\x00-\x20"'<>%\\^`{|}]|%[0-9a-f]{2})|\{[+#./;?&=,!@|]?(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?(?:,(?:[a-z0-9_]|%[0-9a-f]{2})+(?::[1-9][0-9]{0,3}|\*)?)*\})*$/i,
    url: /^(?:https?|ftp):\/\/(?:\S+(?::\S*)?@)?(?:(?!(?:10|127)(?:\.\d{1,3}){3})(?!(?:169\.254|192\.168)(?:\.\d{1,3}){2})(?!172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)(?:\.(?:[a-z0-9\u{00a1}-\u{ffff}]+-)*[a-z0-9\u{00a1}-\u{ffff}]+)*(?:\.(?:[a-z\u{00a1}-\u{ffff}]{2,})))(?::\d{2,5})?(?:\/[^\s]*)?$/iu,
    email: /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i,
    hostname: /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i,
    ipv4: /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
    ipv6: /^((([0-9a-f]{1,4}:){7}([0-9a-f]{1,4}|:))|(([0-9a-f]{1,4}:){6}(:[0-9a-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){5}(((:[0-9a-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9a-f]{1,4}:){4}(((:[0-9a-f]{1,4}){1,3})|((:[0-9a-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){3}(((:[0-9a-f]{1,4}){1,4})|((:[0-9a-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){2}(((:[0-9a-f]{1,4}){1,5})|((:[0-9a-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9a-f]{1,4}:){1}(((:[0-9a-f]{1,4}){1,6})|((:[0-9a-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9a-f]{1,4}){1,7})|((:[0-9a-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))$/i,
    regex,
    uuid: /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
    "json-pointer": /^(?:\/(?:[^~/]|~0|~1)*)*$/,
    "json-pointer-uri-fragment": /^#(?:\/(?:[a-z0-9_\-.!$&'()*+,;:=@]|%[0-9a-f]{2}|~0|~1)*)*$/i,
    "relative-json-pointer": /^(?:0|[1-9][0-9]*)(?:#|(?:\/(?:[^~/]|~0|~1)*)*)$/,
    byte,
    int32: {
      type: "number",
      validate: validateInt32
    },
    int64: {
      type: "number",
      validate: validateInt64
    },
    float: {
      type: "number",
      validate: validateNumber
    },
    double: {
      type: "number",
      validate: validateNumber
    },
    password: true,
    binary: true
  };
  exports.fastFormats = {
    ...exports.fullFormats,
    date: fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d$/, compareDate),
    time: fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareTime),
    "date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i, compareDateTime),
    "iso-time": fmtDef(/^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoTime),
    "iso-date-time": fmtDef(/^\d\d\d\d-[0-1]\d-[0-3]\d[t\s](?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)?$/i, compareIsoDateTime),
    uri: /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i,
    "uri-reference": /^(?:(?:[a-z][a-z0-9+\-.]*:)?\/?\/)?(?:[^\\\s#][^\s#]*)?(?:#[^\\\s]*)?$/i,
    email: /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
  };
  exports.formatNames = Object.keys(exports.fullFormats);
  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }
  const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
  const DAYS = [
    0,
    31,
    28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  function date(str) {
    const matches = DATE.exec(str);
    if (!matches)
      return false;
    const year = +matches[1];
    const month = +matches[2];
    const day = +matches[3];
    return month >= 1 && month <= 12 && day >= 1 && day <= (month === 2 && isLeapYear(year) ? 29 : DAYS[month]);
  }
  function compareDate(d1, d2) {
    if (!(d1 && d2))
      return;
    if (d1 > d2)
      return 1;
    if (d1 < d2)
      return -1;
    return 0;
  }
  const TIME = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)?$/i;
  function getTime(strictTimeZone) {
    return function time(str) {
      const matches = TIME.exec(str);
      if (!matches)
        return false;
      const hr = +matches[1];
      const min = +matches[2];
      const sec = +matches[3];
      const tz = matches[4];
      const tzSign = matches[5] === "-" ? -1 : 1;
      const tzH = +(matches[6] || 0);
      const tzM = +(matches[7] || 0);
      if (tzH > 23 || tzM > 59 || strictTimeZone && !tz)
        return false;
      if (hr <= 23 && min <= 59 && sec < 60)
        return true;
      const utcMin = min - tzM * tzSign;
      const utcHr = hr - tzH * tzSign - (utcMin < 0 ? 1 : 0);
      return (utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61;
    };
  }
  function compareTime(s1, s2) {
    if (!(s1 && s2))
      return;
    const t1 = (/* @__PURE__ */ new Date("2020-01-01T" + s1)).valueOf();
    const t2 = (/* @__PURE__ */ new Date("2020-01-01T" + s2)).valueOf();
    if (!(t1 && t2))
      return;
    return t1 - t2;
  }
  function compareIsoTime(t1, t2) {
    if (!(t1 && t2))
      return;
    const a1 = TIME.exec(t1);
    const a2 = TIME.exec(t2);
    if (!(a1 && a2))
      return;
    t1 = a1[1] + a1[2] + a1[3];
    t2 = a2[1] + a2[2] + a2[3];
    if (t1 > t2)
      return 1;
    if (t1 < t2)
      return -1;
    return 0;
  }
  const DATE_TIME_SEPARATOR = /t|\s/i;
  function getDateTime(strictTimeZone) {
    const time = getTime(strictTimeZone);
    return function date_time(str) {
      const dateTime = str.split(DATE_TIME_SEPARATOR);
      return dateTime.length === 2 && date(dateTime[0]) && time(dateTime[1]);
    };
  }
  function compareDateTime(dt1, dt2) {
    if (!(dt1 && dt2))
      return;
    const d1 = new Date(dt1).valueOf();
    const d2 = new Date(dt2).valueOf();
    if (!(d1 && d2))
      return;
    return d1 - d2;
  }
  function compareIsoDateTime(dt1, dt2) {
    if (!(dt1 && dt2))
      return;
    const [d1, t1] = dt1.split(DATE_TIME_SEPARATOR);
    const [d2, t2] = dt2.split(DATE_TIME_SEPARATOR);
    const res = compareDate(d1, d2);
    if (res === undefined)
      return;
    return res || compareTime(t1, t2);
  }
  const NOT_URI_FRAGMENT = /\/|:/;
  const URI = /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:]|%[0-9a-f]{2})*@)?(?:\[(?:(?:(?:(?:[0-9a-f]{1,4}:){6}|::(?:[0-9a-f]{1,4}:){5}|(?:[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){4}|(?:(?:[0-9a-f]{1,4}:){0,1}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){3}|(?:(?:[0-9a-f]{1,4}:){0,2}[0-9a-f]{1,4})?::(?:[0-9a-f]{1,4}:){2}|(?:(?:[0-9a-f]{1,4}:){0,3}[0-9a-f]{1,4})?::[0-9a-f]{1,4}:|(?:(?:[0-9a-f]{1,4}:){0,4}[0-9a-f]{1,4})?::)(?:[0-9a-f]{1,4}:[0-9a-f]{1,4}|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?))|(?:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})?::[0-9a-f]{1,4}|(?:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})?::)|[Vv][0-9a-f]+\.[a-z0-9\-._~!$&'()*+,;=:]+)\]|(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)|(?:[a-z0-9\-._~!$&'()*+,;=]|%[0-9a-f]{2})*)(?::\d*)?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*|\/(?:(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)?|(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})+(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*)(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
  function uri(str) {
    return NOT_URI_FRAGMENT.test(str) && URI.test(str);
  }
  const BYTE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/gm;
  function byte(str) {
    BYTE.lastIndex = 0;
    return BYTE.test(str);
  }
  const MIN_INT32 = -(2 ** 31);
  const MAX_INT32 = 2 ** 31 - 1;
  function validateInt32(value) {
    return Number.isInteger(value) && value <= MAX_INT32 && value >= MIN_INT32;
  }
  function validateInt64(value) {
    return Number.isInteger(value);
  }
  function validateNumber() {
    return true;
  }
  const Z_ANCHOR = /[^\\]\\Z/;
  function regex(str) {
    if (Z_ANCHOR.test(str))
      return false;
    try {
      new RegExp(str);
      return true;
    } catch (e) {
      return false;
    }
  }
});
var require_limit = /* @__PURE__ */ __commonJSMin((exports) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.formatLimitDefinition = undefined;
  const ajv_1 = require_ajv();
  const codegen_1 = require_codegen();
  const ops = codegen_1.operators;
  const KWDs = {
    formatMaximum: {
      okStr: "<=",
      ok: ops.LTE,
      fail: ops.GT
    },
    formatMinimum: {
      okStr: ">=",
      ok: ops.GTE,
      fail: ops.LT
    },
    formatExclusiveMaximum: {
      okStr: "<",
      ok: ops.LT,
      fail: ops.GTE
    },
    formatExclusiveMinimum: {
      okStr: ">",
      ok: ops.GT,
      fail: ops.LTE
    }
  };
  const error = {
    message: ({ keyword, schemaCode }) => (0, codegen_1.str)`should be ${KWDs[keyword].okStr} ${schemaCode}`,
    params: ({ keyword, schemaCode }) => (0, codegen_1._)`{comparison: ${KWDs[keyword].okStr}, limit: ${schemaCode}}`
  };
  exports.formatLimitDefinition = {
    keyword: Object.keys(KWDs),
    type: "string",
    schemaType: "string",
    $data: true,
    error,
    code(cxt) {
      const { gen, data, schemaCode, keyword, it } = cxt;
      const { opts, self } = it;
      if (!opts.validateFormats)
        return;
      const fCxt = new ajv_1.KeywordCxt(it, self.RULES.all.format.definition, "format");
      if (fCxt.$data)
        validate$DataFormat();
      else
        validateFormat();
      function validate$DataFormat() {
        const fmts = gen.scopeValue("formats", {
          ref: self.formats,
          code: opts.code.formats
        });
        const fmt = gen.const("fmt", (0, codegen_1._)`${fmts}[${fCxt.schemaCode}]`);
        cxt.fail$data((0, codegen_1.or)((0, codegen_1._)`typeof ${fmt} != "object"`, (0, codegen_1._)`${fmt} instanceof RegExp`, (0, codegen_1._)`typeof ${fmt}.compare != "function"`, compareCode(fmt)));
      }
      function validateFormat() {
        const format = fCxt.schema;
        const fmtDef = self.formats[format];
        if (!fmtDef || fmtDef === true)
          return;
        if (typeof fmtDef != "object" || fmtDef instanceof RegExp || typeof fmtDef.compare != "function")
          throw new Error(`"${keyword}": format "${format}" does not define "compare" function`);
        const fmt = gen.scopeValue("formats", {
          key: format,
          ref: fmtDef,
          code: opts.code.formats ? (0, codegen_1._)`${opts.code.formats}${(0, codegen_1.getProperty)(format)}` : undefined
        });
        cxt.fail$data(compareCode(fmt));
      }
      function compareCode(fmt) {
        return (0, codegen_1._)`${fmt}.compare(${data}, ${schemaCode}) ${KWDs[keyword].fail} 0`;
      }
    },
    dependencies: ["format"]
  };
  const formatLimitPlugin = (ajv) => {
    ajv.addKeyword(exports.formatLimitDefinition);
    return ajv;
  };
  exports.default = formatLimitPlugin;
});
var require_dist = /* @__PURE__ */ __commonJSMin((exports, module) => {
  Object.defineProperty(exports, "__esModule", { value: true });
  const formats_1 = require_formats();
  const limit_1 = require_limit();
  const codegen_1 = require_codegen();
  const fullName = new codegen_1.Name("fullFormats");
  const fastName = new codegen_1.Name("fastFormats");
  const formatsPlugin = (ajv, opts = { keywords: true }) => {
    if (Array.isArray(opts)) {
      addFormats(ajv, opts, formats_1.fullFormats, fullName);
      return ajv;
    }
    const [formats, exportName] = opts.mode === "fast" ? [formats_1.fastFormats, fastName] : [formats_1.fullFormats, fullName];
    addFormats(ajv, opts.formats || formats_1.formatNames, formats, exportName);
    if (opts.keywords)
      (0, limit_1.default)(ajv);
    return ajv;
  };
  formatsPlugin.get = (name, mode = "full") => {
    const f = (mode === "fast" ? formats_1.fastFormats : formats_1.fullFormats)[name];
    if (!f)
      throw new Error(`Unknown format "${name}"`);
    return f;
  };
  function addFormats(ajv, list, fs, exportName) {
    var _a;
    var _b;
    (_a = (_b = ajv.opts.code).formats) !== null && _a !== undefined || (_b.formats = (0, codegen_1._)`require("ajv-formats/dist/formats").${exportName}`);
    for (const f of list)
      ajv.addFormat(f, fs[f]);
  }
  module.exports = exports = formatsPlugin;
  Object.defineProperty(exports, "__esModule", { value: true });
  exports.default = formatsPlugin;
});
var import_ajv = require_ajv();
var import__2019 = require__2019();
var import__2020 = require__2020();
var import_dist = /* @__PURE__ */ __toESM(require_dist(), 1);
var addFormats = import_dist.default;
function createDefaultAjvInstance(engineClass) {
  const ajv = new engineClass({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true
  });
  addFormats(ajv);
  return ajv;
}
var AjvJsonSchemaValidator = class {
  _ajv;
  _ajvDraft7;
  _ajv2019;
  _userAjv;
  constructor(ajv) {
    this._userAjv = ajv !== undefined;
    this._ajv = ajv;
  }
  get ajv() {
    return this._ajv ??= createDefaultAjvInstance(import__2020.Ajv2020);
  }
  _engineFor(schema) {
    if (this._userAjv)
      return this.ajv;
    const dialect = declaredDialect(schema, "pass a pre-configured Ajv instance to AjvJsonSchemaValidator(ajv) to validate other dialects.");
    if (dialect === "2020-12")
      return this.ajv;
    if (dialect === "2019-09")
      return this._ajv2019 ??= createDefaultAjvInstance(import__2019.Ajv2019);
    return this._ajvDraft7 ??= createDefaultAjvInstance(import_ajv.Ajv);
  }
  getValidator(schema) {
    const engine = this._engineFor(schema);
    const ajvValidator = "$id" in schema && typeof schema.$id === "string" ? engine.getSchema(schema.$id) ?? engine.compile(schema) : engine.compile(schema);
    return (input) => {
      return ajvValidator(input) ? {
        valid: true,
        data: input,
        errorMessage: undefined
      } : {
        valid: false,
        data: undefined,
        errorMessage: engine.errorsText(ajvValidator.errors)
      };
    };
  }
};
var Ajv = import_ajv.Ajv;

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/shimsNode.mjs
var CORS_IS_POSSIBLE = false;

// ../../node_modules/.bun/pkce-challenge@5.0.1/node_modules/pkce-challenge/dist/index.node.js
var crypto2;
crypto2 = globalThis.crypto?.webcrypto ?? globalThis.crypto ?? import("node:crypto").then((m) => m.webcrypto);
async function getRandomValues(size) {
  return (await crypto2).getRandomValues(new Uint8Array(size));
}
async function random(size) {
  const mask = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~";
  const evenDistCutoff = Math.pow(2, 8) - Math.pow(2, 8) % mask.length;
  let result = "";
  while (result.length < size) {
    const randomBytes = await getRandomValues(size - result.length);
    for (const randomByte of randomBytes) {
      if (randomByte < evenDistCutoff) {
        result += mask[randomByte % mask.length];
      }
    }
  }
  return result;
}
async function generateVerifier(length) {
  return await random(length);
}
async function generateChallenge(code_verifier) {
  const buffer = await (await crypto2).subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\//g, "_").replace(/\+/g, "-").replace(/=/g, "");
}
async function pkceChallenge(length) {
  if (!length)
    length = 43;
  if (length < 43 || length > 128) {
    throw `Expected a length between 43 and 128. Received ${length}.`;
  }
  const verifier = await generateVerifier(length);
  const challenge = await generateChallenge(verifier);
  return {
    code_verifier: verifier,
    code_challenge: challenge
  };
}

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/public-CvV4ZHkX.mjs
var OAuthClientFlowError = class extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.OAuthClientFlowError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  static isInstance(value) {
    if (typeof this !== "function")
      throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(message) {
    super(message);
    this.name = new.target.name;
    stampErrorBrands(this, new.target);
  }
};
var IssuerMismatchError = class extends OAuthClientFlowError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.IssuerMismatchError" });
  }
  kind;
  expected;
  received;
  constructor(kind, expected, received) {
    super(`Issuer mismatch in ${kind === "metadata" ? "authorization server metadata (RFC 8414 §3.3)" : "authorization response (RFC 9207)"}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`);
    this.kind = kind;
    this.expected = expected;
    this.received = received;
  }
};
var RegistrationRejectedError = class extends OAuthClientFlowError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.RegistrationRejectedError" });
  }
  status;
  body;
  submittedMetadata;
  constructor(args) {
    super(`Dynamic Client Registration rejected (HTTP ${args.status}): ${args.body}`);
    this.status = args.status;
    this.body = args.body;
    this.submittedMetadata = args.submittedMetadata;
  }
};
var InsecureTokenEndpointError = class extends OAuthClientFlowError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.InsecureTokenEndpointError" });
  }
  tokenEndpoint;
  constructor(tokenEndpoint) {
    super(`Refusing to send credentials to non-https token endpoint '${tokenEndpoint}'. OAuth token requests MUST use TLS (localhost / *.localhost / 127.0.0.1 / ::1 are exempt).`);
    this.tokenEndpoint = tokenEndpoint;
  }
};
var AuthorizationServerMismatchError = class extends OAuthClientFlowError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.AuthorizationServerMismatchError" });
  }
  constructor(recordedIssuer, currentIssuer) {
    super(`Authorization server mismatch: credentials are bound to ${JSON.stringify(recordedIssuer)} but this call resolved ${JSON.stringify(currentIssuer)}; refusing to present them to a different authorization server`);
    this.recordedIssuer = recordedIssuer;
    this.currentIssuer = currentIssuer;
  }
};
var InsufficientScopeError = class extends OAuthClientFlowError {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.InsufficientScopeError" });
  }
  requiredScope;
  resourceMetadataUrl;
  errorDescription;
  constructor(init) {
    super(`Insufficient scope${init.requiredScope ? `: required "${init.requiredScope}"` : ""}`);
    this.requiredScope = init.requiredScope;
    this.resourceMetadataUrl = init.resourceMetadataUrl;
    this.errorDescription = init.errorDescription;
  }
};
function discardIfIssuerMismatch(stored, issuer, opts) {
  if (!stored)
    return;
  if (typeof stored.issuer !== "string") {
    if (opts?.canPersistStamp !== false)
      console.warn("[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or provider not round-tripping the value). SEP-2352 isolation is inactive for this read; ensure your provider round-trips the issuer field.");
    return stored.issuer === undefined ? stored : {
      ...stored,
      issuer: undefined
    };
  }
  return issuersMatch(stored.issuer, issuer) ? stored : undefined;
}
function issuersMatch(a, b) {
  return a === b || a.endsWith("/") && a.slice(0, -1) === b || b.endsWith("/") && b.slice(0, -1) === a;
}
function isOAuthClientProvider(provider) {
  if (provider == null)
    return false;
  const p = provider;
  return typeof p.tokens === "function" && typeof p.clientInformation === "function";
}
async function handleOAuthUnauthorized(provider, ctx, extraAuthOptions) {
  const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
  if (await auth(provider, {
    serverUrl: ctx.serverUrl,
    resourceMetadataUrl,
    scope,
    fetchFn: ctx.fetchFn,
    ...extraAuthOptions
  }) !== "AUTHORIZED")
    throw new UnauthorizedError;
}
function adaptOAuthProvider(provider, extraAuthOptions) {
  return {
    token: async () => {
      return (await provider.tokens())?.access_token;
    },
    onUnauthorized: async (ctx) => handleOAuthUnauthorized(provider, ctx, extraAuthOptions)
  };
}
var UnauthorizedError = class extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.UnauthorizedError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  static isInstance(value) {
    if (typeof this !== "function")
      throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(message) {
    super(message ?? "Unauthorized");
    this.name = "UnauthorizedError";
    stampErrorBrands(this, new.target);
  }
};
function isIssParameterSupported(metadata) {
  return metadata?.authorization_response_iss_parameter_supported === true;
}
function validateAuthorizationResponseIssuer({ iss, expectedIssuer, issParameterSupported }) {
  if (expectedIssuer === undefined)
    return;
  if (iss === undefined) {
    if (issParameterSupported)
      throw new IssuerMismatchError("authorization_response", expectedIssuer, undefined);
    return;
  }
  if (iss !== expectedIssuer)
    throw new IssuerMismatchError("authorization_response", expectedIssuer, iss);
}
function computeScopeUnion(...scopes) {
  const seen = /* @__PURE__ */ new Set;
  for (const scope of scopes) {
    if (!scope)
      continue;
    for (const token of scope.split(/\s+/))
      if (token)
        seen.add(token);
  }
  return seen.size > 0 ? [...seen].join(" ") : undefined;
}
function isStrictScopeSuperset(union, current) {
  if (!union)
    return false;
  const currentSet = new Set((current ?? "").split(/\s+/).filter(Boolean));
  for (const token of union.split(/\s+/))
    if (token && !currentSet.has(token))
      return true;
  return false;
}
async function resolveAuthorizationCallbackParams(codeOrParams, iss, provider, serverUrl, opts) {
  if (typeof codeOrParams === "string")
    return {
      authorizationCode: codeOrParams,
      iss
    };
  const issParam = codeOrParams.get("iss") ?? undefined;
  const code = codeOrParams.get("code");
  if (code)
    return {
      authorizationCode: code,
      iss: issParam
    };
  let metadata = (await provider.discoveryState?.())?.authorizationServerMetadata;
  if (!metadata)
    try {
      metadata = (await discoverOAuthServerInfo(serverUrl, opts)).authorizationServerMetadata;
    } catch {
      metadata = undefined;
    }
  if (!metadata)
    throw new UnauthorizedError("Authorization callback failed and the issuer could not be verified");
  validateAuthorizationResponseIssuer({
    iss: issParam,
    expectedIssuer: metadata.issuer,
    issParameterSupported: isIssParameterSupported(metadata)
  });
  const error = codeOrParams.get("error");
  if (error)
    throw new OAuthError(error, codeOrParams.get("error_description") ?? error, codeOrParams.get("error_uri") ?? undefined);
  throw new UnauthorizedError("Authorization callback contained neither `code` nor `error`");
}
function isClientAuthMethod(method) {
  return [
    "client_secret_basic",
    "client_secret_post",
    "none"
  ].includes(method);
}
var AUTHORIZATION_CODE_RESPONSE_TYPE = "code";
var AUTHORIZATION_CODE_CHALLENGE_METHOD = "S256";
function selectClientAuthMethod(clientInformation, supportedMethods) {
  const hasClientSecret = clientInformation.client_secret !== undefined;
  if ("token_endpoint_auth_method" in clientInformation && clientInformation.token_endpoint_auth_method && isClientAuthMethod(clientInformation.token_endpoint_auth_method) && (supportedMethods.length === 0 || supportedMethods.includes(clientInformation.token_endpoint_auth_method)))
    return clientInformation.token_endpoint_auth_method;
  if (supportedMethods.length === 0)
    return hasClientSecret ? "client_secret_basic" : "none";
  if (hasClientSecret && supportedMethods.includes("client_secret_basic"))
    return "client_secret_basic";
  if (hasClientSecret && supportedMethods.includes("client_secret_post"))
    return "client_secret_post";
  if (supportedMethods.includes("none"))
    return "none";
  return hasClientSecret ? "client_secret_post" : "none";
}
function applyClientAuthentication(method, clientInformation, headers, params) {
  const { client_id, client_secret } = clientInformation;
  switch (method) {
    case "client_secret_basic":
      applyBasicAuth(client_id, client_secret, headers);
      return;
    case "client_secret_post":
      applyPostAuth(client_id, client_secret, params);
      return;
    case "none":
      applyPublicAuth(client_id, params);
      return;
    default:
      throw new Error(`Unsupported client authentication method: ${method}`);
  }
}
function applyBasicAuth(clientId, clientSecret, headers) {
  if (!clientSecret)
    throw new Error("client_secret_basic authentication requires a client_secret");
  const credentials = btoa(`${clientId}:${clientSecret}`);
  headers.set("Authorization", `Basic ${credentials}`);
}
function applyPostAuth(clientId, clientSecret, params) {
  params.set("client_id", clientId);
  if (clientSecret)
    params.set("client_secret", clientSecret);
}
function applyPublicAuth(clientId, params) {
  params.set("client_id", clientId);
}
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
function assertSecureTokenEndpoint(tokenEndpoint) {
  const url = new URL(String(tokenEndpoint));
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname))
    throw new InsecureTokenEndpointError(url.href);
  return url;
}
function deriveApplicationType(redirectUris) {
  for (const raw of redirectUris ?? []) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "native";
    if (isLoopbackHost(url.hostname))
      return "native";
  }
  return "web";
}
function resolveClientMetadata(provider) {
  const clientMetadata = provider.clientMetadata;
  return {
    ...clientMetadata,
    grant_types: clientMetadata.grant_types ?? (provider.redirectUrl === undefined ? undefined : ["authorization_code", "refresh_token"]),
    application_type: clientMetadata.application_type ?? deriveApplicationType(clientMetadata.redirect_uris)
  };
}
async function parseErrorResponse(input) {
  const statusCode = input instanceof Response ? input.status : undefined;
  const body = input instanceof Response ? await input.text() : input;
  try {
    const result = OAuthErrorResponseSchema.parse(JSON.parse(body));
    return OAuthError.fromResponse(result);
  } catch (error) {
    const errorMessage = `${statusCode ? `HTTP ${statusCode}: ` : ""}Invalid OAuth error response: ${error}. Raw body: ${body}`;
    return new OAuthError(OAuthErrorCode.ServerError, errorMessage);
  }
}
function warnCredentialInvalidation(provider, error, invalidated) {
  const action = provider.invalidateCredentials === undefined ? `retrying authorization without discarding the stored ${invalidated} (provider implements no invalidateCredentials())` : `invalidating the stored ${invalidated} and retrying authorization`;
  console.warn(`[mcp-sdk] OAuth ${JSON.stringify(error.code)} — ${action}. Cause: ${JSON.stringify(error.message)}`);
}
async function auth(provider, options) {
  try {
    return await authInternal(provider, options);
  } catch (error) {
    if (error instanceof OAuthError) {
      if (error.code === OAuthErrorCode.InvalidClient || error.code === OAuthErrorCode.UnauthorizedClient) {
        warnCredentialInvalidation(provider, error, "client credentials and tokens");
        await provider.invalidateCredentials?.("client");
        await provider.invalidateCredentials?.("tokens");
        return await authInternal(provider, options);
      } else if (error.code === OAuthErrorCode.InvalidGrant || error.code === OAuthErrorCode.InvalidDpopProof) {
        warnCredentialInvalidation(provider, error, "tokens");
        await provider.invalidateCredentials?.("tokens");
        return await authInternal(provider, options);
      }
    }
    throw error;
  }
}
function determineScope(options) {
  const { requestedScope, resourceMetadata, authServerMetadata, clientMetadata } = options;
  let effectiveScope = requestedScope || resourceMetadata?.scopes_supported?.join(" ") || clientMetadata.scope;
  if (effectiveScope && authServerMetadata?.scopes_supported?.includes("offline_access") && !effectiveScope.split(" ").includes("offline_access") && clientMetadata.grant_types?.includes("refresh_token"))
    effectiveScope = `${effectiveScope} offline_access`;
  return effectiveScope;
}
async function authInternal(provider, { serverUrl, authorizationCode, iss, scope, resourceMetadataUrl, fetchFn, skipIssuerMetadataValidation, forceReauthorization }) {
  const clientMetadata = resolveClientMetadata(provider);
  const cachedState = await provider.discoveryState?.();
  let resourceMetadata;
  let authorizationServerUrl;
  let metadata;
  let freshDiscoveryState;
  let effectiveResourceMetadataUrl = resourceMetadataUrl;
  if (!effectiveResourceMetadataUrl && cachedState?.resourceMetadataUrl)
    effectiveResourceMetadataUrl = new URL(cachedState.resourceMetadataUrl);
  if (cachedState?.authorizationServerUrl) {
    authorizationServerUrl = cachedState.authorizationServerUrl;
    resourceMetadata = cachedState.resourceMetadata;
    metadata = cachedState.authorizationServerMetadata ?? await discoverAuthorizationServerMetadata(authorizationServerUrl, {
      fetchFn,
      skipIssuerValidation: skipIssuerMetadataValidation
    });
    if (!resourceMetadata)
      try {
        resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: effectiveResourceMetadataUrl }, fetchFn);
      } catch (error) {
        if (error instanceof TypeError)
          throw error;
      }
    if (metadata !== cachedState.authorizationServerMetadata || resourceMetadata !== cachedState.resourceMetadata)
      await provider.saveDiscoveryState?.({
        authorizationServerUrl: String(authorizationServerUrl),
        resourceMetadataUrl: effectiveResourceMetadataUrl?.toString(),
        resourceMetadata,
        authorizationServerMetadata: metadata
      });
  } else {
    const serverInfo = await discoverOAuthServerInfo(serverUrl, {
      resourceMetadataUrl: effectiveResourceMetadataUrl,
      fetchFn,
      skipIssuerMetadataValidation
    });
    authorizationServerUrl = serverInfo.authorizationServerUrl;
    metadata = serverInfo.authorizationServerMetadata;
    resourceMetadata = serverInfo.resourceMetadata;
    freshDiscoveryState = {
      authorizationServerUrl: String(authorizationServerUrl),
      resourceMetadataUrl: effectiveResourceMetadataUrl?.toString(),
      resourceMetadata,
      authorizationServerMetadata: metadata
    };
  }
  const issuer = metadata?.issuer ?? String(authorizationServerUrl);
  const infoCtx = { issuer };
  await provider.saveAuthorizationServerUrl?.(issuer);
  if (authorizationCode !== undefined) {
    const recordedIssuer = cachedState?.authorizationServerMetadata?.issuer ?? cachedState?.authorizationServerUrl;
    if (recordedIssuer === undefined) {
      if (provider.saveDiscoveryState !== undefined)
        throw new AuthorizationServerMismatchError("discoveryState was not available on the callback leg; ensure your provider persists discoveryState alongside codeVerifier", issuer);
      console.warn("[mcp-sdk] OAuthClientProvider does not implement saveDiscoveryState()/discoveryState(); the SEP-2352 callback-leg authorization-server binding cannot be checked. Implement discoveryState (persist alongside codeVerifier) — see docs/migration/upgrade-to-v2.md §SEP-2352.");
    } else if (!issuersMatch(recordedIssuer, issuer))
      throw new AuthorizationServerMismatchError(recordedIssuer, issuer);
  }
  if (freshDiscoveryState)
    await provider.saveDiscoveryState?.(freshDiscoveryState);
  const selectedResource = await selectResourceURL(serverUrl, provider, resourceMetadata);
  const resource = selectedResource && resourceMetadata && !provider.validateResourceURL ? resourceMetadata.resource : selectedResource;
  if (resource)
    await provider.saveResourceUrl?.(resourceIndicatorToString(resource));
  const resolvedScope = determineScope({
    requestedScope: scope,
    resourceMetadata,
    authServerMetadata: metadata,
    clientMetadata: provider.clientMetadata
  });
  const rawClientInfo = await Promise.resolve(provider.clientInformation(infoCtx));
  let clientInformation = discardIfIssuerMismatch(rawClientInfo, issuer, { canPersistStamp: provider.saveClientInformation !== undefined });
  if (clientInformation === undefined && rawClientInfo?.issuer && provider.saveClientInformation === undefined)
    throw new AuthorizationServerMismatchError(rawClientInfo.issuer, issuer);
  if (clientInformation && clientInformation.issuer === undefined) {
    clientInformation = {
      ...clientInformation,
      issuer
    };
    await provider.saveClientInformation?.(clientInformation, infoCtx);
  }
  if (!clientInformation) {
    if (authorizationCode !== undefined)
      throw new Error("Existing OAuth client information is required when exchanging an authorization code");
    const supportsUrlBasedClientId = metadata?.client_id_metadata_document_supported === true;
    const clientMetadataUrl = provider.clientMetadataUrl;
    if (clientMetadataUrl && !isHttpsUrl(clientMetadataUrl))
      throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, `clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: ${clientMetadataUrl}`);
    if (supportsUrlBasedClientId && clientMetadataUrl) {
      clientInformation = {
        client_id: clientMetadataUrl,
        issuer
      };
      await provider.saveClientInformation?.(clientInformation, infoCtx);
    } else {
      if (!provider.saveClientInformation)
        throw new Error("OAuth client information must be saveable for dynamic registration");
      clientInformation = {
        ...await registerClient(authorizationServerUrl, {
          metadata,
          clientMetadata,
          scope: resolvedScope,
          fetchFn
        }),
        issuer
      };
      await provider.saveClientInformation(clientInformation, infoCtx);
    }
  }
  const nonInteractiveFlow = !provider.redirectUrl;
  if (authorizationCode !== undefined || nonInteractiveFlow) {
    if (authorizationCode !== undefined)
      validateAuthorizationResponseIssuer({
        iss,
        expectedIssuer: metadata?.issuer,
        issParameterSupported: isIssParameterSupported(metadata)
      });
    const tokens$1 = await fetchToken(provider, authorizationServerUrl, {
      metadata,
      resource,
      authorizationCode,
      iss,
      scope: resolvedScope,
      fetchFn
    });
    await provider.saveTokens({
      ...tokens$1,
      issuer
    }, infoCtx);
    return "AUTHORIZED";
  }
  let tokens = discardIfIssuerMismatch(await provider.tokens(infoCtx), issuer);
  if (tokens && tokens.issuer === undefined) {
    tokens = {
      ...tokens,
      issuer
    };
    await provider.saveTokens(tokens, infoCtx);
  }
  if (tokens?.refresh_token && !forceReauthorization) {
    const refreshScope = await provider.scopeForRefresh?.(tokens);
    let newTokens;
    try {
      newTokens = await refreshAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation,
        refreshToken: tokens.refresh_token,
        scope: refreshScope,
        resource,
        addClientAuthentication: provider.addClientAuthentication,
        dpop: await provider.dpop?.(),
        fetchFn
      });
    } catch (error) {
      if (error instanceof InsecureTokenEndpointError)
        throw error;
      if (!(error instanceof OAuthError) || error.code === OAuthErrorCode.ServerError)
        console.warn(`[mcp-sdk] Could not refresh OAuth tokens; falling back to a new authorization request. Cause: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`);
      else
        throw error;
    }
    if (newTokens) {
      await provider.saveTokens({
        ...newTokens,
        issuer
      }, infoCtx);
      return "AUTHORIZED";
    }
  }
  const state = provider.state ? await provider.state() : undefined;
  const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
    metadata,
    clientInformation,
    state,
    redirectUrl: provider.redirectUrl,
    scope: resolvedScope,
    resource
  });
  await provider.saveCodeVerifier(codeVerifier);
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT";
}
function isHttpsUrl(value) {
  if (!value)
    return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
  }
}
async function selectResourceURL(serverUrl, provider, resourceMetadata) {
  const defaultResource = resourceUrlFromServerUrl(serverUrl);
  if (provider.validateResourceURL)
    return await provider.validateResourceURL(defaultResource, resourceMetadata?.resource);
  if (!resourceMetadata)
    return;
  if (!checkResourceAllowed({
    requestedResource: defaultResource,
    configuredResource: resourceMetadata.resource
  }))
    throw new Error(`Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`);
  return new URL(resourceMetadata.resource);
}
var RECOGNIZED_CHALLENGE_SCHEMES = new Set(["bearer", "dpop"]);
function extractWWWAuthenticateParams(res) {
  const authenticateHeader = res.headers.get("WWW-Authenticate");
  if (!authenticateHeader)
    return {};
  const [type, scheme] = authenticateHeader.split(" ");
  if (!type || !RECOGNIZED_CHALLENGE_SCHEMES.has(type.toLowerCase()) || !scheme)
    return {};
  const resourceMetadataMatch = extractFieldFromWwwAuth(res, "resource_metadata") || undefined;
  let resourceMetadataUrl;
  if (resourceMetadataMatch)
    try {
      resourceMetadataUrl = new URL(resourceMetadataMatch);
    } catch {}
  const scope = extractFieldFromWwwAuth(res, "scope") || undefined;
  const error = extractFieldFromWwwAuth(res, "error") || undefined;
  const errorDescription = extractFieldFromWwwAuth(res, "error_description") || undefined;
  return {
    resourceMetadataUrl,
    scope,
    error,
    errorDescription
  };
}
function extractFieldFromWwwAuth(response, fieldName) {
  const wwwAuthHeader = response.headers.get("WWW-Authenticate");
  if (!wwwAuthHeader)
    return null;
  const pattern = new RegExp(String.raw`${fieldName}=(?:"([^"]+)"|([^\s,]+))`);
  const match = wwwAuthHeader.match(pattern);
  if (match) {
    const result = match[1] || match[2];
    if (result)
      return result;
  }
  return null;
}
async function discoverOAuthProtectedResourceMetadata(serverUrl, opts, fetchFn = fetch) {
  const response = await discoverMetadataWithFallback(serverUrl, "oauth-protected-resource", fetchFn, {
    protocolVersion: opts?.protocolVersion,
    metadataUrl: opts?.resourceMetadataUrl
  });
  if (!response || response.status === 404) {
    await response?.text?.().catch(() => {});
    throw new Error(`Resource server does not implement OAuth 2.0 Protected Resource Metadata.`);
  }
  if (!response.ok) {
    await response.text?.().catch(() => {});
    throw new Error(`HTTP ${response.status} trying to load well-known OAuth protected resource metadata.`);
  }
  return OAuthProtectedResourceMetadataSchema.parse(await response.json());
}
async function fetchWithCorsRetry(url, headers, fetchFn = fetch) {
  const withinOrigin = fetchWithinOrigin(fetchFn);
  try {
    return await withinOrigin(url, { headers });
  } catch (error) {
    if (!(error instanceof TypeError) || !CORS_IS_POSSIBLE)
      throw error;
    if (headers)
      try {
        return await withinOrigin(url, {});
      } catch (retryError) {
        if (!(retryError instanceof TypeError))
          throw retryError;
        return;
      }
    return;
  }
}
function buildWellKnownPath(wellKnownPrefix, pathname = "", options = {}) {
  if (pathname.endsWith("/"))
    pathname = pathname.slice(0, -1);
  return options.prependPathname ? `${pathname}/.well-known/${wellKnownPrefix}` : `/.well-known/${wellKnownPrefix}${pathname}`;
}
async function tryMetadataDiscovery(url, protocolVersion, fetchFn = fetch) {
  return await fetchWithCorsRetry(url, { "MCP-Protocol-Version": protocolVersion }, fetchFn);
}
function shouldAttemptFallback(response, pathname) {
  if (!response)
    return true;
  if (pathname === "/")
    return false;
  return !response.ok && response.status < 500 || response.status === 502;
}
async function discoverMetadataWithFallback(serverUrl, wellKnownType, fetchFn, opts) {
  const issuer = new URL(serverUrl);
  const protocolVersion = opts?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
  let url;
  if (opts?.metadataUrl)
    url = new URL(opts.metadataUrl);
  else {
    const wellKnownPath = buildWellKnownPath(wellKnownType, issuer.pathname);
    url = new URL(wellKnownPath, opts?.metadataServerUrl ?? issuer);
    url.search = issuer.search;
  }
  let response = await tryMetadataDiscovery(url, protocolVersion, fetchFn);
  if (!opts?.metadataUrl && shouldAttemptFallback(response, issuer.pathname))
    response = await tryMetadataDiscovery(new URL(`/.well-known/${wellKnownType}`, issuer), protocolVersion, fetchFn);
  return response;
}
function buildDiscoveryUrls(authorizationServerUrl) {
  const url = typeof authorizationServerUrl === "string" ? new URL(authorizationServerUrl) : authorizationServerUrl;
  const hasPath = url.pathname !== "/";
  const urlsToTry = [];
  if (!hasPath) {
    urlsToTry.push({
      url: new URL("/.well-known/oauth-authorization-server", url.origin),
      type: "oauth"
    }, {
      url: new URL(`/.well-known/openid-configuration`, url.origin),
      type: "oidc"
    });
    return urlsToTry;
  }
  let pathname = url.pathname;
  if (pathname.endsWith("/"))
    pathname = pathname.slice(0, -1);
  urlsToTry.push({
    url: new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin),
    type: "oauth"
  }, {
    url: new URL(`/.well-known/openid-configuration${pathname}`, url.origin),
    type: "oidc"
  }, {
    url: new URL(`${pathname}/.well-known/openid-configuration`, url.origin),
    type: "oidc"
  });
  return urlsToTry;
}
async function discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn = fetch, protocolVersion = LATEST_PROTOCOL_VERSION, skipIssuerValidation = false } = {}) {
  const headers = {
    "MCP-Protocol-Version": protocolVersion,
    Accept: "application/json"
  };
  const urlsToTry = buildDiscoveryUrls(authorizationServerUrl);
  for (const { url: endpointUrl, type } of urlsToTry) {
    const response = await fetchWithCorsRetry(endpointUrl, headers, fetchFn);
    if (!response)
      continue;
    if (!response.ok) {
      await response.text?.().catch(() => {});
      if (response.status < 500 || response.status === 502)
        continue;
      throw new Error(`HTTP ${response.status} trying to load ${type === "oauth" ? "OAuth" : "OpenID provider"} metadata from ${endpointUrl}`);
    }
    const parsed = type === "oauth" ? OAuthMetadataSchema.parse(await response.json()) : OpenIdProviderDiscoveryMetadataSchema.parse(await response.json());
    if (!skipIssuerValidation) {
      const expectedIssuer = typeof authorizationServerUrl === "string" ? authorizationServerUrl : authorizationServerUrl.href;
      if (!(parsed.issuer === expectedIssuer || expectedIssuer.endsWith("/") && parsed.issuer === expectedIssuer.slice(0, -1)))
        throw new IssuerMismatchError("metadata", expectedIssuer, parsed.issuer);
    }
    return parsed;
  }
}
async function discoverOAuthServerInfo(serverUrl, opts) {
  let resourceMetadata;
  let authorizationServerUrl;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(serverUrl, { resourceMetadataUrl: opts?.resourceMetadataUrl }, opts?.fetchFn);
    if (resourceMetadata.authorization_servers && resourceMetadata.authorization_servers.length > 0)
      authorizationServerUrl = resourceMetadata.authorization_servers[0];
  } catch (error) {
    if (error instanceof TypeError)
      throw error;
  }
  if (!authorizationServerUrl)
    authorizationServerUrl = String(new URL("/", serverUrl));
  const authorizationServerMetadata = await discoverAuthorizationServerMetadata(authorizationServerUrl, {
    fetchFn: opts?.fetchFn,
    skipIssuerValidation: opts?.skipIssuerMetadataValidation
  });
  return {
    authorizationServerUrl,
    authorizationServerMetadata,
    resourceMetadata
  };
}
function resourceIndicatorToString(resource) {
  return typeof resource === "string" ? resource : resource.href;
}
async function startAuthorization(authorizationServerUrl, { metadata, clientInformation, redirectUrl, scope, state, resource }) {
  let authorizationUrl;
  if (metadata) {
    authorizationUrl = new URL(metadata.authorization_endpoint);
    if (!metadata.response_types_supported.includes(AUTHORIZATION_CODE_RESPONSE_TYPE))
      throw new Error(`Incompatible auth server: does not support response type ${AUTHORIZATION_CODE_RESPONSE_TYPE}`);
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes(AUTHORIZATION_CODE_CHALLENGE_METHOD))
      throw new Error(`Incompatible auth server: does not support code challenge method ${AUTHORIZATION_CODE_CHALLENGE_METHOD}`);
  } else
    authorizationUrl = new URL("/authorize", authorizationServerUrl);
  const challenge = await pkceChallenge();
  const codeVerifier = challenge.code_verifier;
  const codeChallenge = challenge.code_challenge;
  authorizationUrl.searchParams.set("response_type", AUTHORIZATION_CODE_RESPONSE_TYPE);
  authorizationUrl.searchParams.set("client_id", clientInformation.client_id);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", AUTHORIZATION_CODE_CHALLENGE_METHOD);
  authorizationUrl.searchParams.set("redirect_uri", String(redirectUrl));
  if (state)
    authorizationUrl.searchParams.set("state", state);
  if (scope)
    authorizationUrl.searchParams.set("scope", scope);
  if (scope?.split(" ").includes("offline_access"))
    authorizationUrl.searchParams.append("prompt", "consent");
  if (resource)
    authorizationUrl.searchParams.set("resource", resourceIndicatorToString(resource));
  return {
    authorizationUrl,
    codeVerifier
  };
}
function prepareAuthorizationCodeRequest(authorizationCode, codeVerifier, redirectUri) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: String(redirectUri)
  });
}
async function executeTokenRequest(authorizationServerUrl, { metadata, tokenRequestParams, clientInformation, addClientAuthentication, resource, dpop, fetchFn }) {
  const tokenUrl = assertSecureTokenEndpoint(metadata?.token_endpoint ?? new URL("/token", authorizationServerUrl));
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json"
  });
  if (resource)
    tokenRequestParams.set("resource", resourceIndicatorToString(resource));
  if (!addClientAuthentication && clientInformation)
    applyClientAuthentication(selectClientAuthMethod(clientInformation, metadata?.token_endpoint_auth_methods_supported ?? []), clientInformation, headers, tokenRequestParams);
  const requestOnce = async () => {
    const requestHeaders = new Headers(headers);
    if (addClientAuthentication)
      await addClientAuthentication(requestHeaders, tokenRequestParams, tokenUrl, metadata);
    if (dpop)
      requestHeaders.set("DPoP", await dpop.buildProof({
        htm: "POST",
        htu: tokenUrl
      }));
    return fetchWithinOrigin(fetchFn ?? fetch)(tokenUrl, {
      method: "POST",
      headers: requestHeaders,
      body: tokenRequestParams
    });
  };
  let response = await requestOnce();
  if (dpop && response.status === 400) {
    if ((await response.clone().json().catch(() => {}))?.error === OAuthErrorCode.UseDpopNonce) {
      dpop.observeNonce(response, tokenUrl);
      response = await requestOnce();
    }
  }
  dpop?.observeNonce(response, tokenUrl);
  if (!response.ok)
    throw await parseErrorResponse(response);
  const json = await response.json();
  try {
    return OAuthTokensSchema.parse(withoutIssuer(json));
  } catch (parseError) {
    if (typeof json === "object" && json !== null && "error" in json)
      throw await parseErrorResponse(JSON.stringify(json));
    throw parseError;
  }
}
async function refreshAuthorization(authorizationServerUrl, { metadata, clientInformation, refreshToken, scope, resource, addClientAuthentication, dpop, fetchFn }) {
  const tokenRequestParams = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  if (scope)
    tokenRequestParams.set("scope", scope);
  const tokens = await executeTokenRequest(authorizationServerUrl, {
    metadata,
    tokenRequestParams,
    clientInformation,
    addClientAuthentication,
    resource,
    dpop,
    fetchFn
  });
  return {
    refresh_token: refreshToken,
    ...tokens,
    ...scope && !tokens.scope && { scope }
  };
}
async function fetchToken(provider, authorizationServerUrl, { metadata, resource, authorizationCode, iss, scope, fetchFn } = {}) {
  if (authorizationCode !== undefined)
    validateAuthorizationResponseIssuer({
      iss,
      expectedIssuer: metadata?.issuer,
      issParameterSupported: isIssParameterSupported(metadata)
    });
  const issuer = metadata?.issuer ?? String(authorizationServerUrl);
  const readClientInformation = async () => {
    const rawClientInfo = await provider.clientInformation({ issuer });
    const checked = discardIfIssuerMismatch(rawClientInfo, issuer, { canPersistStamp: false });
    if (rawClientInfo && checked === undefined)
      throw new AuthorizationServerMismatchError(String(rawClientInfo.issuer), issuer);
    return checked;
  };
  let clientInformation = await readClientInformation();
  const effectiveScope = scope ?? provider.clientMetadata.scope;
  let tokenRequestParams;
  if (provider.prepareTokenRequest)
    tokenRequestParams = await provider.prepareTokenRequest(effectiveScope);
  if (!tokenRequestParams) {
    if (!authorizationCode)
      throw new Error("Either provider.prepareTokenRequest() or authorizationCode is required");
    if (!provider.redirectUrl)
      throw new Error("redirectUrl is required for authorization_code flow");
    tokenRequestParams = prepareAuthorizationCodeRequest(authorizationCode, await provider.codeVerifier(), provider.redirectUrl);
  }
  clientInformation ??= await readClientInformation();
  return executeTokenRequest(authorizationServerUrl, {
    metadata,
    tokenRequestParams,
    clientInformation,
    addClientAuthentication: provider.addClientAuthentication,
    resource,
    dpop: await provider.dpop?.(),
    fetchFn
  });
}
async function registerClient(authorizationServerUrl, { metadata, clientMetadata, scope, fetchFn }) {
  let registrationUrl;
  if (metadata) {
    if (!metadata.registration_endpoint)
      throw new Error("Incompatible auth server: does not support dynamic client registration");
    registrationUrl = new URL(metadata.registration_endpoint);
  } else
    registrationUrl = new URL("/register", authorizationServerUrl);
  const submittedMetadata = {
    ...clientMetadata,
    ...scope === undefined ? {} : { scope }
  };
  const response = await fetchWithinOrigin(fetchFn ?? fetch)(registrationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submittedMetadata)
  });
  if (!response.ok)
    throw new RegistrationRejectedError({
      status: response.status,
      body: await response.text(),
      submittedMetadata
    });
  return OAuthClientInformationFullSchema.parse(withoutIssuer(await response.json()));
}
var CAP_EXEMPT_METHODS = new Set([
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "server/discover"
]);
var InMemoryResponseCacheStore = class {
  _entries = /* @__PURE__ */ new Map;
  _maxEntries;
  _stamp = 0;
  _cappedSize = 0;
  constructor(options) {
    this._maxEntries = options?.maxEntries ?? 512;
  }
  get size() {
    return this._entries.size;
  }
  get(key) {
    return this._entries.get(keyOf(key));
  }
  set(key, entry) {
    const k = keyOf(key);
    const exempt = CAP_EXEMPT_METHODS.has(key.method);
    const isNew = !this._entries.has(k);
    if (!exempt && isNew && this._maxEntries > 0 && this._cappedSize >= this._maxEntries) {
      for (const oldKey of this._entries.keys())
        if (!CAP_EXEMPT_METHODS.has(oldKey.slice(0, oldKey.indexOf("\x00")))) {
          this._entries.delete(oldKey);
          this._cappedSize--;
          break;
        }
    }
    const stamp = ++this._stamp;
    this._entries.set(k, {
      ...entry,
      stamp
    });
    if (isNew && !exempt)
      this._cappedSize++;
    return stamp;
  }
  delete(key) {
    if (this._entries.delete(keyOf(key)) && !CAP_EXEMPT_METHODS.has(key.method))
      this._cappedSize--;
  }
  evict(method) {
    const prefix = `${method}\x00`;
    const exempt = CAP_EXEMPT_METHODS.has(method);
    for (const k of this._entries.keys())
      if (k.startsWith(prefix)) {
        this._entries.delete(k);
        if (!exempt)
          this._cappedSize--;
      }
  }
  clear() {
    this._entries.clear();
    this._cappedSize = 0;
  }
};
function keyOf(key) {
  return `${key.method}\x00${JSON.stringify([key.partition ?? "", key.params ?? ""])}`;
}
function genKey(method, params) {
  return params === undefined ? method : `${method}\x00${params}`;
}
var MAX_CACHE_TTL_MS = 86400000;
var ClientResponseCache = class {
  _evictionGeneration = /* @__PURE__ */ new Map;
  _toolIndex;
  _toolOutputValidatorIndex;
  _serverIdentity = "";
  constructor(_store, _isUserSupplied, _reportError = () => {}, _cachePartition = "", _now = Date.now) {
    this._store = _store;
    this._isUserSupplied = _isUserSupplied;
    this._reportError = _reportError;
    this._cachePartition = _cachePartition;
    this._now = _now;
  }
  now() {
    return this._now();
  }
  setServerIdentity(identity) {
    this._serverIdentity = identity;
  }
  _partitionFor(scope) {
    return JSON.stringify([this._serverIdentity, scope === "public" ? "" : this._cachePartition]);
  }
  async _probe(method, params) {
    const key = {
      method,
      params: params ?? ""
    };
    const ownPartition = this._partitionFor("private");
    const own = await this._store.get({
      ...key,
      partition: ownPartition
    });
    if (own !== undefined)
      return own;
    const sharedPartition = this._partitionFor("public");
    if (sharedPartition === ownPartition)
      return;
    const shared = await this._store.get({
      ...key,
      partition: sharedPartition
    });
    return shared?.scope === "public" ? shared : undefined;
  }
  async evict(method) {
    this._evictionGeneration.set(method, (this._evictionGeneration.get(method) ?? 0) + 1);
    await this._deleteBoth(method, "");
  }
  async _deleteBoth(method, params) {
    const ownPartition = this._partitionFor("private");
    const sharedPartition = this._partitionFor("public");
    try {
      await this._store.delete({
        method,
        params,
        partition: ownPartition
      });
    } catch (error) {
      this._reportError(error);
    }
    if (sharedPartition !== ownPartition)
      try {
        await this._store.delete({
          method,
          params,
          partition: sharedPartition
        });
      } catch (error) {
        this._reportError(error);
      }
  }
  async evictKey(method, params) {
    const gk = genKey(method, params);
    const current = this._evictionGeneration.get(gk);
    if (current !== undefined)
      this._evictionGeneration.set(gk, current + 1);
    await this._deleteBoth(method, params);
  }
  captureGeneration(method, params) {
    const gk = genKey(method, params);
    const current = this._evictionGeneration.get(gk) ?? 0;
    this._evictionGeneration.set(gk, current);
    return current;
  }
  async write(method, value, capturedGen, freshness) {
    if ((this._evictionGeneration.get(genKey(method, freshness?.params)) ?? 0) !== capturedGen)
      return;
    const params = freshness?.params ?? "";
    const ownPartition = this._partitionFor("private");
    const sharedPartition = this._partitionFor("public");
    const partition = (freshness?.scope ?? "private") === "public" ? sharedPartition : ownPartition;
    try {
      await this._store.set({
        method,
        params,
        partition
      }, {
        value: encodeCacheValue(value),
        expiresAt: freshness?.expiresAt,
        scope: freshness?.scope
      });
    } catch (error) {
      this._reportError(error);
    }
    if (sharedPartition !== ownPartition)
      try {
        await this._store.delete({
          method,
          params,
          partition: partition === ownPartition ? sharedPartition : ownPartition
        });
      } catch (error) {
        this._reportError(error);
      }
  }
  async read(method, params) {
    const entry = await this._probe(method, params);
    if (entry?.expiresAt === undefined || !(entry.expiresAt > this.now()))
      return;
    try {
      const parsed = JSON.parse(entry.value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new TypeError("cached document is not an object");
      return { value: parsed };
    } catch (error) {
      this._reportError(error);
      await this._deleteBoth(method, params ?? "");
      return;
    }
  }
  resetForReconnect() {
    if (!this._isUserSupplied)
      this._store.clear();
    this._evictionGeneration.clear();
    this._toolIndex = undefined;
    this._toolOutputValidatorIndex = undefined;
    this._serverIdentity = "";
  }
  async toolDefinition(name) {
    const entry = await this._probe("tools/list");
    if (entry === undefined) {
      this._toolIndex = undefined;
      return;
    }
    if (this._toolIndex?.stamp !== entry.stamp) {
      const list = this._decodeListTools(entry);
      const byName = /* @__PURE__ */ new Map;
      if (list !== undefined)
        for (const tool of list.tools)
          byName.set(tool.name, tool);
      this._toolIndex = {
        stamp: entry.stamp,
        byName
      };
    }
    return this._toolIndex.byName.get(name);
  }
  async outputValidator(name, compile) {
    const entry = await this._probe("tools/list");
    if (entry === undefined) {
      this._toolOutputValidatorIndex = undefined;
      return;
    }
    if (this._toolOutputValidatorIndex?.stamp !== entry.stamp) {
      const list = this._decodeListTools(entry) ?? { tools: [] };
      const byName = /* @__PURE__ */ new Map;
      for (const tool of list.tools) {
        const compiled = compile(tool);
        if (compiled !== undefined)
          byName.set(tool.name, compiled);
      }
      this._toolOutputValidatorIndex = {
        stamp: entry.stamp,
        byName
      };
    }
    return this._toolOutputValidatorIndex.byName.get(name);
  }
  _decodeListTools(entry) {
    try {
      const parsed = JSON.parse(entry.value);
      if (!Array.isArray(parsed?.tools) || !parsed.tools.every((t) => t !== null && typeof t === "object"))
        throw new TypeError("cached tools/list document has a malformed tools array");
      return parsed;
    } catch (error) {
      this._reportError(error);
      return;
    }
  }
};
function encodeCacheValue(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`cache value is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof json !== "string")
    throw new TypeError("cache value is not JSON-serializable: it has no JSON representation");
  return json;
}
var AUTH_SEAM = Symbol.for("mcp.authSeamEscape");
function markAuthSeamEscape(error) {
  if (typeof error === "object" && error !== null || typeof error === "function")
    try {
      Object.defineProperty(error, AUTH_SEAM, {
        value: true,
        configurable: true
      });
    } catch {}
  return error;
}
function isAuthSeamEscape(error) {
  return (typeof error === "object" && error !== null || typeof error === "function") && error[AUTH_SEAM] === true;
}
var UNSUPPORTED_PROTOCOL_VERSION = -32022;
var NOT_PROBE_RECOGNIZED = new Set([
  -32001,
  -32020,
  -32021
]);
function classifyProbeOutcome(outcome, context) {
  switch (outcome.kind) {
    case "result":
      return classifyResult(outcome.result, context);
    case "rpc-error":
      return classifyRpcError(outcome, context);
    case "http-error":
      return classifyHttpError(outcome, context);
    case "network-error":
      return classifyNetworkError(outcome.error, context);
    case "unusable-reply":
      return {
        kind: "error",
        error: new SdkError(SdkErrorCode.EraNegotiationFailed, `Version negotiation probe failed: the server answered with an unusable reply (${describeError(outcome.error)})`, { cause: outcome.error }, { cause: outcome.error })
      };
    case "auth-required":
      return {
        kind: "error",
        error: outcome.error
      };
    case "closed":
      if (context.transportKind === "stdio")
        return { kind: "legacy" };
      return classifyNetworkError(/* @__PURE__ */ new Error("Connection closed during the version negotiation probe"), context);
    case "timeout":
      if (context.transportKind === "stdio")
        return { kind: "legacy" };
      return {
        kind: "error",
        error: new SdkError(SdkErrorCode.RequestTimeout, `Version negotiation probe timed out after ${outcome.timeoutMs}ms`, { timeout: outcome.timeoutMs })
      };
  }
}
function classifyResult(result, context) {
  const parsed = codecForVersion(MODERN_WIRE_REVISION).validateResult("server/discover", result);
  if (!parsed.ok)
    return { kind: "legacy" };
  const supportedVersions = parsed.value.supportedVersions;
  const overlap = context.clientModernVersions.find((version) => supportedVersions.includes(version));
  if (overlap !== undefined)
    return {
      kind: "modern",
      version: overlap,
      discover: parsed.value
    };
  if (context.fallbackAvailable)
    return { kind: "legacy" };
  return {
    kind: "error",
    error: new UnsupportedProtocolVersionError({
      supported: [...supportedVersions],
      requested: context.requestedVersion
    })
  };
}
function classifyRpcError(outcome, context) {
  const { code, message, data } = outcome;
  if (code === UNSUPPORTED_PROTOCOL_VERSION) {
    const supported = parseSupportedList(data);
    if (supported === undefined)
      return { kind: "legacy" };
    const error = new UnsupportedProtocolVersionError({
      supported,
      requested: parseRequested(data) ?? context.requestedVersion
    }, message);
    const supportedModern = modernProtocolVersions(supported);
    const mutual = context.clientModernVersions.find((version) => supportedModern.includes(version));
    if (mutual !== undefined)
      return {
        kind: "corrective",
        version: mutual,
        error
      };
    if (supportedModern.length > 0)
      return {
        kind: "error",
        error
      };
    return context.fallbackAvailable ? { kind: "legacy" } : {
      kind: "error",
      error
    };
  }
  if (NOT_PROBE_RECOGNIZED.has(code))
    return { kind: "legacy" };
  return { kind: "legacy" };
}
function classifyHttpError(outcome, context) {
  if (outcome.status === 401 || outcome.status === 403) {
    const isDenial = outcome.status === 403;
    return {
      kind: "error",
      error: new SdkHttpError(isDenial ? SdkErrorCode.ClientHttpForbidden : SdkErrorCode.ClientHttpAuthentication, `Version negotiation failed: ${isDenial ? "the server denied access (HTTP 403)" : "the server requires authorization (HTTP 401)"}`, {
        status: outcome.status,
        statusText: outcome.statusText,
        text: outcome.body
      })
    };
  }
  if (outcome.status >= 500)
    return {
      kind: "error",
      error: new SdkHttpError(SdkErrorCode.EraNegotiationFailed, `Version negotiation failed: the server answered the probe with HTTP ${outcome.status}`, {
        status: outcome.status,
        statusText: outcome.statusText,
        text: outcome.body
      })
    };
  const rpcError = parseJsonRpcErrorBody(outcome.body);
  if (rpcError !== undefined)
    return classifyRpcError(rpcError, context);
  return { kind: "legacy" };
}
function classifyNetworkError(error, context) {
  if (context.environment === "browser" && isOpaqueFetchTypeError(error))
    return { kind: "legacy" };
  return {
    kind: "error",
    error: new SdkError(SdkErrorCode.EraNegotiationFailed, `Version negotiation probe failed: ${describeError(error)}`, { cause: error }, { cause: error })
  };
}
function isOpaqueFetchTypeError(error) {
  return error instanceof TypeError || error instanceof Error && error.name === "TypeError";
}
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function parseSupportedList(data) {
  if (typeof data !== "object" || data === null)
    return;
  const supported = data.supported;
  if (!Array.isArray(supported) || supported.length === 0 || !supported.every((v) => typeof v === "string"))
    return;
  return supported;
}
function parseRequested(data) {
  if (typeof data !== "object" || data === null)
    return;
  const requested = data.requested;
  return typeof requested === "string" ? requested : undefined;
}
function parseJsonRpcErrorBody(body) {
  if (body === undefined || body === "")
    return;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null)
    return;
  const error = parsed.error;
  if (typeof error !== "object" || error === null)
    return;
  const { code, message, data } = error;
  if (typeof code !== "number")
    return;
  return {
    code,
    message: typeof message === "string" ? message : "",
    data
  };
}
var DEFAULT_VERSION_NEGOTIATION_MODE = "legacy";
function resolveVersionNegotiation(options, supportedProtocolVersionsOption) {
  const mode = options?.mode ?? DEFAULT_VERSION_NEGOTIATION_MODE;
  if (mode === "legacy")
    return { kind: "legacy" };
  const probe = options?.probe ?? {};
  if (typeof mode === "object") {
    if (!isModernProtocolVersion(mode.pin))
      throw new TypeError(`versionNegotiation: { pin: '${mode.pin}' } is not a modern protocol revision — pinning is for 2026-07-28 and later; omit versionNegotiation (or use mode: 'legacy') for 2025-era servers.`);
    return {
      kind: "pin",
      version: mode.pin,
      probe
    };
  }
  const explicitModern = supportedProtocolVersionsOption ? modernProtocolVersions(supportedProtocolVersionsOption) : [];
  return {
    kind: "auto",
    modernVersions: explicitModern.length > 0 ? explicitModern : [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
    fallbackAvailable: supportedProtocolVersionsOption ? legacyProtocolVersions(supportedProtocolVersionsOption).length > 0 : true,
    probe
  };
}
function detectProbeEnvironment() {
  const g = globalThis;
  return g.window !== undefined && g.document !== undefined ? "browser" : "node";
}
function detectProbeTransportKind(transport) {
  return "stderr" in transport && "pid" in transport ? "stdio" : "http";
}
var ProbeWindow = class ProbeWindow {
  _pending;
  _probeCounter = 0;
  _savedOnMessage;
  _savedOnError;
  _savedOnClose;
  _closeDelivered = false;
  constructor(_transport) {
    this._transport = _transport;
    this._savedOnMessage = _transport.onmessage;
    this._savedOnError = _transport.onerror;
    this._savedOnClose = _transport.onclose;
  }
  static async open(transport) {
    const window = new ProbeWindow(transport);
    transport.onmessage = (message) => {
      const pending = window._pending;
      if (pending !== undefined && (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id === pending.id) {
        window._pending = undefined;
        if (isJSONRPCResultResponse(message))
          pending.resolve({
            kind: "response",
            result: message.result
          });
        else
          pending.resolve({
            kind: "response",
            error: message.error
          });
        return;
      }
    };
    transport.onerror = (error) => {
      window._savedOnError?.(error);
    };
    transport.onclose = () => {
      const pending = window._pending;
      if (pending !== undefined) {
        window._pending = undefined;
        pending.resolve({ kind: "closed" });
      }
      window._closeDelivered = true;
      window._savedOnClose?.();
    };
    try {
      await transport.start();
    } catch (error) {
      window.detach();
      throw error;
    }
    return window;
  }
  async exchange(buildRequest, timeoutMs) {
    const id = `server-discover-probe-${++this._probeCounter}`;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (reply) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        if (this._pending?.id === id)
          this._pending = undefined;
        resolve(reply);
      };
      const timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      this._pending = {
        id,
        resolve: settle
      };
      this._transport.send(buildRequest(id)).catch((error) => settle({
        kind: "send-error",
        error
      }));
    });
  }
  detach() {
    this._pending = undefined;
    this._transport.onmessage = this._savedOnMessage;
    this._transport.onerror = this._savedOnError;
    if (this._closeDelivered && this._savedOnClose !== undefined) {
      const saved = this._savedOnClose;
      const transport = this._transport;
      let spent = false;
      const wrapper = () => {
        if (!spent) {
          spent = true;
          return;
        }
        saved();
      };
      transport.onclose = wrapper;
      pendingSpentCloseGuards.set(transport, () => {
        if (transport.onclose === wrapper)
          transport.onclose = saved;
      });
    } else
      this._transport.onclose = this._savedOnClose;
  }
  release() {
    this.detach();
    const transport = this._transport;
    const originalStart = transport.start;
    let armed = true;
    transport.start = async function() {
      if (armed) {
        armed = false;
        transport.start = originalStart;
        return;
      }
      return originalStart.call(transport);
    };
  }
};
var pendingSpentCloseGuards = /* @__PURE__ */ new WeakMap;
function disarmSpentCloseGuard(transport) {
  const disarm = pendingSpentCloseGuards.get(transport);
  pendingSpentCloseGuards.delete(transport);
  disarm?.();
}
function buildProbeRequest(id, protocolVersion, clientInfo, capabilities) {
  return {
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: { _meta: codecForVersion(protocolVersion).outboundEnvelope({
      protocolVersion,
      clientInfo,
      clientCapabilities: capabilities
    }) }
  };
}
function isUnusableReplyError(error) {
  if (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpUnexpectedContent)
    return true;
  return error instanceof Error && error.name === "SyntaxError";
}
function normalizeReply(reply, timeoutMs) {
  switch (reply.kind) {
    case "response":
      return reply.error === undefined ? {
        kind: "result",
        result: reply.result
      } : {
        kind: "rpc-error",
        ...reply.error
      };
    case "send-error": {
      const error = reply.error;
      if (isAuthSeamEscape(error) || error instanceof UnauthorizedError || error instanceof Error && error.name === "UnauthorizedError")
        return {
          kind: "auth-required",
          error
        };
      if (error instanceof SdkHttpError) {
        const text = error.data?.text;
        return {
          kind: "http-error",
          status: error.data.status,
          body: typeof text === "string" ? text : undefined,
          statusText: error.data.statusText
        };
      }
      if (isUnusableReplyError(error))
        return {
          kind: "unusable-reply",
          error
        };
      return {
        kind: "network-error",
        error
      };
    }
    case "closed":
      return { kind: "closed" };
    case "timeout":
      return {
        kind: "timeout",
        timeoutMs
      };
  }
}
async function negotiateEra(negotiation, deps) {
  const timeoutMs = negotiation.probe.timeoutMs ?? deps.defaultTimeoutMs;
  const maxRetries = Math.max(0, negotiation.probe.maxRetries ?? 0);
  const clientModernVersions = negotiation.kind === "pin" ? [negotiation.version] : negotiation.modernVersions;
  const fallbackAvailable = negotiation.kind === "auto" && negotiation.fallbackAvailable;
  const window = await ProbeWindow.open(deps.transport);
  const probe = async () => {
    let requestedVersion = clientModernVersions[0];
    let correctiveUsed = false;
    let timeoutRetriesRemaining = maxRetries;
    for (;; ) {
      const reply = await window.exchange((id) => buildProbeRequest(id, requestedVersion, deps.clientInfo, deps.capabilities), timeoutMs);
      if (reply.kind === "timeout" && timeoutRetriesRemaining > 0) {
        timeoutRetriesRemaining--;
        continue;
      }
      const outcome = normalizeReply(reply, timeoutMs);
      const verdict = classifyProbeOutcome(outcome, {
        clientModernVersions,
        requestedVersion,
        fallbackAvailable,
        environment: deps.environment,
        transportKind: deps.transportKind
      });
      switch (verdict.kind) {
        case "modern":
          return {
            era: "modern",
            version: verdict.version,
            discover: verdict.discover
          };
        case "corrective":
          if (correctiveUsed)
            throw verdict.error;
          correctiveUsed = true;
          requestedVersion = verdict.version;
          continue;
        case "legacy": {
          const closedCause = outcome.kind === "closed" ? "the connection closed during the server/discover probe" : undefined;
          if (negotiation.kind === "pin")
            throw new SdkError(SdkErrorCode.EraNegotiationFailed, closedCause === undefined ? `Version negotiation failed: the server did not offer pinned protocol version ${negotiation.version} via server/discover (no fallback in pin mode)` : `Version negotiation failed: ${closedCause} before the server offered pinned protocol version ${negotiation.version} (no fallback in pin mode)`);
          if (!negotiation.fallbackAvailable)
            throw new SdkError(SdkErrorCode.EraNegotiationFailed, closedCause === undefined ? "Version negotiation failed: the server gave no modern evidence and this client supports no pre-2026-07-28 protocol version to fall back to" : `Version negotiation failed: ${closedCause} and this client supports no pre-2026-07-28 protocol version to fall back to`);
          if (closedCause !== undefined && deps.disposableProbe !== true)
            throw new SdkError(SdkErrorCode.EraNegotiationFailed, `Version negotiation failed: ${closedCause} (this transport probed in place — the disposable sibling probe requires the SDK's base StdioClientTransport)`);
          return { era: "legacy" };
        }
        case "error":
          throw verdict.error;
      }
    }
  };
  let result;
  try {
    result = await probe();
  } catch (error) {
    window.detach();
    throw error;
  }
  window.release();
  return result;
}
function readStdioServerParams(transport) {
  const proto = Object.getPrototypeOf(transport);
  if (proto === null || !Object.prototype.hasOwnProperty.call(proto, "_dispose"))
    return;
  const params = transport._serverParams;
  return typeof params === "object" && params !== null && typeof params.command === "string" ? params : undefined;
}
async function negotiateStdioViaSibling(negotiation, sessionTransport, params, deps) {
  const SiblingTransport = sessionTransport.constructor;
  const sibling = new SiblingTransport({
    ...params,
    stderr: "ignore"
  });
  const originalClose = sessionTransport.close;
  let callerClosed = false;
  let signalClosed;
  const closedSignal = new Promise((_, reject) => {
    signalClosed = () => reject(callerCloseAbortError());
  });
  sessionTransport.close = async function() {
    callerClosed = true;
    signalClosed?.();
    return originalClose.call(sessionTransport);
  };
  let result;
  try {
    const negotiated = negotiateEra(negotiation, {
      ...deps,
      transport: sibling,
      transportKind: "stdio",
      disposableProbe: true
    });
    negotiated.catch(() => {});
    result = await Promise.race([negotiated, closedSignal]);
  } finally {
    await disposeSibling(sibling);
    sessionTransport.close = originalClose;
  }
  if (callerClosed)
    throw callerCloseAbortError();
  return result;
}
function callerCloseAbortError() {
  return new SdkError(SdkErrorCode.EraNegotiationFailed, "Version negotiation failed: the transport was closed during the server/discover probe");
}
async function disposeSibling(sibling) {
  try {
    const dispose = sibling._dispose;
    await (typeof dispose === "function" ? dispose.call(sibling) : sibling.close());
  } catch {}
}
function serverInfoFromDiscover(discover) {
  const fromMeta = discover._meta?.[SERVER_INFO_META_KEY];
  return isSpecType.Implementation(fromMeta) ? fromMeta : undefined;
}
function applyElicitationDefaults(schema, data) {
  if (!schema || data === null || typeof data !== "object")
    return;
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const obj = data;
    const props = schema.properties;
    for (const key of Object.keys(props)) {
      const propSchema = props[key];
      if (obj[key] === undefined && Object.prototype.hasOwnProperty.call(propSchema, "default"))
        obj[key] = propSchema.default;
      if (obj[key] !== undefined)
        applyElicitationDefaults(propSchema, obj[key]);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    for (const sub of schema.anyOf)
      if (typeof sub !== "boolean")
        applyElicitationDefaults(sub, data);
  }
  if (Array.isArray(schema.oneOf)) {
    for (const sub of schema.oneOf)
      if (typeof sub !== "boolean")
        applyElicitationDefaults(sub, data);
  }
}
function getSupportedElicitationModes(capabilities) {
  if (!capabilities)
    return {
      supportsFormMode: false,
      supportsUrlMode: false
    };
  const hasFormCapability = capabilities.form !== undefined;
  const hasUrlCapability = capabilities.url !== undefined;
  return {
    supportsFormMode: hasFormCapability || !hasFormCapability && !hasUrlCapability,
    supportsUrlMode: hasUrlCapability
  };
}
function validatePrior(prior) {
  if (typeof prior === "object" && prior !== null) {
    if (prior.kind === "legacy" && !("supportedVersions" in prior) && !("discover" in prior))
      return prior;
    if (prior.kind === "modern" && DiscoverResultSchema.safeParse(prior.discover).success)
      return prior;
  }
  throw new SdkError(SdkErrorCode.EraNegotiationFailed, "connect({ prior }): unrecognized prior — expected { kind: 'modern', discover } or { kind: 'legacy' }");
}
var LIST_CHANGED_EVICTIONS = {
  "notifications/tools/list_changed": ["tools/list"],
  "notifications/prompts/list_changed": ["prompts/list"],
  "notifications/resources/list_changed": ["resources/list", "resources/templates/list"]
};
var DEFAULT_LIST_MAX_PAGES = 64;
var clientInternals = {};
var Client = class extends Protocol {
  _serverCapabilities;
  _serverVersion;
  _capabilities;
  _instructions;
  _jsonSchemaValidator;
  _cache;
  _defaultCacheTtlMs;
  _listMaxPages;
  _listChangedDebounceTimers = /* @__PURE__ */ new Map;
  _listChangedConfig;
  _enforceStrictCapabilities;
  _versionNegotiation;
  _supportedProtocolVersionsOption;
  _inputRequiredDriverConfig;
  _listenState = /* @__PURE__ */ new Map;
  _nextListenId = 0;
  _autoOpenedSubscription;
  _discoverResult;
  static {
    clientInternals.enforceStrictCapabilities = (client) => client._enforceStrictCapabilities;
    clientInternals.walkPages = (client, method, fetchPage, items) => client._walkPages(method, fetchPage, items);
    clientInternals.readResource = (client, params, options) => client._readResource(params, options);
  }
  _resetConnectionState() {
    this._negotiatedProtocolVersion = undefined;
    this._serverCapabilities = undefined;
    this._serverVersion = undefined;
    this._instructions = undefined;
    this._discoverResult = undefined;
    this._autoOpenedSubscription = undefined;
    if (this._listenState.size > 0) {
      const reason = new SdkError(SdkErrorCode.ConnectionClosed, "subscriptions/listen: client reconnected or closed; subscription state from the previous connection was reset");
      for (const entry of this._listenState.values())
        entry.settle({
          cause: "remote",
          error: reason
        });
    }
    this._listenState.clear();
    for (const timer of this._listChangedDebounceTimers.values())
      clearTimeout(timer);
    this._listChangedDebounceTimers.clear();
    this._cache.resetForReconnect();
  }
  async close() {
    try {
      await super.close();
    } finally {
      this._resetConnectionState();
    }
  }
  constructor(_clientInfo, options) {
    super(options);
    this._clientInfo = _clientInfo;
    this._capabilities = options?.capabilities ? { ...options.capabilities } : {};
    this._jsonSchemaValidator = options?.jsonSchemaValidator ?? new AjvJsonSchemaValidator;
    this._enforceStrictCapabilities = options?.enforceStrictCapabilities ?? false;
    this._versionNegotiation = options?.versionNegotiation;
    this._supportedProtocolVersionsOption = options?.supportedProtocolVersions;
    this._inputRequiredDriverConfig = resolveInputRequiredDriverConfig(options?.inputRequired);
    this._cache = new ClientResponseCache(options?.responseCacheStore ?? new InMemoryResponseCacheStore, options?.responseCacheStore !== undefined, (error) => this._reportStoreError(error), options?.cachePartition ?? "");
    this._defaultCacheTtlMs = options?.defaultCacheTtlMs ?? 0;
    this._listMaxPages = options?.listMaxPages ?? DEFAULT_LIST_MAX_PAGES;
    if (options?.listChanged)
      this._listChangedConfig = options.listChanged;
  }
  buildContext(ctx, _transportInfo) {
    return ctx;
  }
  _shouldDropInbound(message) {
    if (this._negotiatedProtocolVersion !== undefined && isModernProtocolVersion(this._negotiatedProtocolVersion) && isJSONRPCRequest(message))
      return "drop";
  }
  _outboundMetaEnvelope() {
    const version = this._negotiatedProtocolVersion;
    if (version === undefined)
      return;
    return this._wireCodec().outboundEnvelope({
      protocolVersion: version,
      clientInfo: this._clientInfo,
      clientCapabilities: this._capabilities
    });
  }
  _resolveNonCompleteResult(decoded, flow) {
    if (!this._inputRequiredDriverConfig.autoFulfill)
      return Promise.reject(new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type 'input_required' for ${flow.request.method}: multi-round-trip auto-fulfilment is not enabled on this instance — pass allowInputRequired: true to handle it manually, or enable inputRequired.autoFulfill`, {
        resultType: "input_required",
        method: flow.request.method
      }));
    return runInputRequiredFlow({
      getRequestHandler: (method) => this._getRequestHandler(method),
      buildContext: (baseCtx) => this.buildContext(baseCtx, undefined),
      sessionId: this.transport?.sessionId
    }, this._inputRequiredDriverConfig, decoded, flow);
  }
  _setupListChangedHandlers(config) {
    if (config.tools && this._serverCapabilities?.tools?.listChanged)
      this._setupListChangedHandler("tools", "notifications/tools/list_changed", config.tools, async () => {
        return (await this.listTools(undefined, { cacheMode: "refresh" })).tools;
      });
    if (config.prompts && this._serverCapabilities?.prompts?.listChanged)
      this._setupListChangedHandler("prompts", "notifications/prompts/list_changed", config.prompts, async () => {
        return (await this.listPrompts(undefined, { cacheMode: "refresh" })).prompts;
      });
    if (config.resources && this._serverCapabilities?.resources?.listChanged)
      this._setupListChangedHandler("resources", "notifications/resources/list_changed", config.resources, async () => {
        return (await this.listResources(undefined, { cacheMode: "refresh" })).resources;
      });
  }
  registerCapabilities(capabilities) {
    if (this.transport)
      throw new Error("Cannot register capabilities after connecting to transport");
    this._capabilities = mergeCapabilities(this._capabilities, capabilities);
  }
  setVersionNegotiation(options) {
    if (this.transport)
      throw new Error("Cannot configure version negotiation after connecting to transport");
    this._versionNegotiation = options;
  }
  _wrapHandler(method, handler) {
    if (method === "elicitation/create")
      return async (request, ctx) => {
        const codec = codecForVersion(this._negotiatedProtocolVersion);
        let validatedRequest = codec.validateRequest("elicitation/create", request);
        if (!validatedRequest.ok && validatedRequest.reason === "not-in-era")
          validatedRequest = codec.validateInputRequest("elicitation/create", request);
        if (!validatedRequest.ok)
          throw new ProtocolError(validatedRequest.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedRequest.reason === "not-in-era" ? "No wire schema for elicitation/create in the resolved era" : `Invalid elicitation request: ${validatedRequest.message}`);
        const { params } = validatedRequest.value;
        params.mode = params.mode ?? "form";
        const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(this._capabilities.elicitation);
        if (params.mode === "form" && !supportsFormMode)
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Client does not support form-mode elicitation requests");
        if (params.mode === "url" && !supportsUrlMode)
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Client does not support URL-mode elicitation requests");
        const result = await handler(request, ctx);
        let validationResult = codec.validateResult("elicitation/create", result);
        if (!validationResult.ok && validationResult.reason === "not-in-era")
          validationResult = codec.validateInputResponse("elicitation/create", result);
        if (!validationResult.ok)
          throw new ProtocolError(validationResult.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validationResult.reason === "not-in-era" ? "No wire schema for elicitation/create in the resolved era" : `Invalid elicitation result: ${validationResult.message}`);
        const validatedResult = validationResult.value;
        const requestedSchema = params.mode === "form" ? params.requestedSchema : undefined;
        if (params.mode === "form" && validatedResult.action === "accept" && validatedResult.content && requestedSchema && this._capabilities.elicitation?.form?.applyDefaults)
          try {
            applyElicitationDefaults(requestedSchema, validatedResult.content);
          } catch {}
        return validatedResult;
      };
    if (method === "sampling/createMessage")
      return async (request, ctx) => {
        const codec = codecForVersion(this._negotiatedProtocolVersion);
        let validatedRequest = codec.validateRequest("sampling/createMessage", request);
        if (!validatedRequest.ok && validatedRequest.reason === "not-in-era")
          validatedRequest = codec.validateInputRequest("sampling/createMessage", request);
        if (!validatedRequest.ok)
          throw new ProtocolError(validatedRequest.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedRequest.reason === "not-in-era" ? "No wire schema for sampling/createMessage in the resolved era" : `Invalid sampling request: ${validatedRequest.message}`);
        const { params } = validatedRequest.value;
        const result = await handler(request, ctx);
        const hasTools = Boolean(params.tools || params.toolChoice);
        let validatedResult = codec.samplingResultVariant(hasTools, result);
        if (!validatedResult.ok && validatedResult.reason === "not-in-era")
          validatedResult = codec.validateInputResponse("sampling/createMessage", result);
        if (!validatedResult.ok)
          throw new ProtocolError(validatedResult.reason === "not-in-era" ? ProtocolErrorCode.InternalError : ProtocolErrorCode.InvalidParams, validatedResult.reason === "not-in-era" ? "No result schema for sampling/createMessage in the resolved era" : `Invalid sampling result: ${validatedResult.message}`);
        return validatedResult.value;
      };
    return handler;
  }
  assertCapability(capability, method) {
    if (!this._serverCapabilities?.[capability])
      throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support ${capability} (required for ${method})`);
  }
  async connect(transport, options) {
    if (options?.prior != null)
      return this._connectFromPrior(transport, validatePrior(options.prior), options);
    const negotiation = resolveVersionNegotiation(this._versionNegotiation, this._supportedProtocolVersionsOption);
    if (negotiation.kind !== "legacy")
      return this._connectNegotiated(transport, negotiation, options);
    return this._connectPlainLegacy(transport, options);
  }
  async _connectPlainLegacy(transport, options) {
    await super.connect(transport);
    if (transport.sessionId !== undefined) {
      const negotiatedProtocolVersion = this._negotiatedProtocolVersion;
      if (negotiatedProtocolVersion !== undefined)
        transport.setProtocolVersion?.(negotiatedProtocolVersion);
      return;
    }
    this._resetConnectionState();
    await this._legacyHandshake(transport, options);
  }
  async _legacyHandshake(transport, options) {
    const legacyVersions = legacyProtocolVersions(this._supportedProtocolVersions);
    try {
      const offeredVersion = legacyVersions[0];
      if (offeredVersion === undefined)
        throw new SdkError(SdkErrorCode.EraNegotiationFailed, "Cannot run the initialize handshake: supportedProtocolVersions contains no pre-2026-07-28 protocol version");
      const result = await this.request({
        method: "initialize",
        params: {
          protocolVersion: offeredVersion,
          capabilities: this._capabilities,
          clientInfo: this._clientInfo
        }
      }, options);
      if (result === undefined)
        throw new Error(`Server sent invalid initialize result: ${result}`);
      if (!legacyVersions.includes(result.protocolVersion))
        throw new Error(`Server's protocol version is not supported: ${result.protocolVersion}`);
      this._serverCapabilities = result.capabilities;
      this._serverVersion = result.serverInfo;
      this._cache.setServerIdentity(this._deriveServerIdentity(transport));
      if (transport.setProtocolVersion)
        transport.setProtocolVersion(result.protocolVersion);
      this._instructions = result.instructions;
      await this.notification({ method: "notifications/initialized" });
      this._negotiatedProtocolVersion = result.protocolVersion;
      if (this._listChangedConfig)
        this._setupListChangedHandlers(this._listChangedConfig);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  async _connectNegotiated(transport, negotiation, options) {
    if (transport.sessionId !== undefined) {
      await super.connect(transport);
      const negotiatedProtocolVersion = this._negotiatedProtocolVersion;
      if (negotiatedProtocolVersion !== undefined && transport.setProtocolVersion)
        transport.setProtocolVersion(negotiatedProtocolVersion);
      return;
    }
    this._resetConnectionState();
    let result;
    try {
      const transportKind = detectProbeTransportKind(transport);
      const baseDeps = {
        clientInfo: this._clientInfo,
        capabilities: this._capabilities,
        environment: detectProbeEnvironment(),
        defaultTimeoutMs: options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC
      };
      const stdioParams = transportKind === "stdio" ? readStdioServerParams(transport) : undefined;
      result = stdioParams === undefined ? await negotiateEra(negotiation, {
        ...baseDeps,
        transport,
        transportKind
      }) : await negotiateStdioViaSibling(negotiation, transport, stdioParams, baseDeps);
    } catch (error) {
      await transport.close().catch(() => {});
      disarmSpentCloseGuard(transport);
      throw error;
    }
    disarmSpentCloseGuard(transport);
    await super.connect(transport);
    if (result.era === "legacy") {
      await this._legacyHandshake(transport, options);
      return;
    }
    this._serverCapabilities = result.discover.capabilities;
    this._serverVersion = serverInfoFromDiscover(result.discover);
    this._cache.setServerIdentity(this._deriveServerIdentity(transport));
    this._instructions = result.discover.instructions;
    this._discoverResult = result.discover;
    this._negotiatedProtocolVersion = result.version;
    if (transport.setProtocolVersion)
      transport.setProtocolVersion(result.version);
    if (this._listChangedConfig) {
      const config = this._listChangedConfig;
      const advertised = this._serverCapabilities;
      const effective = {
        ...config.tools && advertised?.tools?.listChanged && { tools: config.tools },
        ...config.prompts && advertised?.prompts?.listChanged && { prompts: config.prompts },
        ...config.resources && advertised?.resources?.listChanged && { resources: config.resources }
      };
      let handlersRegistered = true;
      try {
        this._setupListChangedHandlers(effective);
      } catch (error) {
        handlersRegistered = false;
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
      const filter = handlersRegistered ? {
        ...effective.tools && { toolsListChanged: true },
        ...effective.prompts && { promptsListChanged: true },
        ...effective.resources && { resourcesListChanged: true }
      } : {};
      if (Object.keys(filter).length > 0) {
        const ackAbort = new AbortController;
        const onConnectAbort = () => ackAbort.abort(options?.signal?.reason);
        if (options?.signal?.aborted)
          onConnectAbort();
        options?.signal?.addEventListener("abort", onConnectAbort);
        try {
          this._autoOpenedSubscription = await this.listen(filter, {
            timeout: options?.timeout,
            signal: ackAbort.signal
          });
        } catch (error) {
          if (options?.signal?.aborted) {
            await this.close().catch(() => {});
            throw error;
          }
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          options?.signal?.removeEventListener("abort", onConnectAbort);
        }
      }
    }
  }
  async _connectFromPrior(transport, prior, options) {
    if (prior.kind === "legacy")
      return this._connectPlainLegacy(transport, options);
    const discover = prior.discover;
    this._resetConnectionState();
    const explicit = this._supportedProtocolVersionsOption;
    const version = (explicit && modernProtocolVersions(explicit).length > 0 ? modernProtocolVersions(explicit) : SUPPORTED_MODERN_PROTOCOL_VERSIONS).find((v) => discover.supportedVersions.includes(v));
    if (version === undefined)
      throw new SdkError(SdkErrorCode.EraNegotiationFailed, "connect({ prior }) with a modern verdict requires a 2026-07-28+ mutual protocol version; the supplied DiscoverResult and this client's supportedProtocolVersions have no modern overlap. For a server known to be legacy, pass prior: { kind: 'legacy' } to skip the probe and initialize directly, or use versionNegotiation: { mode: 'auto' } to re-probe with legacy fallback.");
    await super.connect(transport);
    this._discoverResult = discover;
    this._serverCapabilities = discover.capabilities;
    this._serverVersion = serverInfoFromDiscover(discover);
    this._cache.setServerIdentity(this._deriveServerIdentity(transport));
    this._instructions = discover.instructions;
    this._negotiatedProtocolVersion = version;
    transport.setProtocolVersion?.(version);
    if (this._listChangedConfig)
      try {
        this._setupListChangedHandlers(this._listChangedConfig);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
  }
  getServerCapabilities() {
    return this._serverCapabilities;
  }
  getServerVersion() {
    return this._serverVersion;
  }
  _deriveServerIdentity(transport) {
    const v = this._serverVersion;
    if (v !== undefined)
      return `${v.name}@${v.version}`;
    return transport.sessionId ?? `anonymous:${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  getNegotiatedProtocolVersion() {
    return this._negotiatedProtocolVersion;
  }
  getProtocolEra() {
    const version = this._negotiatedProtocolVersion;
    if (version === undefined)
      return;
    return isModernProtocolVersion(version) ? "modern" : "legacy";
  }
  getInstructions() {
    return this._instructions;
  }
  getDiscoverResult() {
    return this._discoverResult;
  }
  assertCapabilityForMethod(method) {
    switch (method) {
      case "logging/setLevel":
        if (!this._serverCapabilities?.logging)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support logging (required for ${method})`);
        break;
      case "prompts/get":
      case "prompts/list":
        if (!this._serverCapabilities?.prompts)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support prompts (required for ${method})`);
        break;
      case "resources/list":
      case "resources/templates/list":
      case "resources/read":
      case "resources/subscribe":
      case "resources/unsubscribe":
        if (!this._serverCapabilities?.resources)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resources (required for ${method})`);
        if (method === "resources/subscribe" && !this._serverCapabilities.resources.subscribe)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support resource subscriptions (required for ${method})`);
        break;
      case "tools/call":
      case "tools/list":
        if (!this._serverCapabilities?.tools)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support tools (required for ${method})`);
        break;
      case "completion/complete":
        if (!this._serverCapabilities?.completions)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Server does not support completions (required for ${method})`);
        break;
      case "initialize":
        break;
      case "server/discover":
        break;
      case "ping":
        break;
    }
  }
  assertNotificationCapability(method) {
    switch (method) {
      case "notifications/roots/list_changed":
        if (!this._capabilities.roots?.listChanged)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support roots list changed notifications (required for ${method})`);
        break;
      case "notifications/initialized":
        break;
      case "notifications/cancelled":
        break;
      case "notifications/progress":
        break;
    }
  }
  assertRequestHandlerCapability(method) {
    switch (method) {
      case "sampling/createMessage":
        if (!this._capabilities.sampling)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support sampling capability (required for ${method})`);
        break;
      case "elicitation/create":
        if (!this._capabilities.elicitation)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support elicitation capability (required for ${method})`);
        break;
      case "roots/list":
        if (!this._capabilities.roots)
          throw new SdkError(SdkErrorCode.CapabilityNotSupported, `Client does not support roots capability (required for ${method})`);
        break;
      case "ping":
        break;
    }
  }
  async ping(options) {
    return this.request({ method: "ping" }, options);
  }
  async discover(options) {
    const result = await this._requestWithSchema({ method: "server/discover" }, DiscoverResultSchema, options);
    this._discoverResult = result;
    return result;
  }
  async complete(params, options) {
    return this.request({
      method: "completion/complete",
      params
    }, options);
  }
  async setLoggingLevel(level, options) {
    return this.request({
      method: "logging/setLevel",
      params: { level }
    }, options);
  }
  async getPrompt(params, options) {
    return this.request({
      method: "prompts/get",
      params
    }, options);
  }
  async listPrompts(params, options) {
    if (!this._serverCapabilities?.prompts && !this._enforceStrictCapabilities) {
      console.debug("Client.listPrompts() called but server does not advertise prompts capability - returning empty list");
      return { prompts: [] };
    }
    if (params?.cursor !== undefined)
      return this.request({
        method: "prompts/list",
        params
      }, options);
    const hit = await this._serveFromCache("prompts/list", undefined, options);
    if (hit !== undefined)
      return hit;
    return this._listAllPages("prompts/list", params, options, (r) => r.prompts);
  }
  async listResources(params, options) {
    if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
      console.debug("Client.listResources() called but server does not advertise resources capability - returning empty list");
      return { resources: [] };
    }
    if (params?.cursor !== undefined)
      return this.request({
        method: "resources/list",
        params
      }, options);
    const hit = await this._serveFromCache("resources/list", undefined, options);
    if (hit !== undefined)
      return hit;
    return this._listAllPages("resources/list", params, options, (r) => r.resources);
  }
  async listResourceTemplates(params, options) {
    if (!this._serverCapabilities?.resources && !this._enforceStrictCapabilities) {
      console.debug("Client.listResourceTemplates() called but server does not advertise resources capability - returning empty list");
      return { resourceTemplates: [] };
    }
    if (params?.cursor !== undefined)
      return this.request({
        method: "resources/templates/list",
        params
      }, options);
    const hit = await this._serveFromCache("resources/templates/list", undefined, options);
    if (hit !== undefined)
      return hit;
    return this._listAllPages("resources/templates/list", params, options, (r) => r.resourceTemplates);
  }
  async _listAllPages(method, baseParams, options, items, finalize) {
    const bypass = options?.cacheMode === "bypass";
    const generation = this._cache.captureGeneration(method);
    const fetchPage = (cursor) => {
      const params = cursor === undefined ? baseParams && { ...baseParams } : {
        ...baseParams,
        cursor
      };
      return this.request({
        method,
        ...params && { params }
      }, options);
    };
    const acc = await this._walkPages(method, fetchPage, items);
    delete acc.nextCursor;
    finalize?.(acc);
    if (bypass)
      return acc;
    await this._cache.write(method, acc, generation, this._freshness(acc));
    return acc;
  }
  async _walkPages(method, fetchPage, items) {
    const acc = await fetchPage(undefined);
    let cursor = acc.nextCursor;
    let previous = acc;
    let pages = 1;
    while (cursor !== undefined) {
      if (this._listMaxPages !== 0 && pages >= this._listMaxPages)
        throw new SdkError(SdkErrorCode.ListPaginationExceeded, `${method}: exceeded listMaxPages (${this._listMaxPages}); server pagination did not terminate`, {
          method,
          listMaxPages: this._listMaxPages
        });
      const page = await fetchPage(cursor);
      if (page.nextCursor === cursor && JSON.stringify(items(page)) === JSON.stringify(items(previous)))
        break;
      items(acc).push(...items(page));
      previous = page;
      cursor = page.nextCursor;
      pages++;
    }
    return acc;
  }
  _freshness(result, params) {
    const body = result;
    const ttlMs = typeof body.ttlMs === "number" ? body.ttlMs : this._defaultCacheTtlMs;
    const scope = body.cacheScope === "public" ? "public" : "private";
    return {
      expiresAt: this._cache.now() + Math.min(Math.max(0, ttlMs), MAX_CACHE_TTL_MS),
      scope,
      params
    };
  }
  async _serveFromCache(method, params, options) {
    if (options?.cacheMode === "bypass" || options?.cacheMode === "refresh")
      return;
    const hit = await this._cache.read(method, params).catch((error) => void this._reportStoreError(error));
    if (hit !== undefined) {
      if (options?.signal?.aborted) {
        const reason = options.signal.reason;
        throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
      }
      return hit.value;
    }
  }
  _reportStoreError(e) {
    this.onerror?.(e instanceof Error ? e : new Error(String(e)));
  }
  _compileOutputValidator(tool) {
    if (!tool.outputSchema)
      return;
    try {
      return {
        ok: true,
        validator: this._jsonSchemaValidator.getValidator(tool.outputSchema)
      };
    } catch (error) {
      return {
        ok: false,
        compileError: error
      };
    }
  }
  async _resolveXMcpHeaderScan(name, override) {
    const tool = override ?? await this._cache.toolDefinition(name);
    return tool === undefined ? undefined : scanXMcpHeaderDeclarations(tool.inputSchema);
  }
  async readResource(params, options) {
    const { result } = await this._readResource(params, options);
    return result;
  }
  async _readResource(params, options) {
    const hit = await this._serveFromCache("resources/read", params.uri, options);
    if (hit !== undefined)
      return {
        result: hit,
        cached: true
      };
    const generation = this._cache.captureGeneration("resources/read", params.uri);
    const result = await this.request({
      method: "resources/read",
      params
    }, options);
    if (options?.cacheMode !== "bypass") {
      const freshness = this._freshness(result, params.uri);
      if (freshness.expiresAt > this._cache.now())
        await this._cache.write("resources/read", result, generation, freshness);
      else if (options?.cacheMode === "refresh")
        await this._cache.evictKey("resources/read", params.uri);
    }
    return {
      result,
      cached: false
    };
  }
  async subscribeResource(params, options) {
    return this.request({
      method: "resources/subscribe",
      params
    }, options);
  }
  async unsubscribeResource(params, options) {
    return this.request({
      method: "resources/unsubscribe",
      params
    }, options);
  }
  async listen(filter, options) {
    if (this.transport === undefined)
      throw new SdkError(SdkErrorCode.NotConnected, "Not connected");
    const negotiated = this._negotiatedProtocolVersion;
    if (negotiated === undefined || !isModernProtocolVersion(negotiated))
      throw new SdkError(SdkErrorCode.MethodNotSupportedByProtocolVersion, `subscriptions/listen requires a 2026-07-28-era connection (negotiated: ${negotiated ?? "none"}). On a 2025-era connection, change notifications are delivered unsolicited: use ClientOptions.listChanged and resources/subscribe instead.`, {
        method: "subscriptions/listen",
        protocolVersion: negotiated
      });
    if (options?.signal?.aborted) {
      const reason = options.signal.reason;
      throw reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
    }
    const requestAbort = new AbortController;
    const listenId = `listen:${this._nextListenId++}`;
    let state = "opening";
    let ackTimer;
    let onCallerAbort;
    let resolveOpening;
    let rejectOpening;
    const opening = new Promise((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const settle = (outcome) => {
      if (state === "closed")
        return;
      const wasOpening = state === "opening";
      if (ackTimer !== undefined) {
        clearTimeout(ackTimer);
        ackTimer = undefined;
      }
      if ("ack" in outcome) {
        state = "open";
        resolveOpening(outcome.ack);
        return;
      }
      state = "closed";
      if (onCallerAbort !== undefined)
        options?.signal?.removeEventListener("abort", onCallerAbort);
      this._listenState.delete(listenId);
      requestAbort.abort();
      resolveClosed(outcome.cause);
      if (wasOpening)
        rejectOpening(outcome.error ?? new SdkError(SdkErrorCode.ConnectionClosed, "subscriptions/listen closed before the server acknowledged"));
    };
    const wireTeardown = async () => {
      requestAbort.abort();
      await this.notification({
        method: "notifications/cancelled",
        params: { requestId: listenId }
      }).catch(() => {});
    };
    const close = async () => {
      if (state === "closed")
        return;
      settle({ cause: "local" });
      await wireTeardown();
    };
    this._listenState.set(listenId, { settle });
    const ackTimeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    ackTimer = setTimeout(() => {
      settle({
        cause: "remote",
        error: new SdkError(SdkErrorCode.RequestTimeout, "subscriptions/listen ack timed out", { timeout: ackTimeout })
      });
      wireTeardown().catch(() => {});
    }, ackTimeout);
    if (options?.signal) {
      const callerSignal = options.signal;
      onCallerAbort = () => {
        if (state === "closed")
          return;
        const reason = callerSignal.reason;
        settle({
          cause: "local",
          error: reason instanceof Error ? reason : new Error(String(reason ?? "Aborted"))
        });
        wireTeardown().catch(() => {});
      };
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const jsonrpcRequest = {
      jsonrpc: "2.0",
      id: listenId,
      method: "subscriptions/listen",
      params: {
        _meta: { ...this._outboundMetaEnvelope() },
        notifications: filter
      }
    };
    const routeSendFailure = (error) => {
      settle({
        cause: "remote",
        error: error instanceof Error ? error : new Error(String(error))
      });
    };
    try {
      this.transport.send(jsonrpcRequest, {
        requestSignal: requestAbort.signal,
        onRequestStreamEnd: () => settle({
          cause: "remote",
          error: /* @__PURE__ */ new Error("subscriptions/listen: stream ended")
        })
      }).catch(routeSendFailure);
    } catch (error) {
      routeSendFailure(error);
    }
    return {
      honoredFilter: await opening,
      close,
      closed
    };
  }
  get autoOpenedSubscription() {
    return this._autoOpenedSubscription;
  }
  _onnotification(raw, extra) {
    const evicted = Object.hasOwn(LIST_CHANGED_EVICTIONS, raw.method) ? LIST_CHANGED_EVICTIONS[raw.method] : undefined;
    if (raw.method === "notifications/resources/updated") {
      const uri = raw.params?.uri;
      if (typeof uri === "string")
        this._cache.evictKey("resources/read", uri);
    } else if (evicted !== undefined)
      for (const method of evicted)
        this._cache.evict(method);
    if (raw.method === "notifications/subscriptions/acknowledged") {
      const subscriptionId = raw.params?._meta?.[SUBSCRIPTION_ID_META_KEY];
      const entry = typeof subscriptionId === "string" ? this._listenState.get(subscriptionId) : undefined;
      if (entry !== undefined) {
        const honored = this._wireCodec().validateNotification("notifications/subscriptions/acknowledged", raw);
        entry.settle({ ack: honored.ok ? honored.value.params.notifications : {} });
        return;
      }
    }
    if (raw.method === "notifications/cancelled") {
      const cancelledId = raw.params?.requestId;
      const entry = typeof cancelledId === "string" ? this._listenState.get(cancelledId) : undefined;
      if (entry !== undefined) {
        entry.settle({
          cause: "remote",
          error: /* @__PURE__ */ new Error("subscriptions/listen: server cancelled the subscription")
        });
        return;
      }
    }
    super._onnotification(raw, extra);
  }
  _onresponse(response) {
    const id = response.id;
    const entry = typeof id === "string" ? this._listenState.get(id) : undefined;
    if (entry !== undefined) {
      if (isJSONRPCErrorResponse(response))
        entry.settle({
          cause: "remote",
          error: ProtocolError.fromError(response.error.code, response.error.message, response.error.data)
        });
      else
        entry.settle({
          cause: "graceful",
          error: new SdkError(SdkErrorCode.ConnectionClosed, "subscriptions/listen: server closed the subscription gracefully before acknowledging")
        });
      return;
    }
    super._onresponse(response);
  }
  _onclose() {
    if (this._listenState.size > 0) {
      const reason = new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
      for (const entry of this._listenState.values())
        entry.settle({
          cause: "remote",
          error: reason
        });
      this._listenState.clear();
    }
    super._onclose();
  }
  async callTool(params, options) {
    const mirroringActive = this.getProtocolEra() === "modern" && detectProbeEnvironment() !== "browser";
    const buildSendOptions = async () => {
      if (!mirroringActive)
        return options;
      let scan;
      try {
        scan = await this._resolveXMcpHeaderScan(params.name, options?.toolDefinition);
      } catch (error) {
        this._reportStoreError(error);
      }
      if (!scan?.valid || scan.declarations.length === 0)
        return options;
      const paramHeaders = buildMcpParamHeaders(scan.declarations, params.arguments);
      return Object.keys(paramHeaders).length === 0 ? options : {
        ...options,
        headers: {
          ...options?.headers,
          ...paramHeaders
        }
      };
    };
    let compiled = options?.toolDefinition === undefined ? await this._cache.outputValidator(params.name, (tool) => this._compileOutputValidator(tool)).catch((error) => void this._reportStoreError(error)) : this._compileOutputValidator(options.toolDefinition);
    const assertCompiled = () => {
      if (compiled === undefined || compiled.ok)
        return;
      const err = compiled.compileError;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool '${params.name}' has an invalid outputSchema: ${message}`);
    };
    assertCompiled();
    let result;
    try {
      result = await this.request({
        method: "tools/call",
        params
      }, await buildSendOptions());
    } catch (error) {
      const isHeaderMismatch = error instanceof ProtocolError && error.code === HEADER_MISMATCH_ERROR_CODE;
      if (!mirroringActive || !isHeaderMismatch || options?.toolDefinition !== undefined)
        throw error;
      const refreshOptions = {
        signal: options?.signal,
        timeout: options?.timeout,
        cacheMode: "refresh"
      };
      await this._cache.evict("tools/list");
      await this.listTools(undefined, refreshOptions).catch((error_) => this._reportStoreError(error_));
      compiled = await this._cache.outputValidator(params.name, (tool) => this._compileOutputValidator(tool)).catch((error_) => void this._reportStoreError(error_));
      assertCompiled();
      result = await this.request({
        method: "tools/call",
        params
      }, await buildSendOptions());
    }
    const validator = compiled !== undefined && compiled.ok ? compiled.validator : undefined;
    if (validator) {
      if (result.structuredContent === undefined && !result.isError)
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, `Tool ${params.name} has an output schema but did not return structured content`);
      if (result.structuredContent !== undefined && !result.isError)
        try {
          const validationResult = validator(result.structuredContent);
          if (!validationResult.valid)
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`);
        } catch (error) {
          if (error instanceof ProtocolError)
            throw error;
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return result;
  }
  async listTools(params, options) {
    if (!this._serverCapabilities?.tools && !this._enforceStrictCapabilities) {
      console.debug("Client.listTools() called but server does not advertise tools capability - returning empty list");
      return { tools: [] };
    }
    if (params?.cursor !== undefined) {
      const page = await this.request({
        method: "tools/list",
        params
      }, options);
      this._excludeInvalidXMcpHeaderTools(page);
      return page;
    }
    const hit = await this._serveFromCache("tools/list", undefined, options);
    if (hit !== undefined)
      return hit;
    return this._listAllPages("tools/list", params, options, (r) => r.tools, (acc) => this._excludeInvalidXMcpHeaderTools(acc));
  }
  _excludeInvalidXMcpHeaderTools(result) {
    if (this.getProtocolEra() !== "modern" || !this.transport || detectProbeTransportKind(this.transport) === "stdio")
      return;
    const filtered = result.tools.filter((tool) => {
      const scan = scanXMcpHeaderDeclarations(tool.inputSchema);
      if (!scan.valid) {
        console.warn(`[mcp-sdk] excluding tool '${tool.name}' from tools/list: invalid x-mcp-header declaration — ${scan.reason}`);
        return false;
      }
      return true;
    });
    if (filtered.length !== result.tools.length)
      result.tools = filtered;
  }
  _setupListChangedHandler(listType, notificationMethod, options, fetcher) {
    const parseResult = parseSchema(ListChangedOptionsBaseSchema, options);
    if (!parseResult.success)
      throw new Error(`Invalid ${listType} listChanged options: ${parseResult.error.message}`);
    if (typeof options.onChanged !== "function")
      throw new TypeError(`Invalid ${listType} listChanged options: onChanged must be a function`);
    const { autoRefresh, debounceMs } = parseResult.data;
    const { onChanged } = options;
    const refresh = async () => {
      if (!autoRefresh) {
        onChanged(null, null);
        return;
      }
      try {
        onChanged(null, await fetcher());
      } catch (error) {
        onChanged(error instanceof Error ? error : new Error(String(error)), null);
      }
    };
    const handler = () => {
      if (debounceMs) {
        const existingTimer = this._listChangedDebounceTimers.get(listType);
        if (existingTimer)
          clearTimeout(existingTimer);
        const timer = setTimeout(refresh, debounceMs);
        this._listChangedDebounceTimers.set(listType, timer);
      } else
        refresh();
    };
    this.setNotificationHandler(notificationMethod, handler);
  }
  async sendRootsListChanged() {
    return this.notification({ method: "notifications/roots/list_changed" });
  }
};

// ../../node_modules/.bun/eventsource-parser@3.1.1/node_modules/eventsource-parser/dist/index.js
class ParseError extends Error {
  constructor(message, options) {
    super(message), this.name = "ParseError", this.type = options.type, this.field = options.field, this.value = options.value, this.line = options.line;
  }
}
var LF = 10;
var CR = 13;
var SPACE = 32;
function noop(_arg) {}
function createParser(config) {
  if (typeof config == "function")
    throw new TypeError("`config` must be an object, got a function instead. Did you mean `createParser({onEvent: fn})`?");
  const { onEvent = noop, onError = noop, onRetry = noop, onComment, maxBufferSize } = config, pendingFragments = [];
  let pendingFragmentsLength = 0, isFirstChunk = true, id, data = "", dataLines = 0, eventType, terminated = false;
  function feed(chunk) {
    if (terminated)
      throw new Error("Cannot feed parser: it was terminated after exceeding the configured max buffer size. Call `reset()` to resume parsing.");
    if (isFirstChunk && (isFirstChunk = false, chunk.charCodeAt(0) === 239 && chunk.charCodeAt(1) === 187 && chunk.charCodeAt(2) === 191 && (chunk = chunk.slice(3))), pendingFragments.length === 0) {
      const trailing2 = processLines(chunk);
      trailing2 !== "" && (pendingFragments.push(trailing2), pendingFragmentsLength = trailing2.length), checkBufferSize();
      return;
    }
    if (chunk.indexOf(`
`) === -1 && chunk.indexOf("\r") === -1) {
      pendingFragments.push(chunk), pendingFragmentsLength += chunk.length, checkBufferSize();
      return;
    }
    pendingFragments.push(chunk);
    const input = pendingFragments.join("");
    pendingFragments.length = 0, pendingFragmentsLength = 0;
    const trailing = processLines(input);
    trailing !== "" && (pendingFragments.push(trailing), pendingFragmentsLength = trailing.length), checkBufferSize();
  }
  function checkBufferSize() {
    maxBufferSize !== undefined && (pendingFragmentsLength + data.length <= maxBufferSize || (terminated = true, pendingFragments.length = 0, pendingFragmentsLength = 0, id = undefined, data = "", dataLines = 0, eventType = undefined, onError(new ParseError(`Buffered data exceeded max buffer size of ${maxBufferSize} characters`, {
      type: "max-buffer-size-exceeded"
    }))));
  }
  function processLines(chunk) {
    let searchIndex = 0;
    if (chunk.indexOf("\r") === -1) {
      let lfIndex = chunk.indexOf(`
`, searchIndex);
      for (;lfIndex !== -1; ) {
        if (searchIndex === lfIndex) {
          dataLines > 0 && onEvent({ id, event: eventType, data }), id = undefined, data = "", dataLines = 0, eventType = undefined, searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
          continue;
        }
        const firstCharCode = chunk.charCodeAt(searchIndex);
        if (isDataPrefix(chunk, searchIndex, firstCharCode)) {
          const valueStart = chunk.charCodeAt(searchIndex + 5) === SPACE ? searchIndex + 6 : searchIndex + 5, value = chunk.slice(valueStart, lfIndex);
          if (dataLines === 0 && chunk.charCodeAt(lfIndex + 1) === LF) {
            onEvent({ id, event: eventType, data: value }), id = undefined, data = "", eventType = undefined, searchIndex = lfIndex + 2, lfIndex = chunk.indexOf(`
`, searchIndex);
            continue;
          }
          data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
        } else
          isEventPrefix(chunk, searchIndex, firstCharCode) ? eventType = chunk.slice(chunk.charCodeAt(searchIndex + 6) === SPACE ? searchIndex + 7 : searchIndex + 6, lfIndex) || undefined : parseLine(chunk, searchIndex, lfIndex);
        searchIndex = lfIndex + 1, lfIndex = chunk.indexOf(`
`, searchIndex);
      }
      return chunk.slice(searchIndex);
    }
    for (;searchIndex < chunk.length; ) {
      const crIndex = chunk.indexOf("\r", searchIndex), lfIndex = chunk.indexOf(`
`, searchIndex);
      let lineEnd = -1;
      if (crIndex !== -1 && lfIndex !== -1 ? lineEnd = crIndex < lfIndex ? crIndex : lfIndex : crIndex !== -1 ? crIndex === chunk.length - 1 ? lineEnd = -1 : lineEnd = crIndex : lfIndex !== -1 && (lineEnd = lfIndex), lineEnd === -1)
        break;
      parseLine(chunk, searchIndex, lineEnd), searchIndex = lineEnd + 1, chunk.charCodeAt(searchIndex - 1) === CR && chunk.charCodeAt(searchIndex) === LF && searchIndex++;
    }
    return chunk.slice(searchIndex);
  }
  function parseLine(chunk, start, end) {
    if (start === end) {
      dispatchEvent();
      return;
    }
    const firstCharCode = chunk.charCodeAt(start);
    if (isDataPrefix(chunk, start, firstCharCode)) {
      const valueStart = chunk.charCodeAt(start + 5) === SPACE ? start + 6 : start + 5, value2 = chunk.slice(valueStart, end);
      data = dataLines === 0 ? value2 : `${data}
${value2}`, dataLines++;
      return;
    }
    if (isEventPrefix(chunk, start, firstCharCode)) {
      eventType = chunk.slice(chunk.charCodeAt(start + 6) === SPACE ? start + 7 : start + 6, end) || undefined;
      return;
    }
    if (firstCharCode === 105 && chunk.charCodeAt(start + 1) === 100 && chunk.charCodeAt(start + 2) === 58) {
      const value2 = chunk.slice(chunk.charCodeAt(start + 3) === SPACE ? start + 4 : start + 3, end);
      value2.includes("\x00") || (id = value2);
      return;
    }
    if (firstCharCode === 58) {
      if (onComment) {
        const line2 = chunk.slice(start, end);
        onComment(line2.slice(chunk.charCodeAt(start + 1) === SPACE ? 2 : 1));
      }
      return;
    }
    const line = chunk.slice(start, end), fieldSeparatorIndex = line.indexOf(":");
    if (fieldSeparatorIndex === -1) {
      processField(line, "", line);
      return;
    }
    const field = line.slice(0, fieldSeparatorIndex), offset = line.charCodeAt(fieldSeparatorIndex + 1) === SPACE ? 2 : 1, value = line.slice(fieldSeparatorIndex + offset);
    processField(field, value, line);
  }
  function processField(field, value, line) {
    switch (field) {
      case "event":
        eventType = value || undefined;
        break;
      case "data":
        data = dataLines === 0 ? value : `${data}
${value}`, dataLines++;
        break;
      case "id":
        value.includes("\x00") || (id = value);
        break;
      case "retry":
        /^\d+$/.test(value) ? onRetry(parseInt(value, 10)) : onError(new ParseError(`Invalid \`retry\` value: "${value}"`, {
          type: "invalid-retry",
          value,
          line
        }));
        break;
      default:
        onError(new ParseError(`Unknown field "${field.length > 20 ? `${field.slice(0, 20)}…` : field}"`, { type: "unknown-field", field, value, line }));
        break;
    }
  }
  function dispatchEvent() {
    dataLines > 0 && onEvent({
      id,
      event: eventType,
      data
    }), id = undefined, data = "", dataLines = 0, eventType = undefined;
  }
  function reset(options = {}) {
    if (options.consume && pendingFragments.length > 0) {
      const incompleteLine = pendingFragments.join("");
      parseLine(incompleteLine, 0, incompleteLine.length);
    }
    isFirstChunk = true, id = undefined, data = "", dataLines = 0, eventType = undefined, pendingFragments.length = 0, pendingFragmentsLength = 0, terminated = false;
  }
  return { feed, reset };
}
function isDataPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 100 && chunk.charCodeAt(i + 1) === 97 && chunk.charCodeAt(i + 2) === 116 && chunk.charCodeAt(i + 3) === 97 && chunk.charCodeAt(i + 4) === 58;
}
function isEventPrefix(chunk, i, firstCharCode) {
  return firstCharCode === 101 && chunk.charCodeAt(i + 1) === 118 && chunk.charCodeAt(i + 2) === 101 && chunk.charCodeAt(i + 3) === 110 && chunk.charCodeAt(i + 4) === 116 && chunk.charCodeAt(i + 5) === 58;
}

// ../../node_modules/.bun/eventsource-parser@3.1.1/node_modules/eventsource-parser/dist/stream.js
class EventSourceParserStream extends TransformStream {
  constructor({ onError, onRetry, onComment, maxBufferSize } = {}) {
    let parser;
    super({
      start(controller) {
        parser = createParser({
          onEvent: (event) => {
            controller.enqueue(event);
          },
          onError(error) {
            typeof onError == "function" && onError(error), (onError === "terminate" || error.type === "max-buffer-size-exceeded") && controller.error(error);
          },
          onRetry,
          onComment,
          maxBufferSize
        });
      },
      transform(chunk) {
        parser.feed(chunk);
      }
    });
  }
}

// ../../node_modules/.bun/@modelcontextprotocol+client@2.4.0/node_modules/@modelcontextprotocol/client/dist/index.mjs
function hasDpopChallenge(wwwAuthenticate) {
  return /(?:^|,)\s*dpop(?:\s|$|,)/i.test(wwwAuthenticate);
}
function isDpopNonceChallenge(response) {
  if (response.status !== 401)
    return false;
  const wwwAuthenticate = response.headers.get("www-authenticate") ?? "";
  return hasDpopChallenge(wwwAuthenticate) && /use_dpop_nonce/i.test(wwwAuthenticate);
}
var withDpop = (session, getToken) => (next) => {
  const resolveSession = typeof session === "function" ? session : () => session;
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input.toString());
    const activeSession = await resolveSession();
    if (!activeSession)
      return next(input, init);
    const makeRequest = async () => {
      const accessToken = await getToken();
      if (!accessToken)
        return next(input, init);
      const headers = new Headers(init?.headers);
      const proof = await activeSession.buildProof({
        htm: method,
        htu: url,
        accessToken
      });
      headers.set("Authorization", `DPoP ${accessToken}`);
      headers.set("DPoP", proof);
      return next(input, {
        ...init,
        headers
      });
    };
    let response = await makeRequest();
    if (isDpopNonceChallenge(response) && response.headers.has("dpop-nonce")) {
      activeSession.observeNonce(response, url);
      await response.text?.().catch(() => {});
      response = await makeRequest();
    }
    activeSession.observeNonce(response, url);
    return response;
  };
};
var withDpopFromProvider = (provider) => withDpop(async () => {
  try {
    return await provider.dpop?.();
  } catch (error) {
    throw markAuthSeamEscape(error);
  }
}, async () => {
  let tokens;
  try {
    tokens = await provider.tokens();
  } catch (error) {
    throw markAuthSeamEscape(error);
  }
  return tokens?.token_type?.toLowerCase() === "dpop" ? tokens.access_token : undefined;
});
var SseError = class extends Error {
  static {
    Object.defineProperty(this, "mcpBrand", { value: "mcp.SseError" });
  }
  static [Symbol.hasInstance](value) {
    return brandedHasInstance(this, value);
  }
  static isInstance(value) {
    if (typeof this !== "function")
      throw new TypeError("isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`");
    return brandedHasInstance(this, value);
  }
  constructor(code, message, event) {
    super(`SSE error: ${message}`);
    this.code = code;
    this.event = event;
    stampErrorBrands(this, new.target);
  }
};
var DEFAULT_MAX_STEP_UP_RETRIES = 1;
var DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS = {
  initialReconnectionDelay: 1000,
  maxReconnectionDelay: 30000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 2
};
var RESERVED_REQUEST_HEADER_NAMES = new Set([
  "authorization",
  "dpop",
  "content-type",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id"
]);
function anySignal(a, b) {
  if (typeof AbortSignal.any === "function")
    return AbortSignal.any([a, b]);
  const controller = new AbortController;
  if (a.aborted)
    return controller.abort(a.reason), controller.signal;
  if (b.aborted)
    return controller.abort(b.reason), controller.signal;
  const cleanup = () => {
    a.removeEventListener("abort", onA);
    b.removeEventListener("abort", onB);
  };
  function onA() {
    cleanup();
    controller.abort(a.reason);
  }
  function onB() {
    cleanup();
    controller.abort(b.reason);
  }
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return controller.signal;
}
var StreamableHTTPClientTransport = class {
  _abortController;
  _url;
  _resourceMetadataUrl;
  _scope;
  _requestInit;
  _authProvider;
  _oauthProvider;
  _skipIssuerMetadataValidation;
  _fetch;
  _fetchWithInit;
  _redirectPolicy;
  _sessionId;
  _reconnectionOptions;
  _protocolVersion;
  _onInsufficientScope;
  _maxStepUpRetries;
  _serverRetryMs;
  _reconnectionScheduler;
  _cancelReconnection;
  onclose;
  onerror;
  onmessage;
  hasPerRequestStream = true;
  constructor(url, opts) {
    this._url = url;
    this._resourceMetadataUrl = undefined;
    this._scope = undefined;
    this._requestInit = opts?.requestInit;
    this._skipIssuerMetadataValidation = opts?.skipIssuerMetadataValidation;
    this._fetch = opts?.fetch;
    if (isOAuthClientProvider(opts?.authProvider)) {
      this._oauthProvider = opts.authProvider;
      this._authProvider = adaptOAuthProvider(opts.authProvider, { skipIssuerMetadataValidation: opts.skipIssuerMetadataValidation });
      if (opts.authProvider.dpop)
        this._fetch = withDpopFromProvider(opts.authProvider)(opts.fetch ?? fetch);
    } else
      this._authProvider = opts?.authProvider;
    this._redirectPolicy = opts?.redirectPolicy;
    this._fetchWithInit = createFetchWithInit(opts?.fetch, opts?.requestInit);
    if (this._redirectPolicy === "follow")
      this._fetchWithInit = fetchLeavingRedirects(this._fetchWithInit);
    this._sessionId = opts?.sessionId;
    this._protocolVersion = opts?.protocolVersion;
    this._reconnectionOptions = opts?.reconnectionOptions ?? DEFAULT_STREAMABLE_HTTP_RECONNECTION_OPTIONS;
    this._reconnectionScheduler = opts?.reconnectionScheduler;
    this._onInsufficientScope = opts?.onInsufficientScope ?? "reauthorize";
    this._maxStepUpRetries = Math.max(0, opts?.maxStepUpRetries ?? DEFAULT_MAX_STEP_UP_RETRIES);
  }
  async _stepUpAuthorize(challenge, stepUpRetries) {
    try {
      return await this._stepUpAuthorizeInner(challenge, stepUpRetries);
    } catch (error) {
      throw markAuthSeamEscape(error);
    }
  }
  async _stepUpAuthorizeInner(challenge, stepUpRetries) {
    if (this._onInsufficientScope === "throw")
      throw new InsufficientScopeError({
        requiredScope: challenge.scope,
        resourceMetadataUrl: challenge.resourceMetadataUrl,
        errorDescription: challenge.errorDescription
      });
    if (!this._oauthProvider)
      throw new InsufficientScopeError({
        requiredScope: challenge.scope,
        resourceMetadataUrl: challenge.resourceMetadataUrl,
        errorDescription: challenge.errorDescription
      });
    if (stepUpRetries >= this._maxStepUpRetries)
      throw new SdkHttpError(SdkErrorCode.ClientHttpForbidden, `Server returned 403 insufficient_scope after step-up re-authorization (retry limit ${this._maxStepUpRetries} reached)`, {
        status: 403,
        statusText: challenge.statusText ?? "Forbidden",
        text: challenge.text
      });
    if (challenge.resourceMetadataUrl)
      this._resourceMetadataUrl = challenge.resourceMetadataUrl;
    const tokens = await this._oauthProvider.tokens();
    const unionScope = computeScopeUnion(this._scope, tokens?.scope, challenge.scope);
    this._scope = unionScope;
    const forceReauthorization = isStrictScopeSuperset(unionScope, tokens?.scope);
    return auth(this._oauthProvider, {
      serverUrl: this._url,
      resourceMetadataUrl: this._resourceMetadataUrl,
      scope: unionScope,
      forceReauthorization,
      fetchFn: this._fetchWithInit,
      skipIssuerMetadataValidation: this._skipIssuerMetadataValidation
    });
  }
  _redirects(baseFetch) {
    return this._redirectPolicy === "follow" ? baseFetch : fetchWithinOrigin(baseFetch);
  }
  _unfollowedRedirect(url, response) {
    const text = this._redirectPolicy === "follow" ? undefined : unfollowedRedirect(url, response);
    return text && `${text} (redirectPolicy: 'same-origin')`;
  }
  async _commonHeaders() {
    const headers = new Headers(this._requestInit?.headers || undefined);
    let token;
    try {
      token = await this._authProvider?.token();
    } catch (error) {
      throw markAuthSeamEscape(error);
    }
    if (token)
      headers.set("Authorization", `Bearer ${token}`);
    if (this._sessionId)
      headers.set("mcp-session-id", this._sessionId);
    if (this._protocolVersion)
      headers.set("mcp-protocol-version", this._protocolVersion);
    return headers;
  }
  _applyBodyDerivedHeaders(headers, message) {
    if (Array.isArray(message) || !isJSONRPCRequest(message))
      return;
    const envelopeVersion = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
    if (typeof envelopeVersion !== "string")
      return;
    headers.set("mcp-protocol-version", envelopeVersion);
    headers.set("mcp-method", message.method);
    const source = mcpNameSource(message.method, message.params);
    if (source?.value !== undefined)
      headers.set("mcp-name", encodeMcpParamValue(source.value));
  }
  _isModernEnvelopedRequest(message) {
    if (Array.isArray(message) || !isJSONRPCRequest(message))
      return false;
    const v = message.params?._meta?.[PROTOCOL_VERSION_META_KEY];
    return typeof v === "string" && isModernProtocolVersion(v);
  }
  async _startOrAuthSse(options, isAuthRetry = false, stepUpRetries = 0) {
    const { resumptionToken, requestSignal } = options;
    const isIntentionalAbort = () => this._abortController?.signal.aborted === true || requestSignal?.aborted === true;
    try {
      const headers = await this._commonHeaders();
      const types = [...headers.get("accept")?.split(",").map((s) => s.trim().toLowerCase()) ?? [], "text/event-stream"];
      headers.set("accept", [...new Set(types)].join(", "));
      if (resumptionToken)
        headers.set("last-event-id", resumptionToken);
      const transportSignal = this._abortController?.signal;
      const signal = requestSignal !== undefined && transportSignal !== undefined ? anySignal(transportSignal, requestSignal) : requestSignal ?? transportSignal;
      const response = await this._redirects(this._fetch ?? fetch)(this._url, {
        ...this._requestInit,
        method: "GET",
        headers,
        signal
      });
      if (!response.ok) {
        if (response.status === 401 && this._authProvider) {
          if (response.headers.has("www-authenticate")) {
            const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
            this._resourceMetadataUrl = resourceMetadataUrl;
            this._scope = computeScopeUnion(this._scope, scope);
          }
          if (this._authProvider.onUnauthorized && !isAuthRetry) {
            try {
              await this._authProvider.onUnauthorized({
                response,
                serverUrl: this._url,
                fetchFn: this._fetchWithInit
              });
            } catch (error) {
              throw markAuthSeamEscape(error);
            }
            await response.text?.().catch(() => {});
            return this._startOrAuthSse(options, true, stepUpRetries);
          }
          await response.text?.().catch(() => {});
          if (isAuthRetry)
            throw markAuthSeamEscape(new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "Server returned 401 after re-authentication", {
              status: 401,
              statusText: response.statusText
            }));
          throw markAuthSeamEscape(new UnauthorizedError);
        }
        if (response.status === 403) {
          const { resourceMetadataUrl, scope, error, errorDescription } = extractWWWAuthenticateParams(response);
          if (error === "insufficient_scope") {
            const text = await response.text?.().catch(() => null);
            if (await this._stepUpAuthorize({
              scope,
              resourceMetadataUrl,
              errorDescription,
              statusText: response.statusText,
              text
            }, stepUpRetries) !== "AUTHORIZED")
              throw markAuthSeamEscape(new UnauthorizedError);
            return this._startOrAuthSse(options, isAuthRetry, stepUpRetries + 1);
          }
        }
        await response.text?.().catch(() => {});
        if (response.status === 405) {
          options.onRequestStreamEnd?.();
          return;
        }
        const reason = this._unfollowedRedirect(this._url, response) ?? response.statusText;
        throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, `Failed to open SSE stream: ${reason}`, {
          status: response.status,
          statusText: response.statusText
        });
      }
      this._handleSseStream(response.body, options, true);
    } catch (error) {
      if (!isIntentionalAbort())
        this.onerror?.(error);
      throw error;
    }
  }
  _getNextReconnectionDelay(attempt) {
    if (this._serverRetryMs !== undefined)
      return this._serverRetryMs;
    const initialDelay = this._reconnectionOptions.initialReconnectionDelay;
    const growFactor = this._reconnectionOptions.reconnectionDelayGrowFactor;
    const maxDelay = this._reconnectionOptions.maxReconnectionDelay;
    return Math.min(initialDelay * Math.pow(growFactor, attempt), maxDelay);
  }
  _scheduleReconnection(options, attemptCount = 0) {
    const maxRetries = this._reconnectionOptions.maxRetries;
    if (attemptCount >= maxRetries) {
      this.onerror?.(/* @__PURE__ */ new Error(`Maximum reconnection attempts (${maxRetries}) exceeded.`));
      options.onRequestStreamEnd?.();
      return;
    }
    const delay = this._getNextReconnectionDelay(attemptCount);
    const reconnect = () => {
      this._cancelReconnection = undefined;
      if (this._abortController?.signal.aborted || options.requestSignal?.aborted)
        return;
      this._startOrAuthSse(options).catch((error) => {
        if (this._abortController?.signal.aborted || options.requestSignal?.aborted)
          return;
        this.onerror?.(/* @__PURE__ */ new Error(`Failed to reconnect SSE stream: ${error instanceof Error ? error.message : String(error)}`));
        try {
          this._scheduleReconnection(options, attemptCount + 1);
        } catch (scheduleError) {
          this.onerror?.(scheduleError instanceof Error ? scheduleError : new Error(String(scheduleError)));
        }
      });
    };
    if (this._reconnectionScheduler) {
      const cancel = this._reconnectionScheduler(reconnect, delay, attemptCount);
      this._cancelReconnection = typeof cancel === "function" ? cancel : undefined;
    } else {
      const handle = setTimeout(reconnect, delay);
      this._cancelReconnection = () => clearTimeout(handle);
    }
  }
  _handleSseStream(stream, options, isReconnectable) {
    if (!stream) {
      options.onRequestStreamEnd?.();
      return;
    }
    const { onresumptiontoken, replayMessageId, requestSignal, onRequestStreamEnd } = options;
    const isIntentionalAbort = () => this._abortController?.signal.aborted === true || requestSignal?.aborted === true;
    let lastEventId;
    let hasPrimingEvent = false;
    let receivedResponse = false;
    const processStream = async () => {
      try {
        const reader = stream.pipeThrough(new TextDecoderStream).pipeThrough(new EventSourceParserStream({ onRetry: (retryMs) => {
          this._serverRetryMs = retryMs;
        } })).getReader();
        while (true) {
          const { value: event, done } = await reader.read();
          if (done)
            break;
          if (event.id) {
            lastEventId = event.id;
            hasPrimingEvent = true;
            onresumptiontoken?.(event.id);
          }
          if (!event.data)
            continue;
          if (!event.event || event.event === "message")
            try {
              const message = JSONRPCMessageSchema.parse(JSON.parse(event.data));
              if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
                receivedResponse = true;
                if (replayMessageId !== undefined)
                  message.id = replayMessageId;
              }
              this.onmessage?.(message);
            } catch (error) {
              this.onerror?.(error);
            }
        }
        if ((isReconnectable || hasPrimingEvent) && !receivedResponse && this._abortController && !isIntentionalAbort())
          this._scheduleReconnection({
            resumptionToken: lastEventId,
            onresumptiontoken,
            replayMessageId,
            requestSignal,
            onRequestStreamEnd
          }, 0);
        else if (!isIntentionalAbort())
          onRequestStreamEnd?.();
      } catch (error) {
        if (isIntentionalAbort())
          return;
        this.onerror?.(/* @__PURE__ */ new Error(`SSE stream disconnected: ${error}`));
        if ((isReconnectable || hasPrimingEvent) && !receivedResponse && this._abortController && !isIntentionalAbort())
          try {
            this._scheduleReconnection({
              resumptionToken: lastEventId,
              onresumptiontoken,
              replayMessageId,
              requestSignal,
              onRequestStreamEnd
            }, 0);
          } catch (error$1) {
            this.onerror?.(/* @__PURE__ */ new Error(`Failed to reconnect: ${error$1 instanceof Error ? error$1.message : String(error$1)}`));
            onRequestStreamEnd?.();
          }
        else
          onRequestStreamEnd?.();
      }
    };
    processStream();
  }
  async start() {
    if (this._abortController)
      throw new Error("StreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.");
    this._abortController = new AbortController;
  }
  async finishAuth(codeOrParams, iss) {
    if (!this._oauthProvider)
      throw new UnauthorizedError("finishAuth requires an OAuthClientProvider");
    const { authorizationCode, iss: issParam } = await resolveAuthorizationCallbackParams(codeOrParams, iss, this._oauthProvider, this._url, {
      fetchFn: this._fetchWithInit,
      resourceMetadataUrl: this._resourceMetadataUrl
    });
    if (await auth(this._oauthProvider, {
      serverUrl: this._url,
      authorizationCode,
      iss: issParam,
      resourceMetadataUrl: this._resourceMetadataUrl,
      scope: this._scope,
      fetchFn: this._fetchWithInit,
      skipIssuerMetadataValidation: this._skipIssuerMetadataValidation
    }) !== "AUTHORIZED")
      throw new UnauthorizedError("Failed to authorize");
  }
  async close() {
    try {
      this._cancelReconnection?.();
    } finally {
      this._cancelReconnection = undefined;
      this._abortController?.abort();
      this.onclose?.();
    }
  }
  async send(message, options) {
    return this._send(message, options, false);
  }
  async _send(message, options, isAuthRetry, stepUpRetries = 0) {
    try {
      const { resumptionToken, onresumptiontoken } = options || {};
      if (resumptionToken) {
        this._startOrAuthSse({
          resumptionToken,
          replayMessageId: isJSONRPCRequest(message) ? message.id : undefined,
          requestSignal: options?.requestSignal
        }).catch((error) => this.onerror?.(error));
        return;
      }
      const headers = await this._commonHeaders();
      this._applyBodyDerivedHeaders(headers, message);
      const isHandshake = Array.isArray(message) ? message.some((m) => isInitializeRequest(m)) : isInitializeRequest(message);
      if (isHandshake)
        headers.delete("mcp-session-id");
      if (options?.headers !== undefined)
        for (const [name, value] of Object.entries(options.headers)) {
          if (RESERVED_REQUEST_HEADER_NAMES.has(name.toLowerCase()))
            continue;
          headers.set(name, value);
        }
      headers.set("content-type", "application/json");
      const types = [
        ...headers.get("accept")?.split(",").map((s) => s.trim().toLowerCase()) ?? [],
        "application/json",
        "text/event-stream"
      ];
      headers.set("accept", [...new Set(types)].join(", "));
      const transportSignal = this._abortController?.signal;
      const signal = options?.requestSignal !== undefined && transportSignal !== undefined ? anySignal(transportSignal, options.requestSignal) : options?.requestSignal ?? transportSignal;
      const init = {
        ...this._requestInit,
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal
      };
      const response = await this._redirects(this._fetch ?? fetch)(this._url, init);
      if (isHandshake && response.ok)
        this._sessionId = response.headers.get("mcp-session-id") || undefined;
      if (!response.ok) {
        if (response.status === 401 && this._authProvider) {
          if (response.headers.has("www-authenticate")) {
            const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
            this._resourceMetadataUrl = resourceMetadataUrl;
            this._scope = computeScopeUnion(this._scope, scope);
          }
          if (this._authProvider.onUnauthorized && !isAuthRetry) {
            try {
              await this._authProvider.onUnauthorized({
                response,
                serverUrl: this._url,
                fetchFn: this._fetchWithInit
              });
            } catch (error) {
              throw markAuthSeamEscape(error);
            }
            await response.text?.().catch(() => {});
            return this._send(message, options, true, stepUpRetries);
          }
          await response.text?.().catch(() => {});
          if (isAuthRetry)
            throw markAuthSeamEscape(new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, "Server returned 401 after re-authentication", {
              status: 401,
              statusText: response.statusText
            }));
          throw markAuthSeamEscape(new UnauthorizedError);
        }
        const text = await response.text?.().catch(() => null);
        if (response.status === 403) {
          const { resourceMetadataUrl, scope, error, errorDescription } = extractWWWAuthenticateParams(response);
          if (error === "insufficient_scope") {
            if (await this._stepUpAuthorize({
              scope,
              resourceMetadataUrl,
              errorDescription,
              statusText: response.statusText,
              text
            }, stepUpRetries) !== "AUTHORIZED")
              throw markAuthSeamEscape(new UnauthorizedError);
            return this._send(message, options, isAuthRetry, stepUpRetries + 1);
          }
        }
        if (response.status === 400 && typeof text === "string" && this._isModernEnvelopedRequest(message))
          try {
            const parsed = JSONRPCMessageSchema.parse(JSON.parse(text));
            const requests = (Array.isArray(message) ? message : [message]).filter((m) => isJSONRPCRequest(m));
            if (isJSONRPCErrorResponse(parsed) && requests.some((r) => r.id === parsed.id)) {
              this.onmessage?.(parsed);
              return;
            }
          } catch {}
        const reason = this._unfollowedRedirect(this._url, response) ?? text;
        throw new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${reason}`, {
          status: response.status,
          statusText: response.statusText,
          text
        });
      }
      if (response.status === 202) {
        await response.text?.().catch(() => {});
        if (isInitializedNotification(message))
          this._startOrAuthSse({ resumptionToken: undefined }).catch((error) => this.onerror?.(error));
        return;
      }
      const hasRequests = (Array.isArray(message) ? message : [message]).some((msg) => ("method" in msg) && ("id" in msg) && msg.id !== undefined);
      const contentType = response.headers.get("content-type");
      const responseMediaType = mediaTypeEssence(contentType);
      if (hasRequests)
        if (responseMediaType === "text/event-stream")
          this._handleSseStream(response.body, {
            onresumptiontoken,
            requestSignal: options?.requestSignal,
            onRequestStreamEnd: options?.onRequestStreamEnd
          }, false);
        else if (responseMediaType === "application/json") {
          const data = await response.json();
          const responseMessages = Array.isArray(data) ? data.map((msg) => JSONRPCMessageSchema.parse(msg)) : [JSONRPCMessageSchema.parse(data)];
          for (const msg of responseMessages)
            this.onmessage?.(msg);
        } else {
          await response.text?.().catch(() => {});
          throw new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, `Unexpected content type: ${contentType}`, { contentType });
        }
      else
        await response.text?.().catch(() => {});
    } catch (error) {
      if (options?.requestSignal?.aborted !== true)
        this.onerror?.(error);
      throw error;
    }
  }
  get sessionId() {
    return this._sessionId;
  }
  async terminateSession() {
    if (!this._sessionId)
      return;
    try {
      const headers = await this._commonHeaders();
      const init = {
        ...this._requestInit,
        method: "DELETE",
        headers,
        signal: this._abortController?.signal
      };
      const response = await this._redirects(this._fetch ?? fetch)(this._url, init);
      await response.text?.().catch(() => {});
      if (!response.ok && response.status !== 405)
        throw new SdkHttpError(SdkErrorCode.ClientHttpFailedToTerminateSession, `Failed to terminate session: ${this._unfollowedRedirect(this._url, response) ?? response.statusText}`, {
          status: response.status,
          statusText: response.statusText
        });
      this._sessionId = undefined;
    } catch (error) {
      this.onerror?.(error);
      throw error;
    }
  }
  setProtocolVersion(version) {
    this._protocolVersion = version;
  }
  get protocolVersion() {
    return this._protocolVersion;
  }
  async resumeStream(lastEventId, options) {
    await this._startOrAuthSse({
      resumptionToken: lastEventId,
      onresumptiontoken: options?.onresumptiontoken
    });
  }
};

// src/errors.ts
class Refusal extends Error {
  name = "Refusal";
}

class ApiFailure extends Error {
  name = "ApiFailure";
  code;
  retryable;
  details;
  constructor(code, message, retryable, details) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

// src/config.ts
var SETUP_STEPS = [
  "Set these in the environment pi runs in (fill the token from Keychain or 1Password, not a dotfile):",
  "  CLOUDPID_URL=https://<your cloudpid host>/mcp",
  "  CLOUDPID_ACCESS_CLIENT_ID=<the Local agent's client ID>",
  "  CLOUDPID_ACCESS_CLIENT_SECRET=<its secret>",
  "From a cloudpid checkout, `bun run --cwd infra local-agent-token --stage <stage>` prints the last two. The extension's README has the rest."
].join(`
`);
var LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
var endpointUrl = (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Refusal(`CLOUDPID_URL is not a URL: ${raw}
${SETUP_STEPS}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new Refusal(`CLOUDPID_URL must be an https URL (${raw}).
${SETUP_STEPS}`);
  }
  if (url.pathname === "/" || url.pathname === "")
    url.pathname = "/mcp";
  return url;
};
var readConfig = (env) => {
  const url = env["CLOUDPID_URL"]?.trim() ?? "";
  const clientId = env["CLOUDPID_ACCESS_CLIENT_ID"]?.trim() ?? "";
  const clientSecret = env["CLOUDPID_ACCESS_CLIENT_SECRET"]?.trim() ?? "";
  const missing = [
    ["CLOUDPID_URL", url],
    ["CLOUDPID_ACCESS_CLIENT_ID", clientId],
    ["CLOUDPID_ACCESS_CLIENT_SECRET", clientSecret]
  ].flatMap(([name = "", value = ""]) => value === "" ? [name] : []);
  if (missing.length > 0) {
    throw new Refusal(`/cloudpid is not set up: ${missing.join(", ")} not set.
${SETUP_STEPS}`);
  }
  return { url: endpointUrl(url), clientId, clientSecret };
};
var BUILD_SHA = "44f38ec93b79d9b8f5e503cb599848695e146dff";
var clientName = (sha = BUILD_SHA) => `pi-cloudpid/${sha.slice(0, 12)}`;

// src/constants.ts
var PI_SESSION_FORMAT = "pi-session-jsonl";
var MAX_SLICE_BYTES = 2 * 1024 * 1024;
var MAX_IMPORT_BYTES = 64 * 1024 * 1024;
var MAX_TITLE_LENGTH = 200;
var IMPORT_MARKER = "cloudpid-import";
var REQUIRED_TOOLS = [
  "environments_list",
  "session_import_begin",
  "session_import_append",
  "session_import_finish",
  "session_import_cancel"
];
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// ../../../../../.bun/install/cache/links/effect@4.0.6-af8bd1bb894346aa/node_modules/effect/dist/Predicate.js
function isString(input) {
  return typeof input === "string";
}
function isNumber(input) {
  return typeof input === "number";
}
function isBoolean(input) {
  return typeof input === "boolean";
}
function isObject2(input) {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

// src/json.ts
var isJson = (value) => value === null || isString(value) || isNumber(value) || isBoolean(value) || Array.isArray(value) && value.every(isJson) || isObject2(value) && Object.values(value).every(isJson);
var isJsonObject2 = (value) => value !== undefined && value !== null && isObject2(value);
var toObject = (value) => isJsonObject2(value) ? value : undefined;
var stringField = (fields, key) => {
  const value = fields[key];
  return isString(value) ? value : undefined;
};
var integerField = (fields, key) => {
  const value = fields[key];
  return isNumber(value) && Number.isInteger(value) ? value : undefined;
};
var objectField = (fields, key) => toObject(fields[key]);
var objectsField = (fields, key) => {
  const value = fields[key];
  const found = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const object = toObject(item);
      if (object !== undefined)
        found.push(object);
    }
  }
  return found;
};
var stringsField = (fields, key) => {
  const value = fields[key];
  return Array.isArray(value) ? value.filter(isString) : [];
};

// src/endpoint.ts
var TOKEN_REJECTED = "service token rejected or expired: run `local-agent-token` (`bun run --cwd infra local-agent-token --stage <stage>` in a cloudpid checkout) and update CLOUDPID_ACCESS_CLIENT_ID and CLOUDPID_ACCESS_CLIENT_SECRET.";
var ENDPOINT_OLDER = "the endpoint is older than this extension";
var statusOf = (error) => {
  for (let at = error, depth = 0;at !== undefined && depth < 8; depth += 1) {
    if (at instanceof SdkHttpError)
      return at.status;
    if (at instanceof UnauthorizedError)
      return 401;
    at = at.cause instanceof Error ? at.cause : undefined;
  }
  return;
};
var isRejected = (status) => status === 401 || status === 403 || status !== undefined && status >= 300 && status < 400;
var sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var MAX_WAIT_MS = 60000;
var MAX_RETRIES = 3;
var waitFor = (failure, attempt) => {
  const given = failure.details === undefined ? undefined : integerField(failure.details, "retry_after_s");
  return Math.min(MAX_WAIT_MS, given === undefined ? 1000 * attempt : given * 1000);
};
var failureOf = (name, text, structured) => {
  const error = structured === undefined ? undefined : objectField(structured, "error");
  if (error === undefined) {
    return new ApiFailure("unavailable", text === "" ? `${name} failed.` : text, true);
  }
  const details = objectField(error, "details");
  return new ApiFailure(stringField(error, "code") ?? "unavailable", stringField(error, "message") ?? text, error["retryable"] === true, details);
};
var receivedOf = (failure) => failure.code === "offset_mismatch" && failure.details !== undefined ? integerField(failure.details, "received") : undefined;
var branchTakenOf = (failure) => {
  if (failure.code !== "branch_taken" || failure.details === undefined)
    return;
  return {
    sessions: objectsField(failure.details, "sessions").map((session) => ({
      id: stringField(session, "id") ?? "",
      url: stringField(session, "url") ?? "",
      title: stringField(session, "title") ?? "",
      status: stringField(session, "status") ?? ""
    }))
  };
};
var malformed = (tool) => new ApiFailure("unavailable", `${tool} answered something this extension cannot read.`, false);
var summaryOf = (fields) => {
  if (fields === undefined)
    return;
  const dropped = objectField(fields, "dropped") ?? {};
  return {
    cut: integerField(fields, "cut") ?? 0,
    closed: integerField(fields, "closed") ?? 0,
    dropped: Object.keys(dropped).flatMap((kind) => {
      const count = integerField(dropped, kind);
      return count === undefined ? [] : [[kind, count]];
    })
  };
};
var noValidation = {
  getValidator: () => (input) => ({
    valid: true,
    data: input,
    errorMessage: undefined
  })
};
var connectEndpoint = async (config, options = {}) => {
  const sleep = options.sleep ?? sleepFor;
  const name = options.client ?? clientName();
  const requestInit = {
    headers: {
      "CF-Access-Client-Id": config.clientId,
      "CF-Access-Client-Secret": config.clientSecret,
      "X-Cloudpid-Client": name
    },
    redirect: "manual"
  };
  const transportOptions = {
    requestInit,
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1
    }
  };
  if (options.fetch !== undefined)
    transportOptions.fetch = options.fetch;
  const transport = new StreamableHTTPClientTransport(config.url, transportOptions);
  const client = new Client({ name: "pi-cloudpid", version: name.slice("pi-cloudpid/".length) }, {
    jsonSchemaValidator: noValidation
  });
  const transportFailure = (error) => isRejected(statusOf(error)) ? new Refusal(TOKEN_REJECTED) : error;
  let finishTakesChangesCarried = false;
  try {
    await client.connect(transport);
    const names = new Set;
    for (let cursor;; ) {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      for (const tool of page.tools) {
        names.add(tool.name);
        if (tool.name === "session_import_finish") {
          finishTakesChangesCarried = tool.inputSchema.properties?.["changes_carried"] !== undefined;
        }
      }
      cursor = page.nextCursor;
      if (cursor === undefined)
        break;
    }
    if (REQUIRED_TOOLS.some((tool) => !names.has(tool))) {
      throw new Refusal(`${ENDPOINT_OLDER}: it does not serve ${REQUIRED_TOOLS.filter((tool) => !names.has(tool)).join(", ")}. Deploy cloudpid, or run \`pi update\` only after its deploy.`);
    }
  } catch (error) {
    await client.close().catch(() => {
      return;
    });
    if (error instanceof Refusal)
      throw error;
    throw error instanceof Error ? transportFailure(error) : error;
  }
  const call = async (tool, args) => {
    for (let attempt = 1;; attempt += 1) {
      try {
        const result = await client.callTool({ name: tool, arguments: { ...args } });
        const structured = toObject(isJson(result.structuredContent) ? result.structuredContent : undefined);
        if (result.isError === true) {
          const text = result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(`
`);
          throw failureOf(tool, text, structured);
        }
        if (structured === undefined)
          throw malformed(tool);
        return structured;
      } catch (error) {
        if (error instanceof ApiFailure) {
          if (error.retryable && attempt <= MAX_RETRIES && isRetryable(tool)) {
            await sleep(waitFor(error, attempt));
            continue;
          }
          throw error;
        }
        throw error instanceof Error ? transportFailure(error) : error;
      }
    }
  };
  return {
    environments: async () => {
      const result = await call("environments_list", {});
      return objectsField(result, "environments").flatMap((environment) => {
        const id = stringField(environment, "id");
        const environmentName = stringField(environment, "name");
        if (id === undefined || environmentName === undefined)
          return [];
        return [
          {
            id,
            name: environmentName,
            repos: objectsField(environment, "repos").flatMap((repo) => {
              const url = stringField(repo, "url");
              return url === undefined ? [] : [{ name: stringField(repo, "name") ?? "", url }];
            })
          }
        ];
      });
    },
    begin: async (input) => {
      const result = await call("session_import_begin", { ...input });
      const importId = stringField(result, "import_id");
      const url = stringField(result, "url");
      const carryRef = stringField(result, "carry_ref");
      if (importId === undefined || url === undefined || carryRef === undefined) {
        throw malformed("session_import_begin");
      }
      return {
        importId,
        sessionId: stringField(result, "session_id") ?? importId,
        url,
        received: integerField(result, "received") ?? 0,
        maxSliceBytes: integerField(result, "max_slice_bytes") ?? 0,
        carryRef
      };
    },
    append: async (importId, offset, data) => {
      const result = await call("session_import_append", { import_id: importId, offset, data });
      const received = integerField(result, "received");
      if (received === undefined)
        throw malformed("session_import_append");
      return received;
    },
    finish: async (importId, sha256, changesCarried) => {
      const args = { import_id: importId, sha256 };
      const result = await call("session_import_finish", finishTakesChangesCarried ? { ...args, changes_carried: changesCarried } : args);
      const url = stringField(result, "url");
      const status = stringField(result, "status");
      if (url === undefined || status === undefined)
        throw malformed("session_import_finish");
      return {
        sessionId: stringField(result, "session_id") ?? importId,
        status,
        url,
        summary: summaryOf(objectField(result, "summary")),
        warnings: stringsField(result, "warnings")
      };
    },
    cancel: async (importId) => {
      await call("session_import_cancel", { import_id: importId });
    },
    close: () => client.close()
  };
};
var isRetryable = (tool) => tool !== "session_import_begin";

// src/git.ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class GitError extends Error {
  name = "GitError";
}

class GitMissing extends Error {
  name = "GitMissing";
}
var gitIn = (cwd) => (args, options = {}) => new Promise((resolve, reject) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const child = spawn("git", [...args], {
    cwd,
    env: options.indexFile === undefined ? env : { ...env, GIT_INDEX_FILE: options.indexFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (chunk) => out.push(chunk));
  child.stderr.on("data", (chunk) => err.push(chunk));
  child.on("error", (error) => {
    reject(error.code === "ENOENT" ? new GitMissing(`could not run git in ${cwd}: it is not installed, or not on PATH`, {
      cause: error
    }) : error);
  });
  child.on("close", (code) => {
    resolve({
      code: code ?? 1,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8")
    });
  });
});
var NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
var read = async (git, args, options) => {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
};
var tryRead = async (git, args) => {
  const result = await git(args);
  return result.code === 0 ? result.stdout.trim() : undefined;
};
var checkoutOf = async (git) => {
  const root = await tryRead(git, ["rev-parse", "--show-toplevel"]);
  if (root === undefined || root === "")
    return;
  const origin = await tryRead(git, ["config", "--get", "remote.origin.url"]) ?? "";
  return { root, origin: origin === "" ? undefined : origin };
};
var expandedOriginOf = (git) => tryRead(git, ["remote", "get-url", "origin"]);
var headOf = async (git) => {
  const commit = await tryRead(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const branch = await tryRead(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch === undefined)
    return { commit, branch, upstream: undefined };
  const remote = await tryRead(git, ["config", "--get", `branch.${branch}.remote`]);
  const merge = await tryRead(git, ["config", "--get", `branch.${branch}.merge`]);
  const upstream = remote === "origin" && merge?.startsWith("refs/heads/") === true ? merge.slice("refs/heads/".length) : undefined;
  return { commit, branch, upstream };
};
var defaultBranchOf = async (git, head) => {
  const known = await tryRead(git, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD"
  ]);
  if (known?.startsWith("origin/") === true)
    return known.slice("origin/".length);
  const asked = await tryRead(git, ["ls-remote", "--symref", "origin", "HEAD"]);
  const match = asked === undefined ? null : /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked);
  if (match?.[1] !== undefined)
    return match[1];
  return head.branch === "main" || head.branch === "master" ? head.branch : undefined;
};
var branchNameProblem = async (git, name) => {
  if ((await git(["check-ref-format", "--branch", name])).code !== 0) {
    return `${name} is not a branch name git accepts`;
  }
  const taken = await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  return taken.code === 0 ? `a local branch ${name} exists already` : undefined;
};
var LISTED_COMMITS = 5;
var remoteTip = async (git, branch) => {
  const listing = await read(git, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
  return listing === "" ? undefined : listing.split(/\s+/)[0];
};
var planPush = async (git, head, branch) => {
  const remote = await remoteTip(git, branch);
  let range;
  if (remote === undefined) {
    range = ["HEAD", "--not", "--remotes=origin"];
  } else if (remote === head) {
    return { remote, commits: [], count: 0, behind: false };
  } else {
    if ((await git(["cat-file", "-e", `${remote}^{commit}`])).code !== 0) {
      await read(git, [...NO_HOOKS, "fetch", "--quiet", "origin", `refs/heads/${branch}`]);
    }
    if ((await git(["merge-base", "--is-ancestor", remote, head])).code !== 0) {
      return { remote, commits: [], count: 0, behind: true };
    }
    range = [`${remote}..HEAD`];
  }
  const count = Number(await read(git, ["rev-list", "--count", ...range]));
  const listed = await read(git, [
    "log",
    "--format=%h %s",
    `--max-count=${String(LISTED_COMMITS)}`,
    ...range
  ]);
  return { remote, commits: listed === "" ? [] : listed.split(`
`), count, behind: false };
};
var pushBranch = async (git, head, branch) => {
  const result = await git([
    ...NO_HOOKS,
    "push",
    "--quiet",
    "origin",
    `${head}:refs/heads/${branch}`
  ]);
  if (result.code === 0)
    return;
  const said = result.stderr.trim();
  throw new GitError(/non-fast-forward|fetch first/.test(said) ? `origin's ${branch} has commits this checkout lacks: pull first, then run /cloudpid again.` : `git push failed: ${said}`);
};
var readCarry = async (git, head) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloudpid-"));
  const indexFile = join(directory, "index");
  try {
    await read(git, ["read-tree", head], { indexFile });
    await read(git, ["add", "-A"], { indexFile });
    const tree = await read(git, ["write-tree"], { indexFile });
    if (tree === await read(git, ["rev-parse", `${head}^{tree}`]))
      return;
    const diff = await git(["diff-tree", "-r", "--no-renames", "--name-only", "-z", head, tree]);
    if (diff.code !== 0)
      throw new GitError(`git diff-tree failed: ${diff.stderr.trim()}`);
    return { tree, files: diff.stdout.split("\x00").filter((name) => name !== "") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
var commitCarry = async (git, carry, head, branch) => {
  const name = await tryRead(git, ["config", "user.name"]) ?? "cloudpid";
  const email = await tryRead(git, ["config", "user.email"]) ?? "cloudpid@users.noreply.github.com";
  return read(git, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit-tree",
    carry.tree,
    "-p",
    head,
    "-m",
    `cloudpid: uncommitted changes carried to ${branch}`
  ]);
};
var pushCarry = async (git, commit, ref) => {
  await read(git, [...NO_HOOKS, "push", "--quiet", "--force", "origin", `${commit}:${ref}`]);
};
var deleteRemoteRef = async (git, ref) => {
  const listing = await read(git, ["ls-remote", "origin", ref]);
  if (listing === "")
    return false;
  await read(git, [...NO_HOOKS, "push", "--quiet", "origin", `:${ref}`]);
  return true;
};
var switchNew = async (git, name) => {
  await read(git, ["switch", "-c", name]);
};
var stashAll = async (git, message) => {
  await read(git, ["stash", "push", "--include-untracked", "-m", message]);
};

// src/origin.ts
var SCP_STYLE = /^(?:[^@/\s\\]+@)?([^:/\s\\]{2,}):(?!\/)([^\\]+)$/;
var tidy = (path) => path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
var normalizeRepoUrl = (raw) => {
  const text = raw.trim();
  if (text === "")
    return;
  if (!text.includes("://")) {
    const scp = SCP_STYLE.exec(text);
    if (scp === null)
      return;
    const [, host = "", path = ""] = scp;
    const clean = tidy(path.replace(/^\/+/, ""));
    return host === "" || clean === "" ? undefined : `https://${host}/${clean}`.toLowerCase();
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return;
  }
  if (!["ssh:", "git:", "http:", "https:"].includes(url.protocol) || url.hostname === "") {
    return;
  }
  const path = tidy(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
  if (path === "")
    return;
  const web = url.protocol === "http:" || url.protocol === "https:";
  const port = web && url.port !== "" ? `:${url.port}` : "";
  return `https://${url.hostname}${port}/${path}`.toLowerCase();
};
var matchEnvironments = (environments, origin) => {
  const wanted = normalizeRepoUrl(origin);
  if (wanted === undefined)
    return [];
  return environments.filter((environment) => environment.repos.some((repo) => normalizeRepoUrl(repo.url) === wanted));
};

// src/slices.ts
import { createHash } from "node:crypto";
var encoder = new TextEncoder;
var decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
var fileBytes = (text) => encoder.encode(text);
var sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
var continues = (byte) => byte !== undefined && (byte & 192) === 128;
var sliceAt = (bytes, offset, max) => {
  if (offset >= bytes.length)
    return;
  if (continues(bytes[offset])) {
    throw new RangeError(`offset ${String(offset)} is inside a character`);
  }
  let end = Math.min(offset + max, bytes.length);
  while (end > offset && continues(bytes[end]))
    end -= 1;
  if (end === offset) {
    throw new RangeError(`a slice of ${String(max)} bytes holds no whole character`);
  }
  return { offset, data: decoder.decode(bytes.subarray(offset, end)), bytes: end - offset };
};

// src/flow.ts
var STATUS_KEY = "cloudpid";
var MAX_LISTED_FILES = 8;
var MAX_NAME_TRIES = 5;
var slugify2 = (text) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
var formatSize = (bytes) => {
  if (bytes >= 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024)
    return `${Math.round(bytes / 1024)} KiB`;
  return `${String(bytes)} B`;
};
var plural = (count, word, many = `${word}s`) => `${String(count)} ${count === 1 ? word : many}`;
var listFiles = (files) => {
  const shown = files.slice(0, MAX_LISTED_FILES).join(", ");
  return files.length > MAX_LISTED_FILES ? `${shown}, and ${String(files.length - MAX_LISTED_FILES)} more` : shown;
};
var suggestedBranch = (session) => {
  const fromTitle = slugify2(session.name ?? "");
  if (fromTitle !== "")
    return fromTitle;
  const fromMessage = slugify2(session.firstMessage ?? "");
  return fromMessage === "" ? "pi-session" : fromMessage;
};
var chooseEnvironment = async (ui, environments, origin) => {
  const matches = matchEnvironments(environments, origin);
  const [only, ...others] = matches;
  if (only === undefined) {
    throw new Refusal(`No Environment has this Repo (${normalizeRepoUrl(origin) ?? origin}): add this Repo to an Environment first, in cloudpid's settings, then run /cloudpid again.`);
  }
  if (others.length === 0)
    return only;
  const labels = matches.map((environment) => `${environment.name} (${environment.id})`);
  const picked = await ui.select("Import into which Environment?", labels);
  const index = picked === undefined ? -1 : labels.indexOf(picked);
  return matches[index];
};
var askBranchName = async (ui, git, defaultBranch, prefill, why) => {
  let current = prefill;
  for (let tries = 0;tries < MAX_NAME_TRIES; tries += 1) {
    const answer = await ui.editor(why, current);
    if (answer === undefined)
      return;
    const name = (answer.split(`
`)[0] ?? "").trim();
    if (name === "")
      return;
    const problem = name === defaultBranch ? `${name} is the default branch: pick another name` : await branchNameProblem(git, name);
    if (problem === undefined)
      return name;
    ui.notify(`cloudpid: ${problem}.`, "warning");
    current = name;
  }
  return;
};
var confirmText = (environment, target, plan, carry, size, entries, model, thinking, instruction) => {
  const commits = plan.count === 0 ? plan.remote === undefined ? "none new (HEAD is on origin already)" : "none (origin has them)" : `${plural(plan.count, "commit")}${plan.commits.length > 0 ? `: ${plan.commits.join("; ")}` : ""}`;
  return [
    `Environment: ${environment.name}`,
    `Branch: ${target.name} (${target.create ? "made here with git switch -c; " : ""}${plan.remote === undefined ? "new on origin" : "fast-forward push"})`,
    `Commits to push: ${commits}`,
    `Carried changes: ${carry === undefined ? "none" : `${plural(carry.files.length, "file")}: ${listFiles(carry.files)} (uncommitted; ignored files stay behind)`}`,
    `Session: ${formatSize(size)}, ${plural(entries, "entry", "entries")}`,
    `Model: ${model ?? "not known"}${thinking === undefined ? "" : `, thinking ${thinking}`}`,
    `Instruction: ${instruction === "" ? "none (the Session waits for you)" : instruction}`
  ].join(`
`);
};
var askTaken = async (ui, name, sessions) => {
  const held = sessions.length === 0 ? "another Workspace" : sessions.map((session) => `${session.title === "" ? "untitled" : session.title} (${session.status}) ${session.url}`).join(`
  `);
  const retry = "I removed the Workspace in cloudpid: retry";
  const rename = "Import onto a new branch name";
  const cancel = "Cancel";
  const picked = await ui.select([
    `Branch ${name} is held by ${sessions.length === 0 ? held : `a Workspace with:
  ${held}`}`,
    "Removing that Workspace in the cloudpid web app deletes its Sessions, for good."
  ].join(`
`), [retry, rename, cancel]);
  if (picked === retry)
    return "retry";
  return picked === rename ? "rename" : "cancel";
};
var beginInput = (environment, session, size, name, host, instruction) => {
  const input = {
    environment: environment.id,
    format: PI_SESSION_FORMAT,
    size_bytes: size,
    branch: name,
    request_id: crypto.randomUUID()
  };
  if (session.name !== undefined && session.name.trim() !== "") {
    input.title = session.name.trim().slice(0, MAX_TITLE_LENGTH);
  }
  if (host.model !== undefined)
    input.model = host.model;
  const level = THINKING_LEVELS.find((candidate) => candidate === host.thinking);
  if (level !== undefined)
    input.thinking = level;
  if (instruction !== "")
    input.text = instruction;
  return input;
};
var upload = async (endpoint, begun, bytes, progress) => {
  const max = Math.min(begun.maxSliceBytes > 0 ? begun.maxSliceBytes : MAX_SLICE_BYTES, MAX_SLICE_BYTES);
  let offset = begun.received;
  let stalls = 0;
  while (offset < bytes.length) {
    const slice = sliceAt(bytes, offset, max);
    if (slice === undefined)
      break;
    let received;
    try {
      received = await endpoint.append(begun.importId, offset, slice.data);
    } catch (error) {
      const held = error instanceof ApiFailure ? receivedOf(error) : undefined;
      if (held === undefined)
        throw error;
      received = held;
    }
    if (received > bytes.length) {
      throw new Refusal(`the endpoint holds ${String(received)} bytes of a ${String(bytes.length)}-byte file.`);
    }
    stalls = received > offset ? 0 : stalls + 1;
    if (stalls > 2)
      throw new Refusal("the endpoint is not taking the file (it holds the same bytes after three tries).");
    offset = received;
    progress(offset);
  }
};
var describeResult = (result, instruction, comeBack) => {
  const lines = [
    result.status === "importing" ? `cloudpid: still importing; it will ${instruction === "" ? "wait for you" : "start on your instruction"} when done: ${result.url}` : `cloudpid: imported: ${result.url}`
  ];
  const { summary } = result;
  if (summary !== undefined) {
    const dropped = summary.dropped.map(([kind, count]) => `${kind} ${String(count)}`).join(", ");
    const parts = [
      summary.cut > 0 ? `cut ${String(summary.cut)}` : "",
      dropped === "" ? "" : `dropped ${dropped}`,
      summary.closed > 0 ? `closed ${String(summary.closed)} unfinished tool calls` : ""
    ].filter((part) => part !== "");
    if (parts.length > 0)
      lines.push(`  translation: ${parts.join("; ")}`);
  }
  for (const warning of result.warnings)
    lines.push(`  warning: ${warning}`);
  lines.push(...comeBack);
  return lines.join(`
`);
};
var abandon = async (endpoint, git, begun) => {
  const problems = [];
  try {
    await endpoint.cancel(begun.importId);
  } catch (error) {
    problems.push(`could not cancel the import (${error instanceof Error ? error.message : "unknown error"}); it expires in an hour (${begun.url})`);
  }
  try {
    await deleteRemoteRef(git, begun.carryRef);
  } catch {
    problems.push(`could not delete ${begun.carryRef} from origin`);
  }
  return problems;
};
var importSession = async (host, instruction, deps) => {
  const { ui } = host;
  const cancelled = { kind: "cancelled" };
  if (!host.hasUI)
    throw new Refusal("/cloudpid asks before it imports: run it in pi's interactive mode.");
  if (!host.isIdle()) {
    throw new Refusal("pi is still working: let it finish (or stop it), then run /cloudpid again.");
  }
  const session = host.session();
  if (session.file === undefined || !deps.exists(session.file)) {
    throw new Refusal("This pi session is not saved yet (pi writes its file with the first message): send a message, then run /cloudpid again.");
  }
  const bytes = fileBytes(session.text);
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new Refusal(`This session is ${formatSize(bytes.length)}, over cloudpid's limit of ${formatSize(MAX_IMPORT_BYTES)}: /compact it, or /tree to a shorter branch, then run /cloudpid again.`);
  }
  const config = readConfig(deps.env);
  if (session.marker !== undefined && !await ui.confirm("Import again?", `already imported as ${session.marker.url}; import again as a new Session?`)) {
    return cancelled;
  }
  const here = deps.git(host.cwd);
  let checkout;
  try {
    checkout = await checkoutOf(here);
  } catch (error) {
    if (error instanceof GitMissing) {
      throw new Refusal(`${error.message}, so /cloudpid cannot tell which Repo this is: install git, and add this Repo to an Environment first.`);
    }
    throw error;
  }
  if (checkout === undefined) {
    throw new Refusal(`${host.cwd} is not in a git repository: run /cloudpid from the Repo's checkout, and add this Repo to an Environment first.`);
  }
  if (checkout.origin === undefined) {
    throw new Refusal(`${checkout.root} has no \`origin\` remote: push it to GitHub, then add this Repo to an Environment first.`);
  }
  const git = deps.git(checkout.root);
  const endpoint = await deps.endpoint(config);
  try {
    const environments = await endpoint.environments();
    let origin = checkout.origin;
    if (matchEnvironments(environments, origin).length === 0) {
      const expanded = await expandedOriginOf(git);
      if (expanded !== undefined && matchEnvironments(environments, expanded).length > 0) {
        origin = expanded;
      }
    }
    const environment = await chooseEnvironment(ui, environments, origin);
    if (environment === undefined)
      return cancelled;
    const head = await headOf(git);
    if (head.commit === undefined) {
      throw new Refusal("This repo has no commit yet: commit, then run /cloudpid again.");
    }
    const { commit } = head;
    const defaultBranch = await defaultBranchOf(git, head);
    const onDefault = head.branch === undefined || head.branch === defaultBranch;
    let target;
    if (onDefault) {
      const name = await askBranchName(ui, git, defaultBranch, suggestedBranch(session), `${head.branch === undefined ? "HEAD is detached" : `You are on ${head.branch}, the default branch`}: name the branch cloudpid will work on (made here with git switch -c).`);
      if (name === undefined)
        return cancelled;
      target = { name, create: true };
    } else {
      const upstream = head.upstream !== undefined && head.upstream !== defaultBranch ? head.upstream : undefined;
      target = { name: upstream ?? head.branch ?? "", create: false };
    }
    let plan = await planPush(git, commit, target.name);
    if (plan.behind) {
      throw new Refusal(`origin's ${target.name} has commits this checkout lacks: pull first, then run /cloudpid again.`);
    }
    const carry = await readCarry(git, commit);
    const confirmed = await ui.confirm("Import this pi session into cloudpid?", confirmText(environment, target, plan, carry, bytes.length, session.entries, host.model, host.thinking, instruction));
    if (!confirmed)
      return cancelled;
    let begun;
    while (begun === undefined) {
      try {
        begun = await endpoint.begin(beginInput(environment, session, bytes.length, target.name, host, instruction));
      } catch (error) {
        const taken = error instanceof ApiFailure ? branchTakenOf(error) : undefined;
        if (taken === undefined)
          throw error;
        const choice = await askTaken(ui, target.name, taken.sessions);
        if (choice === "cancel")
          return cancelled;
        if (choice === "rename") {
          const name = await askBranchName(ui, git, defaultBranch, `${target.name}-2`, `Branch ${target.name} is held by another Workspace: name the branch cloudpid will work on.`);
          if (name === undefined)
            return cancelled;
          target = { name, create: true };
          plan = await planPush(git, commit, name);
          if (plan.behind) {
            throw new Refusal(`origin's ${name} has commits this checkout lacks: pull first, then run /cloudpid again.`);
          }
        }
      }
    }
    const imported = begun;
    let switched = false;
    let finished;
    try {
      if (target.create) {
        await switchNew(git, target.name);
        switched = true;
      }
      ui.setStatus(STATUS_KEY, `cloudpid: pushing ${target.name}`);
      if (plan.remote !== commit)
        await pushBranch(git, commit, target.name);
      if (carry === undefined) {
        await deleteRemoteRef(git, imported.carryRef);
      } else {
        await pushCarry(git, await commitCarry(git, carry, commit, target.name), imported.carryRef);
      }
      await upload(endpoint, imported, bytes, (sent) => {
        ui.setStatus(STATUS_KEY, `cloudpid: sending the session ${String(Math.round(sent / bytes.length * 100))}%`);
      });
      ui.setStatus(STATUS_KEY, "cloudpid: finishing");
      finished = await endpoint.finish(imported.importId, sha256Hex(bytes), carry !== undefined);
    } catch (error) {
      ui.setStatus(STATUS_KEY, undefined);
      const problems = await abandon(endpoint, git, imported);
      for (const problem of problems)
        ui.notify(`cloudpid: ${problem}.`, "warning");
      if (switched) {
        ui.notify(`cloudpid: you are now on ${target.name} (was ${head.branch ?? `a detached HEAD at ${commit.slice(0, 8)}`}); \`git switch ${head.branch ?? commit}\` goes back.`, "warning");
      }
      throw error;
    }
    ui.setStatus(STATUS_KEY, undefined);
    return await afterImport(host, git, finished, instruction, {
      branch: target.name,
      local: target.create ? target.name : head.branch ?? target.name,
      environment: environment.name,
      carried: carry !== undefined,
      setUpstream: target.create || head.upstream !== target.name
    });
  } finally {
    ui.setStatus(STATUS_KEY, undefined);
    await endpoint.close().catch(() => {
      return;
    });
  }
};
var afterImport = async (host, git, finished, instruction, landed) => {
  const { ui } = host;
  const trouble = [];
  let pull = "git pull --ff-only";
  if (landed.setUpstream) {
    const set = await git([
      "branch",
      `--set-upstream-to=origin/${landed.branch}`,
      landed.local
    ]).then((result) => result.code === 0, () => false);
    if (!set)
      pull = `git pull --ff-only origin ${landed.branch}`;
  }
  let stashed = false;
  if (landed.carried) {
    const message = `cloudpid: imported as ${finished.url}`;
    try {
      const wants = await ui.confirm("Put your uncommitted changes aside?", `The work goes on in cloudpid, with these changes. \`git stash push -u -m "${message}"\` keeps your copy out of the way here.`);
      if (wants) {
        try {
          await stashAll(git, message);
          stashed = true;
        } catch (error) {
          trouble.push(`could not stash: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    } catch (error) {
      trouble.push(`could not ask about the stash: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  try {
    host.appendEntry(IMPORT_MARKER, {
      session: finished.sessionId,
      url: finished.url,
      branch: landed.branch,
      environment: landed.environment
    });
  } catch (error) {
    trouble.push(`could not record the import in this pi session: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  for (const problem of trouble)
    ui.notify(`cloudpid: ${problem}.`, "warning");
  const comeBack = [
    `To come back: git switch ${landed.local} && ${pull}${stashed ? ", then git stash drop" : ""}`
  ];
  ui.notify(describeResult(finished, instruction, comeBack), "info");
  return {
    kind: finished.status === "importing" ? "importing" : "imported",
    url: finished.url,
    branch: landed.branch,
    stashed
  };
};

// src/session.ts
var firstUserText = (entries) => {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user")
      continue;
    const { content } = entry.message;
    if (!Array.isArray(content))
      return content;
    for (const part of content) {
      if (part.type === "text")
        return part.text;
    }
  }
  return;
};
var markerOf = (entries) => {
  let found;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== IMPORT_MARKER)
      continue;
    const data = toObject(isJson(entry.data) ? entry.data : undefined);
    const url = data === undefined ? undefined : stringField(data, "url");
    if (data !== undefined && url !== undefined)
      found = { url, branch: stringField(data, "branch") };
  }
  return found;
};
var snapshotOf = (source) => {
  const header = source.getHeader();
  const branch = source.getBranch();
  const lines = header === null ? [] : [JSON.stringify(header)];
  for (const entry of branch)
    lines.push(JSON.stringify(entry));
  return {
    id: source.getSessionId(),
    file: source.getSessionFile(),
    name: source.getSessionName(),
    text: lines.map((line) => `${line}
`).join(""),
    entries: branch.length,
    firstMessage: firstUserText(branch),
    marker: markerOf(branch)
  };
};

// src/index.ts
var hostOf = (pi, ctx) => ({
  cwd: ctx.cwd,
  hasUI: ctx.hasUI,
  isIdle: () => ctx.isIdle(),
  session: () => snapshotOf(ctx.sessionManager),
  model: ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`,
  thinking: ctx.thinkingLevel,
  ui: ctx.ui,
  appendEntry: (customType, data) => pi.appendEntry(customType, data)
});
var deps = {
  env: process.env,
  git: gitIn,
  endpoint: (config) => connectEndpoint(config),
  exists: existsSync
};
var messageOf = (error) => {
  if (error instanceof Refusal)
    return error.message;
  if (error instanceof ApiFailure) {
    if (error.code === "import_expired") {
      return "cloudpid: the import expired (an hour passed with nothing sent): run /cloudpid again.";
    }
    if (error.code === "too_many_running") {
      return `cloudpid: ${error.message} Finish or cancel the open import in cloudpid, then run /cloudpid again.`;
    }
    return `cloudpid: ${error.message}`;
  }
  return `cloudpid: the import failed: ${error.message}`;
};
function src_default(pi) {
  pi.registerCommand("cloudpid", {
    description: "Import this pi session into cloudpid (everything after /cloudpid is the instruction it starts with)",
    handler: async (args, ctx) => {
      try {
        await importSession(hostOf(pi, ctx), args.trim(), deps);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? messageOf(error) : "cloudpid: the import failed.", "error");
      }
    }
  });
}
export {
  src_default as default,
  messageOf
};
