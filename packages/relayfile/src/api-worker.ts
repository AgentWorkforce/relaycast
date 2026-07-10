import { app } from "./app.js";

export { WorkspaceDO } from "./durable-objects/workspace.js";

export default {
  fetch: app.fetch,
};
