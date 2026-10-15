import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { communicationStatusSchemas } from "../dist/contract.js";
const output =
  JSON.stringify(
    {
      schemaVersion: 1,
      owner: "@relaycast/communication-policy",
      types: Object.fromEntries(
        Object.entries(communicationStatusSchemas).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema),
        ]),
      ),
      fixtures: JSON.parse(
        readFileSync(
          new URL("../fixtures/communication-status.v1.json", import.meta.url),
          "utf8",
        ),
      ),
    },
    null,
    2,
  ) + "\n";
const path = new URL(
  "../contracts/communication-status.v1.json",
  import.meta.url,
);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw Error("Contract drift: communication-status");
} else writeFileSync(path, output);
