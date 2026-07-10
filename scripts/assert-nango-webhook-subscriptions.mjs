#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_NANGO_HOST = "https://api.nango.dev";
const DEFAULT_CONFIG_PATH = "nango-integrations/.nango/nango.json";
const args = parseArgs(process.argv.slice(2));

const secretKey = resolveSecretKey(args.environment);
if (!secretKey) {
  console.error("error: NANGO_SECRET_KEY or an environment-specific NANGO_SECRET_KEY_<ENV> is not set.");
  process.exit(1);
}

const repoRoot = process.cwd();
const configPath = args.config || process.env.NANGO_CONFIG_PATH || DEFAULT_CONFIG_PATH;
const host = (process.env.NANGO_API_URL || process.env.NANGO_HOST || DEFAULT_NANGO_HOST).replace(/\/+$/, "");
const providerFilter = args.providers ? new Set(args.providers.split(",").map((value) => value.trim()).filter(Boolean)) : null;
const retries = parsePositiveInteger(args.retries || "6", "--retries");
const delayMs = parseNonNegativeInteger(args["delay-ms"] || "5000", "--delay-ms");

const declaredConfig = await readJson(path.resolve(repoRoot, configPath));
const declared = collectDeclaredWebhookSubscriptions(declaredConfig, providerFilter);

let mismatches = [];
for (let attempt = 1; attempt <= retries; attempt += 1) {
  try {
    const liveConfig = await fetchLiveConfig(host, secretKey);
    const live = collectDeclaredWebhookSubscriptions(liveConfig, providerFilter);
    mismatches = compareSubscriptionCollections(declared, live);
    if (mismatches.length === 0) {
      console.log(`✓ Verified ${declared.subscriptions.size} Nango webhook subscription sets against live config.`);
      process.exit(0);
    }
  } catch (error) {
    mismatches = [`failed to fetch or parse live Nango config: ${formatError(error)}`];
  }

  if (attempt < retries) {
    console.error(
      `Nango webhook subscription assertion failed on attempt ${attempt}/${retries}; retrying in ${delayMs}ms...`
    );
    await sleep(delayMs);
  }
}

if (mismatches.length > 0) {
  console.error("error: live Nango webhook subscription config does not match declared config.");
  for (const mismatch of mismatches) {
    console.error(`  - ${mismatch}`);
  }
  process.exit(1);
}

