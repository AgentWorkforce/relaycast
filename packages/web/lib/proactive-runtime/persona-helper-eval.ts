import { parse } from "acorn";

// Bounded, side-effect-free interpreter for locally-defined pure helper
// functions used inside definePersona/defineAgent properties.
//
// The static resolver (persona-resolve.ts) can evaluate literals, but personas
// legitimately build values with small pure helpers — most importantly cron
// schedules, e.g.
//
//   const OSLO = 'Europe/Oslo';
//   function weekdaysAt(name, at, tz = OSLO) {
//     const times = (Array.isArray(at) ? at : [at]).map((t) => t.split(':').map(Number));
//     const minute = times[0][1] || 0;
//     const hours = times.map(([h]) => h).join(',');
//     return { name, cron: `${minute} ${hours} * * 1-5`, tz };
//   }
//   ... schedules: [weekdaysAt('morning', '09:00'), weekdaysAt('evening', '17:00')]
//
// The deploy handler reads the resolved cron from agent.schedules to register
// the platform cron, so these MUST resolve to real values — degrading to an
// empty schedule would deploy a silently un-woken agent.
//
// This evaluator interprets a whitelisted JS subset over values it constructs
// itself (literals, arrays, plain objects). It never touches the host global
// object, performs no I/O, and is bounded by a step budget and recursion depth,
// so evaluating helper code fetched from GitHub cannot escape or hang. Anything
// outside the supported subset throws HelperEvalError and the caller degrades.

type AstNode = { type: string; [key: string]: unknown };

export class HelperEvalError extends Error {
  constructor(path: string, detail: string) {
    super(`${path} uses unsupported dynamic syntax (${detail})`);
    this.name = "HelperEvalError";
  }
}

export type HelperScope = {
  // name -> FunctionDeclaration | FunctionExpression (clean, type-stripped)
  functions: Map<string, AstNode>;
  // name -> initializer expression node (literal/array/object/template)
  consts: Map<string, AstNode>;
};

export const EMPTY_HELPER_SCOPE: HelperScope = { functions: new Map(), consts: new Map() };

const MAX_STEPS = 200_000;
const MAX_DEPTH = 64;

type Env = Map<string, unknown>;

type EvalCtx = {
  scope: HelperScope;
  constCache: Map<string, unknown>;
  steps: { n: number };
  path: string;
};

// Sentinel returned by statement execution to bubble a `return` out of nested
// blocks/conditionals without using exceptions for control flow.
const NO_RETURN = Symbol("no-return");

/**
 * Evaluate a (clean, acorn-parsed) expression node using the given helper
 * scope. Used by the resolver for agent triggers/schedules when the literal-only
 * static evaluator can't (because they call a local helper). Throws
 * HelperEvalError for anything outside the supported subset.
 */
export function evaluateHelperValue(node: AstNode, scope: HelperScope, path: string): unknown {
  const ctx: EvalCtx = { scope, constCache: new Map(), steps: { n: 0 }, path };
  return evalNode(node, new Map(), ctx, 0);
}

function tick(ctx: EvalCtx, depth: number): void {
  ctx.steps.n += 1;
  if (ctx.steps.n > MAX_STEPS) {
    throw new HelperEvalError(ctx.path, "evaluation budget exceeded");
  }
  if (depth > MAX_DEPTH) {
    throw new HelperEvalError(ctx.path, "maximum evaluation depth exceeded");
  }
}

