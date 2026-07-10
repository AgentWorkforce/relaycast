import { readFileSync } from "node:fs";

const routerPath = "packages/web/lib/integrations/nango-webhook-router.ts";
const source = readFileSync(routerPath, "utf8");
const matches = source.match(/\bswitch\s*\(\s*provider\s*\)/g) ?? [];

if (matches.length > 1) {
  console.error(
    `${routerPath} contains ${matches.length} switch(provider) branches; AR-268 allows no new provider switch branches in the webhook router.`,
  );
  process.exit(1);
}

console.log(`${routerPath} switch(provider) branch count: ${matches.length}`);
