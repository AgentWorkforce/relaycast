import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertMountedLocalRootWithinAssigned,
  assertPairwiseDisjointScopes,
  assertSafeMemberWritePath,
  memberWritePath,
  pathScope,
  readPathScope,
  validateMemberRelayfileAccessScopes,
  validateMemberWriteScopes,
} from "../src/proactive-runtime/member-token-scope.js";

test("pathScope emits exact member write scope and memberWritePath keeps mint wildcard", () => {
  assert.equal(pathScope("packages/web"), "relayfile:fs:write:/packages/web/*");
  assert.equal(pathScope("/Packages/Web/"), "relayfile:fs:write:/Packages/Web/*");
  assert.equal(memberWritePath("packages/web"), "/packages/web/*");
  assert.equal(memberWritePath("/Packages/Web/"), "/Packages/Web/*");
});

test("member write roots reject root and empty paths before wildcarding", () => {
  for (const root of ["", " ", "/", "///", "*", "/*", "/**", "/*/", "/**/"]) {
    assert.throws(
      () => memberWritePath(root),
      /non-root relayfile path/i,
      `expected rejection for ${JSON.stringify(root)}`,
    );
    assert.throws(
      () => pathScope(root),
      /non-root relayfile path/i,
      `expected rejection for ${JSON.stringify(root)}`,
    );
  }
});

test("assertSafeMemberWritePath rejects degenerate roots and traversal", () => {
  for (const root of ["", " ", "/", "//", "///", "*", "/*", "/**", "/*/", "/**/"]) {
    assert.throws(
      () => assertSafeMemberWritePath(root),
      /non-root relayfile path/i,
      `expected rejection for ${JSON.stringify(root)}`,
    );
  }

  for (const root of ["/..", "/packages/../secrets", "/packages/..", "/packages/web/../api"]) {
    assert.throws(
      () => assertSafeMemberWritePath(root),
      /path traversal/i,
      `expected traversal rejection for ${JSON.stringify(root)}`,
    );
  }

  assert.equal(assertSafeMemberWritePath("packages/web"), "/packages/web");
  assert.equal(assertSafeMemberWritePath("/github/repos/acme/cloud/pulls/"), "/github/repos/acme/cloud/pulls");
  assert.equal(assertSafeMemberWritePath("/github/repos/**/**/pulls/**"), "/github/repos/**/**/pulls/**");
  assert.equal(assertSafeMemberWritePath("/packages/..foo"), "/packages/..foo");
});

test("validateMemberWriteScopes accepts exact assigned write scopes with optional reads", () => {
  assert.deepEqual(
    validateMemberWriteScopes(
      [
        "relayfile:fs:read:/packages/web/*",
        "relayfile:fs:write:/packages/web/*",
        "relayfile:fs:write:/packages/core/*",
      ],
      ["/packages/web", "/packages/core"],
    ),
    [
      "relayfile:fs:write:/packages/core/*",
      "relayfile:fs:write:/packages/web/*",
    ],
  );
});

test("validateMemberRelayfileAccessScopes allows same-root read scopes and rejects broad read leaks", () => {
  const assigned = ["/github/repos/acme/cloud/issues/123"];
  const writeScope = pathScope(assigned[0]!);
  const readScope = readPathScope(assigned[0]!);

  assert.deepEqual(
    validateMemberRelayfileAccessScopes([readScope, writeScope], assigned),
    [writeScope],
  );

  for (const scopes of [
    [writeScope, "relayfile:fs:read:*"],
    [writeScope, "relayfile:fs:read:/*"],
    [writeScope, "relayfile:fs:read:/github/repos/acme/cloud/issues/*"],
    [writeScope, "fs:read"],
    [writeScope, "sync:read"],
    [writeScope, "relayfile:fs:list:/github/repos/acme/cloud/issues/123/*"],
    [writeScope, "foo:bar"],
  ]) {
    assert.throws(
      () => validateMemberRelayfileAccessScopes(scopes, assigned),
      /member (read )?scope/i,
      `expected allowlist rejection for ${JSON.stringify(scopes)}`,
    );
  }
});