function evalNode(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  tick(ctx, depth);
  switch (node.type) {
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      return evalTemplate(node, env, ctx, depth);
    case "Identifier":
      return evalIdentifier(node, env, ctx, depth);
    case "ArrayExpression":
      return evalArray(node, env, ctx, depth);
    case "ObjectExpression":
      return evalObject(node, env, ctx, depth);
    case "ConditionalExpression":
      return evalNode(node.test as AstNode, env, ctx, depth + 1)
        ? evalNode(node.consequent as AstNode, env, ctx, depth + 1)
        : evalNode(node.alternate as AstNode, env, ctx, depth + 1);
    case "LogicalExpression":
      return evalLogical(node, env, ctx, depth);
    case "BinaryExpression":
      return evalBinary(node, env, ctx, depth);
    case "UnaryExpression":
      return evalUnary(node, env, ctx, depth);
    case "MemberExpression":
      return evalMember(node, env, ctx, depth);
    case "CallExpression":
      return evalCall(node, env, ctx, depth);
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return makeClosure(node, env, ctx);
    default:
      throw new HelperEvalError(ctx.path, node.type);
  }
}

function evalTemplate(node: AstNode, env: Env, ctx: EvalCtx, depth: number): string {
  const quasis = (Array.isArray(node.quasis) ? node.quasis : []) as AstNode[];
  const expressions = (Array.isArray(node.expressions) ? node.expressions : []) as AstNode[];
  let out = "";
  for (let i = 0; i < quasis.length; i += 1) {
    const cooked = (quasis[i]!.value as { cooked?: unknown } | undefined)?.cooked;
    out += typeof cooked === "string" ? cooked : "";
    if (i < expressions.length) {
      out += stringifyTemplatePart(evalNode(expressions[i]!, env, ctx, depth + 1));
    }
  }
  return out;
}

function stringifyTemplatePart(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    // Mirrors JS template coercion for arrays (a.toString() === a.join(',')).
    if (Array.isArray(value)) return value.map(stringifyTemplatePart).join(",");
    return String(value);
  }
  return String(value);
}

function evalIdentifier(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  const name = node.name as string;
  if (name === "undefined") return undefined;
  if (name === "NaN") return NaN;
  if (name === "Infinity") return Infinity;
  if (env.has(name)) return env.get(name);
  const constNode = ctx.scope.consts.get(name);
  if (constNode) {
    if (ctx.constCache.has(name)) return ctx.constCache.get(name);
    const value = evalNode(constNode, new Map(), ctx, depth + 1);
    ctx.constCache.set(name, value);
    return value;
  }
  const userFn = ctx.scope.functions.get(name);
  if (userFn) {
    return (...args: unknown[]) => callUserFunction(userFn, args, ctx, depth + 1);
  }
  // A global function used as a value/callback (e.g. `.map(Number)`).
  const builtin = GLOBAL_FUNCTIONS[name];
  if (builtin) {
    return (...args: unknown[]) => builtin(args, ctx);
  }
  throw new HelperEvalError(ctx.path, `unknown identifier '${name}'`);
}

