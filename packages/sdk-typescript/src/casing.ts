type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type CamelCase<S extends string> =
  S extends `${infer Head}_${infer Tail}`
    ? `${Head}${Capitalize<CamelCase<Tail>>}`
    : S;

export type Camelize<T> =
  T extends Primitive ? T :
  T extends Array<infer U> ? Array<Camelize<U>> :
  T extends Record<string, unknown>
    ? { [K in keyof T as K extends string ? CamelCase<K> : K]: Camelize<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function camelizeKeys<T>(value: T): Camelize<T> {
  if (Array.isArray(value)) {
    return value.map((item) => camelizeKeys(item)) as Camelize<T>;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[toCamelKey(key)] = camelizeKeys(val);
    }
    return out as Camelize<T>;
  }
  return value as Camelize<T>;
}

export function decamelizeKeys<T>(value: T): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decamelizeKeys(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[toSnakeKey(key)] = decamelizeKeys(val);
    }
    return out;
  }
  return value;
}

export function decamelizeKey(key: string): string {
  return toSnakeKey(key);
}
