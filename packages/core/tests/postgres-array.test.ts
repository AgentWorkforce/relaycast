import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseJsonArrayMaybeString,
  parsePostgresTextArray,
} from "../src/db/postgres-array.js";

test("parsePostgresTextArray: returns null for null/undefined", () => {
  assert.equal(parsePostgresTextArray(null), null);
  assert.equal(parsePostgresTextArray(undefined), null);
});

test("parsePostgresTextArray: passes through string arrays unchanged", () => {
  const input = ["/github/repos/**/issues/**", "/notion/databases/**"];
  assert.deepEqual(parsePostgresTextArray(input), input);
});

test("parsePostgresTextArray: returns null for non-string non-array values", () => {
  assert.equal(parsePostgresTextArray(42), null);
  assert.equal(parsePostgresTextArray({}), null);
});

test("parsePostgresTextArray: returns null for arrays with non-string entries", () => {
  assert.equal(parsePostgresTextArray([1, "x"]), null);
});

test("parsePostgresTextArray: empty literal `{}` → []", () => {
  assert.deepEqual(parsePostgresTextArray("{}"), []);
});

test("parsePostgresTextArray: empty string → []", () => {
  assert.deepEqual(parsePostgresTextArray(""), []);
});

test("parsePostgresTextArray: unquoted simple items", () => {
  assert.deepEqual(parsePostgresTextArray("{a,b,c}"), ["a", "b", "c"]);
});

test("parsePostgresTextArray: quoted item containing slashes and asterisks (real watch_glob path)", () => {
  assert.deepEqual(
    parsePostgresTextArray('{"/github/repos/**/**/issues/**"}'),
    ["/github/repos/**/**/issues/**"],
  );
});

test("parsePostgresTextArray: multiple quoted items", () => {
  assert.deepEqual(parsePostgresTextArray('{"a","b","c"}'), ["a", "b", "c"]);
});

test("parsePostgresTextArray: mixed quoted and unquoted", () => {
  assert.deepEqual(parsePostgresTextArray('{a,"b,c",d}'), ["a", "b,c", "d"]);
});

test("parsePostgresTextArray: escaped backslash and quote inside quoted item", () => {
  assert.deepEqual(parsePostgresTextArray('{"hello\\\\world"}'), ["hello\\world"]);
  assert.deepEqual(parsePostgresTextArray('{"a\\"b"}'), ['a"b']);
});

test("parsePostgresTextArray: malformed literal (no braces) returns null", () => {
  assert.equal(parsePostgresTextArray("a,b"), null);
  assert.equal(parsePostgresTextArray("{a"), null);
});

test("parseJsonArrayMaybeString: null/undefined/empty string → null", () => {
  assert.equal(parseJsonArrayMaybeString(null), null);
  assert.equal(parseJsonArrayMaybeString(undefined), null);
  assert.equal(parseJsonArrayMaybeString(""), null);
});

test("parseJsonArrayMaybeString: already-parsed arrays pass through", () => {
  const input = [{ paths: ["/x"] }, { paths: ["/y"] }];
  assert.deepEqual(parseJsonArrayMaybeString(input), input);
});

test("parseJsonArrayMaybeString: JSON-string arrays parse", () => {
  assert.deepEqual(parseJsonArrayMaybeString('[{"paths":["/x"]}]'), [
    { paths: ["/x"] },
  ]);
});

test("parseJsonArrayMaybeString: object/primitive JSON → null", () => {
  assert.equal(parseJsonArrayMaybeString('{"a":1}'), null);
  assert.equal(parseJsonArrayMaybeString("42"), null);
});

test("parseJsonArrayMaybeString: malformed JSON → null", () => {
  assert.equal(parseJsonArrayMaybeString("{not json"), null);
});