function evalArray(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown[] {
  const elements = (Array.isArray(node.elements) ? node.elements : []) as (AstNode | null)[];
  const out: unknown[] = [];
  for (const element of elements) {
    if (!element) {
      out.push(undefined);
      continue;
    }
    if (element.type === "SpreadElement") {
      const spread = evalNode(element.argument as AstNode, env, ctx, depth + 1);
      if (!Array.isArray(spread)) {
        throw new HelperEvalError(ctx.path, "spread of non-array");
      }
      out.push(...spread);
      continue;
    }
    out.push(evalNode(element, env, ctx, depth + 1));
  }
  return out;
}

function evalObject(node: AstNode, env: Env, ctx: EvalCtx, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const properties = (Array.isArray(node.properties) ? node.properties : []) as AstNode[];
  for (const property of properties) {
    if (property.type === "SpreadElement") {
      const spread = evalNode(property.argument as AstNode, env, ctx, depth + 1);
      if (spread && typeof spread === "object" && !Array.isArray(spread)) {
        Object.assign(out, spread);
        continue;
      }
      throw new HelperEvalError(ctx.path, "spread of non-object");
    }
    if (property.type !== "Property") {
      throw new HelperEvalError(ctx.path, property.type);
    }
    const key = propertyKey(property, env, ctx, depth);
    if (FORBIDDEN_KEYS.has(key)) {
      // Assigning out["__proto__"]/["constructor"] would mutate the constructed
      // object's prototype via the setter — block it like member reads do.
      throw new HelperEvalError(ctx.path, `forbidden property '${key}'`);
    }
    out[key] = evalNode(property.value as AstNode, env, ctx, depth + 1);
  }
  return out;
}

function propertyKey(property: AstNode, env: Env, ctx: EvalCtx, depth: number): string {
  const key = property.key as AstNode;
  if (property.computed === true) {
    return String(evalNode(key, env, ctx, depth + 1));
  }
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal") return String(key.value);
  throw new HelperEvalError(ctx.path, "unsupported property key");
}

function evalLogical(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  const left = evalNode(node.left as AstNode, env, ctx, depth + 1);
  switch (node.operator) {
    case "&&":
      return left ? evalNode(node.right as AstNode, env, ctx, depth + 1) : left;
    case "||":
      return left ? left : evalNode(node.right as AstNode, env, ctx, depth + 1);
    case "??":
      return left === null || left === undefined
        ? evalNode(node.right as AstNode, env, ctx, depth + 1)
        : left;
    default:
      throw new HelperEvalError(ctx.path, `logical ${node.operator}`);
  }
}

function evalBinary(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  const left = evalNode(node.left as AstNode, env, ctx, depth + 1) as never;
  const right = evalNode(node.right as AstNode, env, ctx, depth + 1) as never;
  switch (node.operator) {
    case "+": return (left as number) + (right as number);
    case "-": return (left as number) - (right as number);
    case "*": return (left as number) * (right as number);
    case "/": return (left as number) / (right as number);
    case "%": return (left as number) % (right as number);
    case "**": return (left as number) ** (right as number);
    case "==": return left == right;
    case "!=": return left != right;
    case "===": return left === right;
    case "!==": return left !== right;
    case "<": return left < right;
    case ">": return left > right;
    case "<=": return left <= right;
    case ">=": return left >= right;
    default:
      throw new HelperEvalError(ctx.path, `binary ${node.operator}`);
  }
}

function evalUnary(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  const argument = evalNode(node.argument as AstNode, env, ctx, depth + 1);
  switch (node.operator) {
    case "-": return -(argument as number);
    case "+": return +(argument as number);
    case "!": return !argument;
    case "typeof": return typeof argument;
    case "void": return undefined;
    default:
      throw new HelperEvalError(ctx.path, `unary ${node.operator}`);
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function evalMember(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  const object = evalNode(node.object as AstNode, env, ctx, depth + 1);
  const key = memberKey(node, env, ctx, depth);
  return readMember(object, key, ctx);
}

function memberKey(node: AstNode, env: Env, ctx: EvalCtx, depth: number): string | number {
  if (node.computed === true) {
    const value = evalNode(node.property as AstNode, env, ctx, depth + 1);
    return typeof value === "number" ? value : String(value);
  }
  const property = node.property as AstNode;
  if (property.type === "Identifier") return property.name as string;
  throw new HelperEvalError(ctx.path, "unsupported member property");
}

function readMember(object: unknown, key: string | number, ctx: EvalCtx): unknown {
  if (object === null || object === undefined) {
    throw new HelperEvalError(ctx.path, `member access on ${String(object)}`);
  }
  if (typeof key === "string" && FORBIDDEN_KEYS.has(key)) {
    throw new HelperEvalError(ctx.path, `forbidden member '${key}'`);
  }
  if (typeof object === "string") {
    if (key === "length") return object.length;
    if (typeof key === "number") return object[key];
    // Method names resolve in evalCall; a bare string-method reference is unsupported.
    throw new HelperEvalError(ctx.path, `string member '${String(key)}'`);
  }
  if (Array.isArray(object)) {
    if (key === "length") return object.length;
    if (typeof key === "number") return object[key];
    throw new HelperEvalError(ctx.path, `array member '${String(key)}'`);
  }
  if (typeof object === "object") {
    return (object as Record<string, unknown>)[key as string];
  }
  if (typeof object === "number" || typeof object === "boolean") {
    throw new HelperEvalError(ctx.path, `primitive member '${String(key)}'`);
  }
  throw new HelperEvalError(ctx.path, "unsupported member access");
}

type Closure = (...args: unknown[]) => unknown;

function makeClosure(node: AstNode, defEnv: Env, ctx: EvalCtx): Closure {
  return (...args: unknown[]) => {
    const env: Env = new Map(defEnv);
    bindParams((node.params as AstNode[]) ?? [], args, env, ctx);
    const body = node.body as AstNode;
    if (body.type === "BlockStatement") {
      const result = execBlock(body, env, ctx, 0);
      return result === NO_RETURN ? undefined : result;
    }
    return evalNode(body, env, ctx, 0);
  };
}

function evalCall(node: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown {
  const callee = node.callee as AstNode;
  const args = (node.arguments as AstNode[]).map((argument) => {
    if (argument.type === "SpreadElement") {
      throw new HelperEvalError(ctx.path, "spread arguments");
    }
    return evalNode(argument, env, ctx, depth + 1);
  });

  if (callee.type === "Identifier") {
    const name = callee.name as string;
    const fn = ctx.scope.functions.get(name);
    if (fn) return callUserFunction(fn, args, ctx, depth);
    const builtin = GLOBAL_FUNCTIONS[name];
    if (builtin) return builtin(args, ctx);
    throw new HelperEvalError(ctx.path, `call to '${name}'`);
  }

  if (callee.type === "MemberExpression") {
    const namespace = namespaceCallName(callee);
    if (namespace && namespace in NAMESPACE_FUNCTIONS) {
      return NAMESPACE_FUNCTIONS[namespace]!(args, ctx);
    }
    const object = evalNode(callee.object as AstNode, env, ctx, depth + 1);
    const method = memberKey(callee, env, ctx, depth);
    return invokeMethod(object, method, args, ctx);
  }

  throw new HelperEvalError(ctx.path, "unsupported call target");
}

// `Array.isArray` / `Object.keys` / `Math.max` / `JSON.stringify` etc. — a
// non-computed `Namespace.method` call we route to a safe impl rather than
// reading the host global as a value. Returns undefined if it isn't that shape.
function namespaceCallName(callee: AstNode): string | undefined {
  const object = callee.object as AstNode;
  const property = callee.property as AstNode;
  if (callee.computed === true || object.type !== "Identifier" || property.type !== "Identifier") {
    return undefined;
  }
  return `${object.name as string}.${property.name as string}`;
}

function callUserFunction(fn: AstNode, args: unknown[], ctx: EvalCtx, depth: number): unknown {
  tick(ctx, depth);
  const env: Env = new Map();
  bindParams((fn.params as AstNode[]) ?? [], args, env, ctx);
  const body = fn.body as AstNode;
  if (body.type !== "BlockStatement") {
    return evalNode(body, env, ctx, depth + 1);
  }
  const result = execBlock(body, env, ctx, depth + 1);
  return result === NO_RETURN ? undefined : result;
}

function execBlock(block: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown | typeof NO_RETURN {
  tick(ctx, depth);
  const body = (block.body as AstNode[]) ?? [];
  for (const statement of body) {
    const result = execStatement(statement, env, ctx, depth);
    if (result !== NO_RETURN) return result;
  }
  return NO_RETURN;
}

function execStatement(statement: AstNode, env: Env, ctx: EvalCtx, depth: number): unknown | typeof NO_RETURN {
  tick(ctx, depth);
  switch (statement.type) {
    case "VariableDeclaration": {
      for (const declarator of (statement.declarations as AstNode[]) ?? []) {
        const init = declarator.init as AstNode | undefined;
        const value = init ? evalNode(init, env, ctx, depth + 1) : undefined;
        bindPattern(declarator.id as AstNode, value, env, ctx);
      }
      return NO_RETURN;
    }
    case "ReturnStatement": {
      const argument = statement.argument as AstNode | undefined;
      return argument ? evalNode(argument, env, ctx, depth + 1) : undefined;
    }
    case "ExpressionStatement":
      evalNode(statement.expression as AstNode, env, ctx, depth + 1);
      return NO_RETURN;
    case "IfStatement": {
      const test = evalNode(statement.test as AstNode, env, ctx, depth + 1);
      const branch = (test ? statement.consequent : statement.alternate) as AstNode | undefined;
      if (!branch) return NO_RETURN;
      return branch.type === "BlockStatement"
        ? execBlock(branch, env, ctx, depth + 1)
        : execStatement(branch, env, ctx, depth + 1);
    }
    case "BlockStatement":
      return execBlock(statement, env, ctx, depth + 1);
    case "EmptyStatement":
      return NO_RETURN;
    default:
      throw new HelperEvalError(ctx.path, `statement ${statement.type}`);
  }
}

function bindParams(params: AstNode[], args: unknown[], env: Env, ctx: EvalCtx): void {
  params.forEach((param, index) => {
    if (param.type === "RestElement") {
      bindPattern(param.argument as AstNode, args.slice(index), env, ctx);
      return;
    }
    bindParam(param, args[index], env, ctx);
  });
}

function bindParam(param: AstNode, value: unknown, env: Env, ctx: EvalCtx): void {
  if (param.type === "AssignmentPattern") {
    const resolved = value === undefined ? evalNode(param.right as AstNode, env, ctx, 0) : value;
    bindPattern(param.left as AstNode, resolved, env, ctx);
    return;
  }
  bindPattern(param, value, env, ctx);
}

function bindPattern(pattern: AstNode, value: unknown, env: Env, ctx: EvalCtx): void {
  switch (pattern.type) {
    case "Identifier":
      env.set(pattern.name as string, value);
      return;
    case "AssignmentPattern": {
      const resolved = value === undefined ? evalNode(pattern.right as AstNode, env, ctx, 0) : value;
      bindPattern(pattern.left as AstNode, resolved, env, ctx);
      return;
    }
    case "ArrayPattern": {
      const source = Array.isArray(value) ? value : [];
      const elements = (pattern.elements as (AstNode | null)[]) ?? [];
      elements.forEach((element, index) => {
        if (!element) return;
        if (element.type === "RestElement") {
          bindPattern(element.argument as AstNode, source.slice(index), env, ctx);
          return;
        }
        bindParam(element, source[index], env, ctx);
      });
      return;
    }
    case "ObjectPattern": {
      const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      for (const property of (pattern.properties as AstNode[]) ?? []) {
        if (property.type === "RestElement") {
          throw new HelperEvalError(ctx.path, "object rest pattern");
        }
        const key = property.computed === true
          ? String(evalNode(property.key as AstNode, env, ctx, 0))
          : keyName(property.key as AstNode);
        if (key === undefined) throw new HelperEvalError(ctx.path, "object pattern key");
        if (FORBIDDEN_KEYS.has(key)) {
          // `const { constructor } = obj` would otherwise read the prototype's
          // constructor — a sandbox-escape vector. Block it like member reads.
          throw new HelperEvalError(ctx.path, `forbidden member '${key}'`);
        }
        bindParam(property.value as AstNode, source[key], env, ctx);
      }
      return;
    }
    default:
      throw new HelperEvalError(ctx.path, `pattern ${pattern.type}`);
  }
}

function keyName(key: AstNode): string | undefined {
  if (key.type === "Identifier") return key.name as string;
  if (key.type === "Literal") return String(key.value);
  return undefined;
}

function asCallable(value: unknown, ctx: EvalCtx): Closure {
  if (typeof value === "function") return value as Closure;
  throw new HelperEvalError(ctx.path, "expected a function argument");
}

// Safe method implementations on values WE constructed (arrays/strings/numbers).
function invokeMethod(object: unknown, method: string | number, args: unknown[], ctx: EvalCtx): unknown {
  const name = String(method);
  if (Array.isArray(object)) {
    switch (name) {
      case "map": return object.map((element, index) => asCallable(args[0], ctx)(element, index));
      case "filter": return object.filter((element, index) => Boolean(asCallable(args[0], ctx)(element, index)));
      case "find": return object.find((element, index) => Boolean(asCallable(args[0], ctx)(element, index)));
      case "findIndex": return object.findIndex((element, index) => Boolean(asCallable(args[0], ctx)(element, index)));
      case "some": return object.some((element, index) => Boolean(asCallable(args[0], ctx)(element, index)));
      case "every": return object.every((element, index) => Boolean(asCallable(args[0], ctx)(element, index)));
      case "forEach": object.forEach((element, index) => asCallable(args[0], ctx)(element, index)); return undefined;
      case "join": return object.join(args[0] === undefined ? "," : String(args[0]));
      case "slice": return object.slice(args[0] as number | undefined, args[1] as number | undefined);
      case "concat": return object.concat(...(args as unknown[][]));
      case "includes": return object.includes(args[0]);
      case "indexOf": return object.indexOf(args[0]);
      case "flat": return object.flat(args[0] as number | undefined);
      case "reverse": return [...object].reverse();
      default:
        throw new HelperEvalError(ctx.path, `array.${name}`);
    }
  }
  if (typeof object === "string") {
    switch (name) {
      case "split": return object.split(args[0] as string | RegExp);
      case "trim": return object.trim();
      case "toLowerCase": return object.toLowerCase();
      case "toUpperCase": return object.toUpperCase();
      case "replace": return object.replace(args[0] as string, args[1] as string);
      case "replaceAll": return object.replaceAll(args[0] as string, args[1] as string);
      case "slice": return object.slice(args[0] as number | undefined, args[1] as number | undefined);
      case "padStart": return object.padStart(args[0] as number, args[1] as string | undefined);
      case "padEnd": return object.padEnd(args[0] as number, args[1] as string | undefined);
      case "startsWith": return object.startsWith(args[0] as string);
      case "endsWith": return object.endsWith(args[0] as string);
      case "includes": return object.includes(args[0] as string);
      case "repeat": return object.repeat(args[0] as number);
      case "charAt": return object.charAt(args[0] as number);
      case "toString": return object;
      default:
        throw new HelperEvalError(ctx.path, `string.${name}`);
    }
  }
  if (typeof object === "number") {
    switch (name) {
      case "toString": return object.toString(args[0] as number | undefined);
      case "toFixed": return object.toFixed(args[0] as number | undefined);
      default:
        throw new HelperEvalError(ctx.path, `number.${name}`);
    }
  }
  throw new HelperEvalError(ctx.path, `method '${name}' on unsupported value`);
}

type BuiltinFn = (args: unknown[], ctx: EvalCtx) => unknown;

const GLOBAL_FUNCTIONS: Record<string, BuiltinFn> = {
  Number: (args) => Number(args[0] as never),
  String: (args) => String(args[0]),
  Boolean: (args) => Boolean(args[0]),
  parseInt: (args) => parseInt(args[0] as string, args[1] as number),
  parseFloat: (args) => parseFloat(args[0] as string),
};

const NAMESPACE_FUNCTIONS: Record<string, BuiltinFn> = {
  "Array.isArray": (args) => Array.isArray(args[0]),
  "Array.of": (args) => args.slice(),
  "Object.keys": (args) => Object.keys(args[0] as object),
  "Object.values": (args) => Object.values(args[0] as object),
  "Object.entries": (args) => Object.entries(args[0] as object),
  "Object.assign": (args) => Object.assign({}, ...(args as object[])),
  "Math.max": (args) => Math.max(...(args as number[])),
  "Math.min": (args) => Math.min(...(args as number[])),
  "Math.floor": (args) => Math.floor(args[0] as number),
  "Math.ceil": (args) => Math.ceil(args[0] as number),
  "Math.round": (args) => Math.round(args[0] as number),
  "Math.abs": (args) => Math.abs(args[0] as number),
  "Number.isInteger": (args) => Number.isInteger(args[0]),
  "Number.parseInt": (args) => Number.parseInt(args[0] as string, args[1] as number),
  "Number.parseFloat": (args) => Number.parseFloat(args[0] as string),
  "JSON.stringify": (args) => JSON.stringify(args[0]),
};

// ── Helper-scope extraction (TypeScript-aware, parse-free) ───────────────────
//
// We can't acorn-parse a whole .ts module (interfaces, param types, etc.). We
// string-slice each top-level `function` declaration and `const` initializer,
// strip the TS type annotations we understand, and acorn-parse just the cleaned
// fragment. Whatever we can't clean/parse is skipped — the caller degrades.

const FUNCTION_DECL_PATTERN =
  /(?:^|[;{}\n)])\s*(?:export\s+)?(?:async\s+)?function\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*\(/gu;

const CONST_DECL_PATTERN =
  /(?:^|[;{}\n)])\s*(?:export\s+)?const\s+([$_\p{ID_Start}][$_\p{ID_Continue}]*)\s*(?::[^=;]+)?=\s*/gu;

export function collectHelperScope(source: string): HelperScope {
  const functions = new Map<string, AstNode>();
  const consts = new Map<string, AstNode>();
  // Blank out comments first so the declaration patterns can't match a
  // commented-out `// function weekdaysAt(...)` / `// const SPEC = ...`.
  const clean = stripComments(source);
  collectFunctions(clean, functions);
  collectConsts(clean, consts);
  return { functions, consts };
}

// Replace line and block comments with equal-length whitespace (preserving
// offsets/newlines), while leaving string and template literals untouched — a
// naive regex would corrupt `//` inside a string such as a URL.
function stripComments(source: string): string {
  const out: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    const next = source[index + 1];
    if (quote) {
      out.push(char);
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      out.push(char);
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        out.push(" ");
        index += 1;
      }
      out.push(source[index] ?? ""); // the newline (or end)
      continue;
    }
    if (char === "/" && next === "*") {
      out.push("  ");
      index += 1;
      index += 1;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        out.push(source[index] === "\n" ? "\n" : " ");
        index += 1;
      }
      out.push("  "); // the closing */
      index += 1;
      continue;
    }
    out.push(char);
  }
  return out.join("");
}

function collectFunctions(source: string, functions: Map<string, AstNode>): void {
  FUNCTION_DECL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FUNCTION_DECL_PATTERN.exec(source)) !== null) {
    const name = match[1]!;
    const parenIndex = FUNCTION_DECL_PATTERN.lastIndex - 1;
    const parenEnd = findMatching(source, parenIndex);
    if (parenEnd === -1) continue;
    // Skip an optional `: ReturnType` between the params and the body `{`.
    const braceIndex = source.indexOf("{", parenEnd);
    if (braceIndex === -1) continue;
    const braceEnd = findMatching(source, braceIndex);
    if (braceEnd === -1) continue;

    const params = cleanParamList(source.slice(parenIndex + 1, parenEnd));
    if (params === undefined) continue;
    const body = source.slice(braceIndex, braceEnd + 1);

    const fn = parseFunctionExpression(`function ${name}(${params}) ${body}`);
    if (fn) functions.set(name, fn);
  }
}

