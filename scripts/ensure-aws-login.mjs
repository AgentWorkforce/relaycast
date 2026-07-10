#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const profile = process.env.AWS_PROFILE?.trim();
const silent = process.env.AWS_LOGIN_SILENT === "1";

function runAws(args, options = {}) {
  return spawnSync("aws", args, {
    encoding: "utf8",
    env: process.env,
    ...options,
  });
}

function fail(message, detail) {
  console.error(message);
  if (detail) {
    console.error(detail.trim());
  }
  process.exit(1);
}

function formatFailure(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function isExpiredSsoSession(detail) {
  return [
    "UnauthorizedException",
    "Session token not found or invalid",
    "Token has expired",
    "expired token",
    "failed to refresh cached credentials",
    "GetRoleCredentials",
  ].some((fragment) => detail.includes(fragment));
}

if (!profile) {
  fail(
    "AWS_PROFILE is not set. Configure it in .env or your shell before running local SST commands.",
  );
}

if (!silent) {
  console.log(`AWS_PROFILE=${profile}`);
}

const identity = runAws(
  ["sts", "get-caller-identity", "--profile", profile, "--output", "json"],
);

if (identity.error) {
  fail(
    "Unable to run the AWS CLI. Install awscli v2 and make sure `aws` is on your PATH.",
    identity.error.message,
  );
}

if (identity.status === 0) {
  if (!silent) {
    console.log(`AWS session is ready for profile ${profile}.`);
  }
  process.exit(0);
}

const identityFailure = formatFailure(identity);

if (!isExpiredSsoSession(identityFailure)) {
  fail(
    `AWS credentials check failed for profile ${profile}.`,
    identityFailure,
  );
}

if (!silent) {
  console.log(`AWS SSO session expired for profile ${profile}; logging in...`);
}

const login = runAws(["sso", "login", "--profile", profile], {
  stdio: "inherit",
});

if (login.error) {
  fail(
    `Unable to start AWS SSO login for profile ${profile}.`,
    login.error.message,
  );
}

if (login.status !== 0) {
  process.exit(login.status ?? 1);
}

const verified = runAws(
  ["sts", "get-caller-identity", "--profile", profile, "--output", "json"],
);

if (verified.error) {
  fail(
    `AWS SSO login finished but verification failed for profile ${profile}.`,
    verified.error.message,
  );
}

if (verified.status !== 0) {
  fail(
    `AWS SSO login finished but credentials are still not usable for profile ${profile}.`,
    formatFailure(verified),
  );
}

if (!silent) {
  console.log(`AWS session is ready for profile ${profile}.`);
}
