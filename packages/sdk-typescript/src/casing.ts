type Primitive = string | number | boolean | bigint | symbol | null | undefined;

export type CamelCase<S extends string> =
  S extends `${infer Head}_${infer Tail}`
    ? `${Head}${Capitalize<CamelCase<Tail>>}`
    : S;

export type Camelize<T> =
  T extends Primitive ? T :
  T extends Array<infer U> ? Array<Camelize<U>> :
  T extends object
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

/**
 * Fields whose values are user-authored JSON, not wire-protocol shapes: JSON
 * Schemas (`input_schema`/`output_schema`), action invocation payloads
 * (`input`/`output`), and HTTP header maps (`headers`). Their keys are data —
 * transforming them corrupts the document (e.g. a schema's
 * `properties.batchSize` must not become `properties.batch_size`) — so both
 * transforms rename the field itself but pass the value through verbatim.
 *
 * `data` and `metadata` belong here for the same reason, and their absence was
 * a live corruption rather than a latent one. Message `data`/`metadata` carry
 * caller-authored documents, and once Ratify proof bundles and signed
 * revocation lists travel in them the transform is not merely untidy: a
 * `RevocationList` whose `revoked_certs` arrives as `revokedCerts` cannot be
 * reconstructed byte-for-byte, so its signature no longer verifies and the
 * cross-deployment kill switch fails closed for the wrong reason. Anything
 * signed must survive a round trip unmodified.
 */
const VERBATIM_VALUE_KEYS = new Set([
  'headers',
  'input',
  'output',
  'input_schema',
  'inputSchema',
  'output_schema',
  'outputSchema',
  'data',
  'metadata',
]);

export function camelizeKeys<T>(value: T): Camelize<T> {
  if (Array.isArray(value)) {
    return value.map((item) => camelizeKeys(item)) as Camelize<T>;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[toCamelKey(key)] = VERBATIM_VALUE_KEYS.has(key) ? val : camelizeKeys(val);
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
      out[toSnakeKey(key)] = VERBATIM_VALUE_KEYS.has(key) ? val : decamelizeKeys(val);
    }
    return out;
  }
  return value;
}

export function decamelizeKey(key: string): string {
  return toSnakeKey(key);
}