function collectConsts(source: string, consts: Map<string, AstNode>): void {
  CONST_DECL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONST_DECL_PATTERN.exec(source)) !== null) {
    const name = match[1]!;
    const valueStart = CONST_DECL_PATTERN.lastIndex;
    const initializer = readInitializer(source, valueStart);
    if (initializer === undefined) continue;
    const node = parseExpression(initializer);
    // Arrow/function consts are not treated as literal consts here; only plain
    // value initializers (literal/template/array/object) are captured.
    if (node && node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
      consts.set(name, node);
    }
  }
}

// Strip TS type annotations from a parameter list, keeping names and defaults.
// `name: string, at: string | string[], tz: string = OSLO` -> `name, at, tz = OSLO`.
// Returns undefined if a parameter looks too complex to clean safely.
function cleanParamList(raw: string): string | undefined {
  const params = splitTopLevel(raw, ",");
  const cleaned: string[] = [];
  for (const param of params) {
    const trimmed = param.trim();
    if (!trimmed) continue;
    const cleanedParam = cleanParam(trimmed);
    if (cleanedParam === undefined) return undefined;
    cleaned.push(cleanedParam);
  }
  return cleaned.join(", ");
}

function cleanParam(param: string): string | undefined {
  // Remove a leading `...`? Keep rest params intact.
  // Find the top-level `:` (type annotation start) and the top-level `=` (default).
  const colon = indexOfTopLevel(param, ":");
  const equals = indexOfTopLevel(param, "=");
  if (colon === -1) {
    return param; // no type annotation (may still have a default)
  }
  const binding = param.slice(0, colon).replace(/\?\s*$/, "").trim();
  if (equals !== -1 && equals > colon) {
    return `${binding} = ${param.slice(equals + 1).trim()}`;
  }
  return binding;
}