test("validateMemberWriteScopes rejects empty and broad member write grants", () => {
  const assigned = ["/packages/web"];
  const rejected: string[][] = [
    [],
    ["fs:write"],
    ["fs:write:/packages/web/*"],
    ["fs:manage"],
    ["fs:manage:/packages/web/*"],
    ["admin"],
    ["admin:acl"],
    ["relayfile:fs:manage:/packages/web/*"],
    ["relayfile:fs:write", "relayfile:fs:write:/packages/web/*"],
    ["relayfile:fs:manage", "relayfile:fs:write:/packages/web/*"],
    ["relayfile:fs:write:*"],
    ["relayfile:fs:write:/*"],
    ["relayfile:fs:write:/**"],
    ["relayfile:fs:write:/packages/*"],
    ["relayfile:fs:write:/packages/web"],
    ["relayfile:fs:write:/packages/api/*"],
  ];

  for (const scopes of rejected) {
    assert.throws(
      () => validateMemberWriteScopes(scopes, assigned),
      /member write scope/i,
      `expected rejection for ${JSON.stringify(scopes)}`,
    );
  }
});

test("validateMemberWriteScopes requires every assigned root exactly once", () => {
  assert.throws(
    () => validateMemberWriteScopes(
      [
        "relayfile:fs:write:/packages/web/*",
        "relayfile:fs:write:/packages/web/*",
      ],
      ["/packages/web"],
    ),
    /duplicate/i,
  );

  assert.throws(
    () => validateMemberWriteScopes(
      ["relayfile:fs:write:/packages/web/*"],
      ["/packages/web", "/packages/core"],
    ),
    /missing/i,
  );
});

test("validateMemberWriteScopes keeps first-mint scope strings exact", () => {
  const assigned = ["/packages/web"];
  assert.deepEqual(
    validateMemberWriteScopes(["relayfile:fs:write:/packages/web/**"], ["/packages/web/**"]),
    ["relayfile:fs:write:/packages/web/**"],
  );
  assert.throws(
    () => validateMemberWriteScopes(["relayfile:fs:write:/packages/web/**"], assigned),
    /member write scope/i,
  );
  assert.throws(
    () => validateMemberWriteScopes(["relayfile:fs:write:/packages/web"], assigned),
    /member write scope/i,
  );
});

test("assertPairwiseDisjointScopes accepts disjoint roots and rejects overlaps", () => {
  assert.doesNotThrow(() =>
    assertPairwiseDisjointScopes([
      { memberName: "impl-a", assignedPaths: ["/packages/web"] },
      { memberName: "impl-b", assignedPaths: ["/packages/core"] },
    ])
  );

  assert.throws(
    () => assertPairwiseDisjointScopes([
      { memberName: "impl-a", assignedPaths: ["/packages/web"] },
      { memberName: "impl-b", assignedPaths: ["/packages/web"] },
    ]),
    /overlap/i,
  );
  assert.throws(
    () => assertPairwiseDisjointScopes([
      { memberName: "impl-a", assignedPaths: ["/packages"] },
      { memberName: "impl-b", assignedPaths: ["/packages/web"] },
    ]),
    /overlap/i,
  );
  assert.throws(
    () => assertPairwiseDisjointScopes([
      { memberName: "impl-a", assignedPaths: ["/packages/*"] },
      { memberName: "impl-b", assignedPaths: ["/packages/web"] },
    ]),
    /overlap/i,
  );
  assert.throws(
    () => assertPairwiseDisjointScopes([]),
    /at least one/i,
  );
  assert.throws(
    () => assertPairwiseDisjointScopes([
      { memberName: "impl-a", assignedPaths: [] },
    ]),
    /at least one/i,
  );
  assert.throws(
    () => assertPairwiseDisjointScopes([
      { memberName: "impl-a", assignedPaths: ["/packages/web"] },
      { memberName: "impl-b", assignedPaths: [] },
    ]),
    /at least one/i,
  );
});

test("assertMountedLocalRootWithinAssigned fails closed on broadened live roots", () => {
  assert.doesNotThrow(() =>
    assertMountedLocalRootWithinAssigned(
      ["/packages/web"],
      ["/packages/web"],
    )
  );
  assert.doesNotThrow(() =>
    assertMountedLocalRootWithinAssigned(
      ["/packages/web/components"],
      ["/packages/web"],
    )
  );

  assert.throws(
    () => assertMountedLocalRootWithinAssigned(
      ["/packages"],
      ["/packages/web"],
    ),
    /outside assigned paths/i,
  );
  assert.throws(
    () => assertMountedLocalRootWithinAssigned(
      ["/packages/api"],
      ["/packages/web"],
    ),
    /outside assigned paths/i,
  );
  assert.throws(
    () => assertMountedLocalRootWithinAssigned(
      [],
      ["/packages/web"],
    ),
    /at least one/i,
  );
});