console.log("No declared Nango webhook subscription sets matched the selected provider filter.");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function fetchLiveConfig(baseUrl, token) {
  const response = await fetch(`${baseUrl}/scripts/config`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nango scripts config request failed: ${response.status} ${response.statusText}\n${body}`);
  }

  return response.json();
}

function collectDeclaredWebhookSubscriptions(config, providerFilter) {
  const subscriptions = new Map();
  const duplicates = new Map();

  for (const provider of normalizeProviderConfigs(config)) {
    const providerConfigKey = readString(provider, "providerConfigKey") || readString(provider, "provider_config_key");
    if (!providerConfigKey) {
      continue;
    }
    if (providerFilter && !providerFilter.has(providerConfigKey)) {
      continue;
    }

    const syncs = Array.isArray(provider.syncs) ? provider.syncs : [];
    for (const sync of syncs) {
      if (!sync || typeof sync !== "object") {
        continue;
      }

      const name = readString(sync, "name");
      const webhookSubscriptions =
        readStringArray(sync, "webhookSubscriptions") ||
        readStringArray(sync, "webhook_subscriptions") ||
        readStringArray(sync, "webhook-subscriptions");
      if (!name || !webhookSubscriptions || webhookSubscriptions.length === 0) {
        continue;
      }

      const key = `${providerConfigKey}:${name}`;
      const entry = {
        key,
        providerConfigKey,
        name,
        webhookSubscriptions: uniqueSorted(webhookSubscriptions),
        id: readNumber(sync, "id"),
        input: readString(sync, "input"),
        lastDeployed: readString(sync, "last_deployed") || readString(sync, "lastDeployed")
      };

      if (subscriptions.has(key)) {
        const existing = subscriptions.get(key);
        if (!duplicates.has(key)) {
          duplicates.set(key, [existing]);
        }
        duplicates.get(key).push(entry);
        continue;
      }

      subscriptions.set(key, entry);
    }
  }

  return {
    subscriptions: new Map([...subscriptions].map(([key, entry]) => [key, entry.webhookSubscriptions])),
    duplicates
  };
}

function compareSubscriptionCollections(declared, live) {
  const duplicateKeys = new Set([...declared.duplicates.keys(), ...live.duplicates.keys()]);
  return [
    ...formatDuplicateSubscriptionMessages("declared", declared.duplicates),
    ...formatDuplicateSubscriptionMessages("live", live.duplicates),
    ...compareSubscriptions(declared.subscriptions, live.subscriptions, duplicateKeys)
  ];
}

function formatDuplicateSubscriptionMessages(source, duplicates) {
  const messages = [];
  for (const [key, entries] of duplicates) {
    messages.push(
      `${key}: duplicate ${source} Nango webhook subscription definitions (${entries.length} entries): ${entries
        .map(formatSubscriptionEntry)
        .join("; ")}`
    );
  }
  return messages;
}

function formatSubscriptionEntry(entry) {
  return [
    entry.id !== null ? `id=${entry.id}` : null,
    entry.input ? `input=${entry.input}` : null,
    entry.lastDeployed ? `last_deployed=${entry.lastDeployed}` : null,
    `webhookSubscriptions=[${entry.webhookSubscriptions.join(", ")}]`
  ]
    .filter(Boolean)
    .join(" ");
}

function compareSubscriptions(declaredSubscriptions, liveSubscriptions, skipKeys = new Set()) {
  const mismatches = [];

  for (const [key, declared] of declaredSubscriptions) {
    if (skipKeys.has(key)) {
      continue;
    }
    const live = liveSubscriptions.get(key);
    if (!live) {
      mismatches.push(`${key}: missing from live Nango config; expected [${declared.join(", ")}]`);
      continue;
    }

    const missing = declared.filter((event) => !live.includes(event));
    const extra = live.filter((event) => !declared.includes(event));
    if (missing.length > 0 || extra.length > 0) {
      mismatches.push(
        [
          `${key}: webhookSubscriptions drift`,
          missing.length > 0 ? `missing [${missing.join(", ")}]` : null,
          extra.length > 0 ? `extra [${extra.join(", ")}]` : null
        ]
          .filter(Boolean)
          .join("; ")
      );
    }
  }

  for (const [key, live] of liveSubscriptions) {
    if (skipKeys.has(key)) {
      continue;
    }
    if (!declaredSubscriptions.has(key)) {
      mismatches.push(`${key}: extra live webhookSubscriptions [${live.join(", ")}]`);
    }
  }

  return mismatches;
}

function normalizeProviderConfigs(config) {
  let providers = [];

  if (Array.isArray(config)) {
    providers = config;
  } else if (config && typeof config === "object") {
    let foundNestedProviders = false;
    for (const key of ["data", "configs", "integrations"]) {
      const value = config[key];
      if (Array.isArray(value)) {
        providers = value;
        foundNestedProviders = true;
        break;
      }
      if (value && typeof value === "object") {
        providers = Object.entries(value).map(([providerConfigKey, providerConfig]) => ({
          providerConfigKey,
          ...providerConfig
        }));
        foundNestedProviders = true;
        break;
      }
    }
    providers = foundNestedProviders ? providers : [config];
  }

  return providers
    .filter((provider) => provider && typeof provider === "object")
    .map((provider) => ({
      ...provider,
      syncs: normalizeSyncs(provider.syncs)
    }));
}

function normalizeSyncs(syncs) {
  if (Array.isArray(syncs)) {
    return syncs;
  }

  if (!syncs || typeof syncs !== "object") {
    return [];
  }

  return Object.entries(syncs).map(([name, sync]) => ({
    name,
    ...sync,
    webhookSubscriptions: sync?.webhookSubscriptions || sync?.["webhook-subscriptions"] || sync?.webhook_subscriptions
  }));
}

function readString(record, key) {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record, key) {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function readStringArray(record, key) {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return null;
  }

  return value.filter((item) => typeof item === "string");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.trim();
    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    parsed[key] = value;
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  return Number(value);
}

function parsePositiveInteger(value, flag) {
  const parsed = parseNonNegativeInteger(value, flag);
  if (parsed === 0) {
    throw new Error(`${flag} must be greater than 0.`);
  }

  return parsed;
}

function resolveSecretKey(environment) {
  const names = [];
  if (environment) {
    const normalized = environment.toUpperCase();
    names.push(`NANGO_SECRET_KEY_${normalized}`);
    if (normalized === "PRODUCTION") {
      names.push("NANGO_SECRET_KEY_PROD");
    }
    if (normalized === "PROD") {
      names.push("NANGO_SECRET_KEY_PRODUCTION");
    }
  }
  names.push("NANGO_SECRET_KEY", "NANGO_SECRET_KEY_PRODUCTION");

  for (const name of names) {
    const value = process.env[name];
    if (value) {
      return value;
    }
  }

  return null;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