function readInitializer(source: string, start: number): string | undefined {
  const opener = source[start];
  if (opener === "{" || opener === "[" || opener === "(") {
    const end = findMatching(source, start);
    return end === -1 ? undefined : source.slice(start, end + 1);
  }
  if (opener === "'" || opener === '"' || opener === "`") {
    const end = readStringLiteral(source, start);
    return end === -1 ? undefined : source.slice(start, end + 1);
  }
  // Primitive / identifier / simple expression: read to a top-level `;` or newline.
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (depth === 0 && (char === ";" || char === "\n")) {
      return source.slice(start, index).trim();
    }
  }
  return source.slice(start).trim();
}

function parseFunctionExpression(text: string): AstNode | null {
  const node = parseExpression(`(${text})`);
  return node && (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression")
    ? node
    : null;
}

function parseExpression(text: string): AstNode | null {
  try {
    const wrapped = `const __agentworkforceValue = (${text});`;
    const ast = parse(wrapped, { ecmaVersion: 2024, sourceType: "module" }) as unknown as AstNode;
    const body = (ast.body as AstNode[]) ?? [];
    const declaration = body.find((node) => node.type === "VariableDeclaration") as AstNode | undefined;
    const declarator = ((declaration?.declarations as AstNode[]) ?? [])[0];
    return (declarator?.init as AstNode) ?? null;
  } catch {
    return null;
  }
}

// ── string-aware scanning utilities (kept local to this module) ──────────────

function findMatching(source: string, openIndex: number): number {
  const opener = source[openIndex];
  const closer = opener === "{" ? "}" : opener === "[" ? "]" : opener === "(" ? ")" : "";
  if (!closer) return -1;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function readStringLiteral(source: string, openIndex: number): number {
  const quote = source[openIndex];
  let escaped = false;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === quote) return index;
  }
  return -1;
}

function splitTopLevel(source: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{" || char === "<") depth += 1;
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth -= 1;
    else if (depth === 0 && char === separator) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function indexOfTopLevel(source: string, target: string): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{" || char === "<") depth += 1;
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth -= 1;
    else if (depth === 0 && char === target) return index;
  }
  return -1;
}
