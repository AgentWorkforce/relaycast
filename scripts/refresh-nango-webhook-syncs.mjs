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
const providerFilter = args.providers ? new Set(splitCsv(args.providers)) : null;
const pauseDelayMs = parseNonNegativeInteger(args["pause-delay-ms"] || "1000", "--pause-delay-ms");

const declaredConfig = await readJson(path.resolve(repoRoot, configPath));
const webhookSyncsByProvider = collectWebhookSyncs(declaredConfig, providerFilter);

if (webhookSyncsByProvider.size === 0) {
  console.log("No Nango webhook-backed syncs matched the selected provider filter.");
  process.exit(0);
}

for (const [providerConfigKey, syncs] of webhookSyncsByProvider) {
  console.log(`Refreshing Nango webhook sync schedules for ${providerConfigKey}: ${syncs.join(", ")}`);
  await postSyncCommand(host, secretKey, "pause", providerConfigKey, syncs);
  if (pauseDelayMs > 0) {
    await sleep(pauseDelayMs);
  }
  await postSyncCommand(host, secretKey, "start", providerConfigKey, syncs);
}

console.log(`✓ Refreshed ${webhookSyncsByProvider.size} Nango webhook sync schedule set(s).`);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function postSyncCommand(baseUrl, token, command, providerConfigKey, syncs) {
  const response = await fetch(`${baseUrl}/sync/${command}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      provider_config_key: providerConfigKey,
      syncs
    })
  });

  if (!response.ok) {
    const body = await response.text();
    if (isNoSyncsFoundResponse(body)) {
      console.warn(`warning: Nango reported no sync schedules for ${providerConfigKey}; skipping ${command}.`);
      return;
    }
    throw new Error(
      `Nango sync ${command} request failed for ${providerConfigKey}: ${response.status} ${response.statusText}\n${body}`
    );
  }
}

function isNoSyncsFoundResponse(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.code === "no_syncs_found";
  } catch {
    return false;
  }
}

function collectWebhookSyncs(config, providerFilter) {
  const entries = new Map();

  for (const provider of normalizeProviderConfigs(config)) {
    const providerConfigKey = readString(provider, "providerConfigKey") || readString(provider, "provider_config_key");
    if (!providerConfigKey) {
      continue;
    }
    if (providerFilter && !providerFilter.has(providerConfigKey)) {
      continue;
    }

    const syncNames = [];
    for (const sync of provider.syncs) {
      const name = readString(sync, "name");
      const webhookSubscriptions =
        readStringArray(sync, "webhookSubscriptions") ||
        readStringArray(sync, "webhook_subscriptions") ||
        readStringArray(sync, "webhook-subscriptions");
      if (name && webhookSubscriptions && webhookSubscriptions.length > 0) {
        syncNames.push(name);
      }
    }

    if (syncNames.length > 0) {
      entries.set(providerConfigKey, uniqueSorted(syncNames));
    }
  }

  return entries;
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

function splitCsv(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNonNegativeInteger(value, flag) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flag} must be a non-negative integer.`);
  }

  return Number(value);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
