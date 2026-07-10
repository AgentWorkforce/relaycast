import type { Env } from "./types.js";

export type Bindings = Env;

export interface AppEnv {
  Bindings: Bindings;
}
