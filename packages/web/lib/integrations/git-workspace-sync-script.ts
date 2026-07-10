export type GitWorkspaceSyncSource = {
  remoteUrl: string;
  targetDir: string;
  ref?: string;
  commit?: string;
  shallow?: boolean;
};

export type GitWorkspaceSyncCredentialEnv = {
  username: string;
  tokenEnvKey: string;
};

export function normalizeHttpsGitRemote(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isSafeGitRefName(value: string): boolean {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")) return false;
  if (value.includes("..") || value.includes("@{") || value === "@") return false;
  if (value === "HEAD") return false;
  if (value.startsWith("-")) return false;
  // Mirror git check-ref-format rather than an ASCII allowlist so legal branch
  // names (unicode, "@", "+") keep working while refspec separators (":"),
  // wildcards, and control characters stay blocked.
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(value)) return false;
  if (
    value.split("/").some(
      (segment) =>
        !segment || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"),
    )
  ) {
    return false;
  }
  return true;
}

function gitRemoteTrackingRefName(ref: string): {
  refspec: string;
  checkoutTarget: string;
  localBranch: string | null;
} | null {
  if (!isSafeGitRefName(ref)) return null;
  const localBranch = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref.startsWith("refs/")
      ? null
      : ref;
  if (localBranch === "HEAD") return null;
  const remoteRefName = localBranch ?? ref.slice("refs/".length);
  const remoteTrackingRef = `refs/remotes/origin/${remoteRefName}`;
  return {
    refspec: `+${ref}:${remoteTrackingRef}`,
    checkoutTarget: remoteTrackingRef,
    localBranch,
  };
}

export function buildGitWorkspaceSyncShell(input: {
  source: GitWorkspaceSyncSource;
  credentials?: GitWorkspaceSyncCredentialEnv | null;
  askpassPath: string;
  logPrefix?: string;
}): string {
  const fetchDepth = input.source.shallow === false ? "" : "--depth 1";
  const remoteTrackingRef = input.source.ref
    ? gitRemoteTrackingRefName(input.source.ref)
    : null;
  // A bare ref-name refspec only updates FETCH_HEAD; map safe refs onto a
  // remote-tracking ref explicitly so later checkout works on re-warmed
  // sandboxes whose clone has never seen this ref. The source side stays
  // unqualified so the remote resolves branches and tags alike.
  const refspec = remoteTrackingRef?.refspec ?? (input.source.ref ? null : "HEAD");
  const fetchRefspec = refspec ?? "HEAD";
  const targetDir = input.source.targetDir;
  const checkout = input.source.commit
    ? `git -C ${shellQuote(targetDir)} checkout --detach ${shellQuote(input.source.commit)}`
    : remoteTrackingRef?.localBranch
      ? `git -C ${shellQuote(targetDir)} checkout -B ${shellQuote(remoteTrackingRef.localBranch)} ${shellQuote(remoteTrackingRef.checkoutTarget)}`
      : remoteTrackingRef
        ? `git -C ${shellQuote(targetDir)} checkout --detach ${shellQuote(remoteTrackingRef.checkoutTarget)}`
      : "true";
  const credentials = input.credentials;
  const gitCredentialEnvPrefix = credentials
    ? `${credentials.tokenEnvKey}="$${credentials.tokenEnvKey}" `
    : "";
  const cloneBranchOption = remoteTrackingRef?.localBranch
    ? `--branch ${shellQuote(remoteTrackingRef.localBranch)}`
    : input.source.ref
      ? "--no-checkout"
      : "";
  // No --prune on these targeted fetches: prune matches the refspec source
  // literally (no DWIM like the fetch side), so with an unqualified source it
  // deletes the tracking ref the fetch just wrote and the checkout then fails.
  const cloneRefFetch = refspec
    ? ` && ${gitCredentialEnvPrefix}git -C ${shellQuote(targetDir)} fetch ${fetchDepth} origin ${shellQuote(refspec)}`
    : "";
  const logPrefix = input.logPrefix?.trim();
  return [
    "set -euo pipefail",
    logPrefix ? `echo ${shellQuote(`${logPrefix} preparing git workspace source`)}` : "",
    "export GIT_TERMINAL_PROMPT=0",
    credentials
      ? [
          `cat > ${shellQuote(input.askpassPath)} <<'EOF'`,
          "#!/bin/sh",
          "case \"$1\" in",
          `  *Username*) printf '%s\\n' ${shellQuote(credentials.username)} ;;`,
          `  *) printf '%s\\n' "$${credentials.tokenEnvKey}" ;;`,
          "esac",
          "EOF",
          `chmod 700 ${shellQuote(input.askpassPath)}`,
          `export GIT_ASKPASS=${shellQuote(input.askpassPath)}`,
        ].join("\n")
      : "",
    `mkdir -p ${shellQuote(targetDir)} 2>/dev/null || sudo mkdir -p ${shellQuote(targetDir)}`,
    `chown "$(id -u):$(id -g)" ${shellQuote(targetDir)} 2>/dev/null || sudo chown "$(id -u):$(id -g)" ${shellQuote(targetDir)}`,
    input.source.ref && !refspec
      ? `echo ${shellQuote(`Invalid git workspace ref: ${input.source.ref}`)} >&2; exit 64`
      : "",
    `if [ -d ${shellQuote(`${targetDir}/.git`)} ]; then ` +
      `git -C ${shellQuote(targetDir)} remote set-url origin ${shellQuote(input.source.remoteUrl)} && ` +
      `${gitCredentialEnvPrefix}git -C ${shellQuote(targetDir)} fetch ${fetchDepth} origin ${shellQuote(fetchRefspec)}; ` +
      "else " +
      `{ find ${shellQuote(targetDir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || sudo find ${shellQuote(targetDir)} -mindepth 1 -maxdepth 1 -exec rm -rf {} +; } && ` +
      `${gitCredentialEnvPrefix}git clone --filter=blob:none ${fetchDepth} --no-tags ${cloneBranchOption} ${shellQuote(input.source.remoteUrl)} ${shellQuote(targetDir)}${cloneRefFetch}; ` +
      "fi",
    `git config --global --add safe.directory ${shellQuote(targetDir)} || true`,
    input.source.commit
      ? `${gitCredentialEnvPrefix}git -C ${shellQuote(targetDir)} fetch ${fetchDepth} origin ${shellQuote(input.source.commit)}`
      : "true",
    checkout,
    credentials ? `rm -f ${shellQuote(input.askpassPath)}` : "",
  ].filter(Boolean).join(" && ");
}
