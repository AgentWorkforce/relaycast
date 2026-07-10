import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { vi } from "vitest";

type ResourceBinding = Record<string, Record<string, string | undefined>>;

export interface BootAppOptions {
  env?: Record<string, string | undefined>;
  resources?: ResourceBinding;
}

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(helpersDir, "../..");

export async function bootRouteModule<T>(
  routeModulePath: string,
  options: BootAppOptions = {},
): Promise<{
  module: T;
  restore: () => void;
}> {
  const previousEnv = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(options.env ?? {})) {
    previousEnv.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  vi.doMock("sst", () => ({
    Resource: options.resources ?? {},
  }));

  const absoluteRoutePath = path.resolve(webRoot, routeModulePath);
  const module = await import(pathToFileURL(absoluteRoutePath).href) as T;

  return {
    module,
    restore: () => {
      for (const [key, value] of previousEnv.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
      vi.doUnmock("sst");
    },
  };
}

export function createRouteRequest(pathname: string, init?: RequestInit): Request {
  return new Request(new URL(pathname, "http://localhost").toString(), init);
}
