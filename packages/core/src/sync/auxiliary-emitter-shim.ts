// Adapter between cloud's variadic `RelayfileWriteClient` interface and the
// duck-typed `AuxiliaryEmitterClient` contract shared by every adapter's
// `emitXAuxiliaryFiles` function (introduced in Phase 1 — see
// relayfile-adapters#78).
//
// Why a shim? Cloud's client predates the Phase-1 contract. Its `readFile`
// accepts positional args (`workspaceId, path, correlationId?, signal?`) and
// returns `string | { content?: string }`. The adapter contract takes a
// single `{ workspaceId, path }` input and returns `{ content } | null`.
// Rather than retrofit every cloud call site to the new shape, this shim
// translates per-call. It is the only place the two contracts meet.
//
// `deleteFile`: the adapter contract returns `void`; cloud's returns
// `unknown`. When the cloud client can read the current file revision we use
// that revision as the delete precondition, and treat 404 as success so
// duplicate tombstone cleanup paths remain idempotent.
//
// `readFile`: the adapter contract is "missing file → null". Cloud's
// callers historically threw on 404 and we relied on the writer to catch.
// The shim coerces "empty content" and "missing string" to `null` so the
// adapter-side `PriorAliasReader` sees the expected absence sentinel.

import type { FileSemantics } from "@relayfile/sdk";
import type { RelayfileWriteClient } from "./record-writer.js";

export type EmitFileSemantics = {
  properties?: Record<string, string>;
  relations?: readonly string[];
  permissions?: readonly string[];
  comments?: readonly string[];
};

export type EmitAuxiliaryFilesResult = {
  written: number;
  deleted: number;
  errors: Array<{ path: string; error: string }>;
};

export type EmitReadResult = {
  content: string;
};

export type EmitWriteResult = {
  created?: boolean;
  updated?: boolean;
  status?: "created" | "updated" | "queued" | "pending";
};

export type AuxiliaryEmitterClient = {
  writeFile(input: {
    workspaceId: string;
    path: string;
    content: string;
    contentType?: string;
    semantics?: EmitFileSemantics;
  }): Promise<EmitWriteResult | void>;
  deleteFile?(input: { workspaceId: string; path: string }): Promise<void> | void;
  readFile?(input: {
    workspaceId: string;
    path: string;
  }): Promise<EmitReadResult | null | undefined>;
};

/**
 * Coerce the adapter's `EmitFileSemantics` (readonly arrays) into cloud's
 * sdk `FileSemantics` shape (mutable arrays). Same fields, structurally
 * identical, but the sdk type predates `readonly`.
 */
function adaptSemantics(
  semantics: EmitFileSemantics | undefined,
): FileSemantics | undefined {
  if (!semantics) return undefined;
  return {
    properties: semantics.properties,
    relations: semantics.relations ? [...semantics.relations] : undefined,
    permissions: semantics.permissions ? [...semantics.permissions] : undefined,
    comments: semantics.comments ? [...semantics.comments] : undefined,
  };
}

export function toAuxiliaryEmitterClient(
  client: RelayfileWriteClient,
): AuxiliaryEmitterClient {
  const failedReads = new Map<string, unknown>();
  const shim: AuxiliaryEmitterClient = {
    async writeFile(input) {
      const guardKey = readGuardKey(input.workspaceId, input.path);
      if (isAuxiliaryIndexPath(input.path) && failedReads.has(guardKey)) {
        const failedRead = failedReads.get(guardKey);
        throw new Error(
          `prior read of ${input.path} failed (${describeReadFailure(failedRead)}); refusing to rewrite index from empty baseline`,
          { cause: failedRead },
        );
      }
      await client.writeFile({
        workspaceId: input.workspaceId,
        path: input.path,
        content: input.content,
        contentType: input.contentType ?? "application/json; charset=utf-8",
        encoding: "utf-8",
        baseRevision: "*",
        semantics: adaptSemantics(input.semantics),
      });
    },
  };

  if (client.deleteFile) {
    shim.deleteFile = async (input) => {
      try {
        let baseRevision: "*" | string = "*";
        if (client.readFile) {
          const currentRevision = await readCurrentRevision(
            client,
            input.workspaceId,
            input.path,
          );
          if (currentRevision === undefined) {
            return;
          }
          baseRevision = currentRevision ?? "*";
        }
        await client.deleteFile!({
          workspaceId: input.workspaceId,
          path: input.path,
          baseRevision,
        });
      } catch (error) {
        if (!isNotFoundLikeError(error)) {
          throw error;
        }
      }
    };
  }

  if (client.readFile) {
    shim.readFile = async (input): Promise<EmitReadResult | null> => {
      const guardKey = readGuardKey(input.workspaceId, input.path);
      try {
        const result = await client.readFile!(input.workspaceId, input.path);
        failedReads.delete(guardKey);
        if (result == null) return null;
        const content =
          typeof result === "string" ? result : result.content ?? null;
        if (content == null || content.length === 0) return null;
        return { content };
      } catch (error) {
        if (isNotFoundLikeError(error)) {
          failedReads.delete(guardKey);
          return null;
        }
        if (isAuxiliaryIndexPath(input.path)) {
          failedReads.set(guardKey, error);
        }
        return null;
      }
    };
  }

  return shim;
}

function readGuardKey(workspaceId: string, path: string): string {
  return `${workspaceId}\0${path}`;
}

function isAuxiliaryIndexPath(path: string): boolean {
  return path.endsWith("/_index.json");
}

function describeReadFailure(error: unknown): string {
  if (error === null || typeof error !== "object") {
    return String(error);
  }
  const record = error as Record<string, unknown>;
  const response =
    record.response !== null && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const status = record.status ?? record.statusCode ?? response?.status;
  const message =
    typeof record.message === "string" && record.message.length > 0
      ? record.message
      : undefined;
  if (status !== undefined && message) {
    return `status ${String(status)}: ${message}`;
  }
  if (status !== undefined) {
    return `status ${String(status)}`;
  }
  return message ?? "unknown error";
}

async function readCurrentRevision(
  client: RelayfileWriteClient,
  workspaceId: string,
  path: string,
): Promise<string | null | undefined> {
  try {
    const result = await client.readFile?.(workspaceId, path);
    if (result == null) {
      return undefined;
    }
    if (typeof result === "string") {
      return null;
    }
    if (typeof result.revision === "string" && result.revision.length > 0) {
      return result.revision;
    }
    return typeof result.content === "string" ? null : undefined;
  } catch (error) {
    if (isNotFoundLikeError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFoundLikeError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const response =
    record.response !== null && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const status = record.status ?? record.statusCode ?? response?.status;
  return status === 404;
}
