#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OPENAPI_FILE = resolve('openapi.yaml');
const LOCAL_ROUTER_FILE = resolve('packages/local/src/main.rs');

function normalizePath(path) {
  const collapsed = path.replace(/\/+/g, '/');
  const trimmed = collapsed === '/' ? '/' : collapsed.replace(/\/+$/, '');
  const normalizedParams = trimmed
    .replace(/:[A-Za-z0-9_]+/g, '{}')
    .replace(/\{[^/]+\}/g, '{}');
  return normalizedParams || '/';
}

function endpointKey(method, path) {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

function extractOpenApiEndpoints(content) {
  const endpoints = new Set();
  let inPaths = false;
  let currentPath = null;

  for (const line of content.split(/\r?\n/)) {
    if (!inPaths) {
      if (/^paths:\s*$/.test(line)) inPaths = true;
      continue;
    }

    const pathMatch = line.match(/^  (\/[^:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|patch|delete):\s*$/);
    if (!methodMatch || !currentPath) continue;

    if (
      currentPath.startsWith('/.well-known/mcp') ||
      currentPath === '/mcp'
    ) {
      continue;
    }

    // Root-level routes that are NOT behind the /v1 prefix.
    const isRootLevel =
      currentPath === '/health' ||
      currentPath.startsWith('/.well-known/agent') ||
      currentPath === '/a2a/rpc' ||
      currentPath.startsWith('/a2a/webhook');

    const fullPath = isRootLevel ? currentPath : `/v1${currentPath}`;
    endpoints.add(endpointKey(methodMatch[1], fullPath));
  }

  return endpoints;
}

function extractRouteInvocations(content) {
  const routes = [];
  let cursor = 0;

  while (true) {
    const start = content.indexOf('.route(', cursor);
    if (start === -1) break;

    let i = start + '.route('.length;
    while (/\s/.test(content[i] || '')) i += 1;

    if (content[i] !== '"') {
      cursor = i;
      continue;
    }

    i += 1;
    let path = '';
    while (i < content.length) {
      const ch = content[i];
      if (ch === '\\') {
        path += content.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === '"') break;
      path += ch;
      i += 1;
    }

    i += 1;
    while (/\s/.test(content[i] || '')) i += 1;
    if (content[i] !== ',') {
      cursor = i;
      continue;
    }
    i += 1;

    let expression = '';
    let depth = 1;
    let inString = false;
    while (i < content.length && depth > 0) {
      const ch = content[i];

      if (inString) {
        expression += ch;
        if (ch === '\\') {
          i += 1;
          if (i < content.length) expression += content[i];
        } else if (ch === '"') {
          inString = false;
        }
      } else if (ch === '"') {
        inString = true;
        expression += ch;
      } else if (ch === '(') {
        depth += 1;
        expression += ch;
      } else if (ch === ')') {
        depth -= 1;
        if (depth > 0) expression += ch;
      } else {
        expression += ch;
      }

      i += 1;
    }

    routes.push({ path, expression });
    cursor = i;
  }

  return routes;
}

function extractLocalEndpoints(content) {
  const endpoints = new Set();
  const routes = extractRouteInvocations(content);

  for (const route of routes) {
    for (const match of route.expression.matchAll(/\b(get|post|put|patch|delete)\s*\(/g)) {
      endpoints.add(endpointKey(match[1], route.path));
    }
  }

  return endpoints;
}

function formatList(items) {
  return items.map((item) => `  - ${item}`).join('\n');
}

const openapi = readFileSync(OPENAPI_FILE, 'utf8');
const localRouter = readFileSync(LOCAL_ROUTER_FILE, 'utf8');

const expected = extractOpenApiEndpoints(openapi);
const actual = extractLocalEndpoints(localRouter);

const missing = [...expected].filter((item) => !actual.has(item)).sort();
const extra = [...actual].filter((item) => !expected.has(item)).sort();

if (missing.length > 0 || extra.length > 0) {
  console.error('Local API parity check failed.\n');
  console.error(`Hosted contract endpoints: ${expected.size}`);
  console.error(`Local router endpoints: ${actual.size}\n`);
  if (missing.length > 0) {
    console.error(`Missing in local (${missing.length}):`);
    console.error(formatList(missing));
    console.error('');
  }
  if (extra.length > 0) {
    console.error(`Extra in local (${extra.length}):`);
    console.error(formatList(extra));
    console.error('');
  }
  process.exit(1);
}

console.log(`Local API parity check passed (${expected.size} endpoints).`);
