import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDurableObjectMigrations,
  type DurableObjectMigrationDefinition,
} from "../infra/cloudflare-worker-migrations.js";

const identityMigrationHistory: DurableObjectMigrationDefinition[] = [
  {
    tag: "v1",
    newSqliteClasses: ["IdentityDO"],
  },
];

const multiStepMigrationHistory: DurableObjectMigrationDefinition[] = [
  {
    tag: "v1",
    newSqliteClasses: ["WorkspaceDO"],
  },
  {
    tag: "v2",
    newSqliteClasses: ["AuditDO"],
  },
  {
    tag: "v3",
    renamedClasses: [
      {
        from: "AuditDO",
        to: "WorkspaceAuditDO",
      },
    ],
  },
];

describe("buildDurableObjectMigrations", () => {
  it("plans the initial migration for a brand-new worker", () => {
    assert.deepEqual(
      buildDurableObjectMigrations(undefined, identityMigrationHistory),
      {
        newTag: "v1",
        newSqliteClasses: ["IdentityDO"],
      },
    );
  });

  it("plans the initial migration for an existing worker with no migration tag", () => {
    assert.deepEqual(
      buildDurableObjectMigrations("", identityMigrationHistory),
      {
        oldTag: "",
        newTag: "v1",
        newSqliteClasses: ["IdentityDO"],
      },
    );
  });

  it("returns no migration when the worker is already at the latest tag", () => {
    assert.equal(
      buildDurableObjectMigrations("v1", identityMigrationHistory),
      undefined,
    );
  });

  it("plans a single pending migration from the current tag", () => {
    assert.deepEqual(
      buildDurableObjectMigrations("v2", multiStepMigrationHistory),
      {
        oldTag: "v2",
        newTag: "v3",
        renamedClasses: [
          {
            from: "AuditDO",
            to: "WorkspaceAuditDO",
          },
        ],
      },
    );
  });

  it("plans multiple pending migrations as ordered steps", () => {
    assert.deepEqual(
      buildDurableObjectMigrations("v1", multiStepMigrationHistory),
      {
        oldTag: "v1",
        newTag: "v3",
        steps: [
          {
            newSqliteClasses: ["AuditDO"],
          },
          {
            renamedClasses: [
              {
                from: "AuditDO",
                to: "WorkspaceAuditDO",
              },
            ],
          },
        ],
      },
    );
  });

  it("fails when the deployed worker tag is missing from the configured history", () => {
    assert.throws(
      () => buildDurableObjectMigrations("legacy", identityMigrationHistory),
      /migration tag "legacy" is not present/,
    );
  });
});
