#!/usr/bin/env bash
set -u

# V5 overnight autonomous executor.
#
# Runs the V5 workflow set in dependency order across the cloud and
# sage-slack-envelope repos. Designed to be kicked off and left alone.
#
# Dependency order (enforced by wave structure below):
#   Wave 1 (parallel):   cloud/v5-01 (slack proxy) + cloud/v5-03 (github clone runner)
#   Wave 2 (sequential): sage/v5-01  — reads cloud/v5-01's route source from disk
#   Wave 3 (sequential): cloud/v5-02 — E2E docker stack validating both
#   Docker E2E:          cloud/v5-02B — isolated local docker validation, explicit only
#   GitHub validation:   cloud/v5-03B — isolated local clone-runner validation
#   Wave 4 (sequential): cloud/v5-04 — promote sage personas into workforce/workload-router
#                                      and open a DRAFT PR for manual publish in the morning
#
# Between waves the script commits workflow output locally so the next
# wave sees it. No pushes — review and push happens in the morning.
#
# Usage:
#   ./scripts/run-v5-overnight.sh                 # run everything
#   ./scripts/run-v5-overnight.sh --only=wave1    # run only wave 1
#   ./scripts/run-v5-overnight.sh --only=docker-e2e
#   ./scripts/run-v5-overnight.sh --only=github-validation
#   ./scripts/run-v5-overnight.sh --skip=wave3    # skip wave 3 (E2E is slowest)
#   ./scripts/run-v5-overnight.sh --dry-run       # print the plan, do nothing
#
# Prerequisites:
#   - agent-relay CLI on PATH
#   - Three repos checked out as siblings:
#       $ROOT/cloud
#       $ROOT/sage-slack-envelope
#       $ROOT/workforce           (wave 4 only)
#   - Docker Desktop running (required for wave 3 only)
#   - gh CLI authenticated for AgentWorkforce/workforce (wave 4 only)
#   - The V5 workflow files already on the respective branches
#
# Output:
#   Logs per workflow: $LOG_DIR/<name>.log
#   Manifest:          $LOG_DIR/manifest.txt

CLOUD="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "${CLOUD}/.." && pwd)"

# Sibling repo resolution.
#
# SAGE_DIR and WORKFORCE_DIR env vars take precedence — set them when the
# checkouts live under non-standard names (e.g. `sage` instead of
# `sage-slack-envelope`, or a worktree path like
# `$ROOT/sage.worktrees/workflows-v5-slack-egress-migration`).
#
# Otherwise we scan a short list of likely candidate directories and pick
# the first one that contains the expected workflow file. Preflight below
# errors out if neither the env var nor any candidate resolves.

resolve_sibling() {
  # $1 = override path (may be empty)
  # $2 = relative path inside the repo used to prove it's the right checkout
  # remaining args = candidate basenames under $ROOT
  local override="$1"; shift
  local marker="$1"; shift

  if [ -n "${override}" ]; then
    if [ -f "${override}/${marker}" ]; then
      echo "${override}"
      return 0
    fi
    echo ""
    return 1
  fi

  local cand
  for cand in "$@"; do
    if [ -f "${ROOT}/${cand}/${marker}" ]; then
      echo "${ROOT}/${cand}"
      return 0
    fi
  done
  echo ""
  return 1
}

SAGE="$(resolve_sibling \
  "${SAGE_DIR:-}" \
  "workflows/v5/01-sage-relayfile-migration.ts" \
  "sage-slack-envelope" \
  "sage" \
)"

WORKFORCE="$(resolve_sibling \
  "${WORKFORCE_DIR:-}" \
  "packages/workload-router/package.json" \
  "workforce" \
  "agent-workforce" \
)"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="${CLOUD}/.relay/v5-overnight-${TIMESTAMP}"
MANIFEST="${LOG_DIR}/manifest.txt"

GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
BLUE="\033[0;34m"
BOLD="\033[1m"
NC="\033[0m"

DRY_RUN=0
ONLY=""
SKIP=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --only=*)  ONLY="${arg#*=}" ;;
    --skip=*)  SKIP="${arg#*=}" ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

log()  { echo -e "${BOLD}[$(date +%H:%M:%S)]${NC} $*" | tee -a "${MANIFEST}"; }
pass() { echo -e "${GREEN}PASS${NC} $*" | tee -a "${MANIFEST}"; }
fail() { echo -e "${RED}FAIL${NC} $*" | tee -a "${MANIFEST}"; }
warn() { echo -e "${YELLOW}WARN${NC} $*" | tee -a "${MANIFEST}"; }
info() { echo -e "${BLUE}INFO${NC} $*" | tee -a "${MANIFEST}"; }

# ── Preflight ────────────────────────────────────────────────────────

mkdir -p "${LOG_DIR}"
: > "${MANIFEST}"

log "V5 overnight run starting"
log "  cloud:     ${CLOUD}"
log "  sage:      ${SAGE:-<unresolved>}"
log "  workforce: ${WORKFORCE:-<unresolved>}"
log "  logs:      ${LOG_DIR}"
log "  dry-run:   ${DRY_RUN}  only=${ONLY}  skip=${SKIP}"

if [ "${DRY_RUN}" -eq 0 ]; then
  if ! command -v agent-relay >/dev/null 2>&1; then
    fail "agent-relay CLI not found — install from the relay repo before running"
    exit 1
  fi
  if [ ! -d "${CLOUD}/.git" ]; then
    fail "cloud repo is not a git checkout: ${CLOUD}"
    exit 1
  fi
  if [ -z "${SAGE}" ] || [ ! -d "${SAGE}/.git" ]; then
    fail "sage repo not resolved"
    info "  set SAGE_DIR=/absolute/path to point at it explicitly,"
    info "  or clone as one of these siblings of ${CLOUD}:"
    info "    ${ROOT}/sage-slack-envelope"
    info "    ${ROOT}/sage"
    info "  resolver looks for: workflows/v5/01-sage-relayfile-migration.ts"
    exit 1
  fi
  if [ -z "${WORKFORCE}" ] || [ ! -d "${WORKFORCE}/.git" ]; then
    warn "workforce repo not resolved — wave 4 will be skipped"
    info "  set WORKFORCE_DIR=/absolute/path to enable it, or clone as one of:"
    info "    ${ROOT}/workforce"
    info "    ${ROOT}/agent-workforce"
  fi
  for f in \
    "${CLOUD}/workflows/v5-01-cloud-slack-proxy.ts" \
    "${CLOUD}/workflows/v5-02-sage-cloud-e2e.ts" \
    "${CLOUD}/workflows/v5-02b-sage-cloud-docker-e2e.ts" \
    "${CLOUD}/workflows/v5-03-cloud-github-clone-runner.ts" \
    "${CLOUD}/workflows/v5-03b-cloud-github-validation.ts" \
    "${CLOUD}/workflows/v5-04-promote-personas-to-workforce.ts" \
    "${SAGE}/workflows/v5/01-sage-relayfile-migration.ts"; do
    if [ ! -f "$f" ]; then
      fail "missing workflow file: $f"
      info "check out the branch that contains it before running this script"
      exit 1
    fi
  done
  pass "preflight: all workflow files present"
fi

# ── Utilities ────────────────────────────────────────────────────────

run_workflow() {
  local name="$1"
  local cwd="$2"
  local file="$3"
  local log="${LOG_DIR}/${name}.log"

  log "[${name}] starting (cwd=${cwd})"
  log "[${name}] log: ${log}"

  if [ "${DRY_RUN}" -eq 1 ]; then
    info "[${name}] (dry-run — skipping execution)"
    return 0
  fi

  local start
  start=$(date +%s)

  if (cd "${cwd}" && agent-relay run "${file}") > "${log}" 2>&1; then
    local end; end=$(date +%s)
    pass "[${name}] completed in $((end - start))s"
    return 0
  else
    local status=$?
    local end; end=$(date +%s)
    fail "[${name}] exit ${status} after $((end - start))s — last 10 lines:"
    tail -n 10 "${log}" | sed 's/^/    /' | tee -a "${MANIFEST}"
    return ${status}
  fi
}

run_parallel() {
  local pids=()
  local names=()
  for pair in "$@"; do
    local name="${pair%%=*}"
    local rest="${pair#*=}"
    local cwd="${rest%%=*}"
    local file="${rest#*=}"
    names+=("${name}")
    run_workflow "${name}" "${cwd}" "${file}" &
    pids+=($!)
  done

  local any_fail=0
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      any_fail=1
    fi
  done
  return ${any_fail}
}

commit_all() {
  local repo="$1"
  local message="$2"
  if [ "${DRY_RUN}" -eq 1 ]; then
    info "(dry-run) would commit in ${repo}: ${message}"
    return 0
  fi

  (
    cd "${repo}"
    if git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
      info "[commit] ${repo}: no changes to commit"
    else
      git add -A
      if git commit -m "${message}" > "${LOG_DIR}/commit-$(basename "${repo}").log" 2>&1; then
        local sha; sha=$(git rev-parse --short HEAD)
        pass "[commit] ${repo}: ${sha} — ${message}"
      else
        warn "[commit] ${repo}: commit failed (see ${LOG_DIR}/commit-$(basename "${repo}").log)"
      fi
    fi
  )
}

wave_enabled() {
  local wave="$1"
  if [ -n "${ONLY}" ] && [ "${ONLY}" != "${wave}" ]; then
    return 1
  fi
  if [ -n "${SKIP}" ] && [ "${SKIP}" = "${wave}" ]; then
    return 1
  fi
  return 0
}

# ── Wave 1: cloud v5-01 + cloud v5-03 (parallel, independent file scopes) ──

if wave_enabled wave1; then
  log ""
  log "════════════════════════════════════════════════════════════════"
  log " WAVE 1: cloud slack proxy + cloud github clone runner (parallel)"
  log "════════════════════════════════════════════════════════════════"

  run_parallel \
    "cloud-v5-01-slack-proxy=${CLOUD}=${CLOUD}/workflows/v5-01-cloud-slack-proxy.ts" \
    "cloud-v5-03-github-clone-runner=${CLOUD}=${CLOUD}/workflows/v5-03-cloud-github-clone-runner.ts" \
    || warn "wave1 had failures — continuing to wave 2"

  commit_all "${CLOUD}" "chore(v5): wave1 autonomous output (slack proxy + github clone runner)"
else
  info "wave1 skipped"
fi

# ── Wave 2: sage v5-01 (needs cloud/v5-01 route source on disk) ──────

if wave_enabled wave2; then
  log ""
  log "════════════════════════════════════════════════════════════════"
  log " WAVE 2: sage slack egress migration (sequential)"
  log "════════════════════════════════════════════════════════════════"

  if [ "${DRY_RUN}" -eq 0 ]; then
    if [ ! -f "${CLOUD}/packages/web/app/api/v1/proxy/slack/route.ts" ]; then
      warn "cloud slack proxy route.ts not found — sage v5-01 may fail"
      warn "  expected: ${CLOUD}/packages/web/app/api/v1/proxy/slack/route.ts"
      warn "  did wave1 complete successfully?"
    fi
  fi

  run_workflow "sage-v5-01-relayfile-migration" "${SAGE}" "${SAGE}/workflows/v5/01-sage-relayfile-migration.ts" \
    || warn "wave2 had failures — continuing to wave 3"

  commit_all "${SAGE}" "chore(v5): wave2 autonomous output (sage relayfile migration)"
else
  info "wave2 skipped"
fi

# ── Wave 3: cloud v5-02 (E2E docker stack — needs both above) ────────

if wave_enabled wave3; then
  log ""
  log "════════════════════════════════════════════════════════════════"
  log " WAVE 3: cloud ↔ sage ↔ slack E2E validation (sequential)"
  log "════════════════════════════════════════════════════════════════"

  if [ "${DRY_RUN}" -eq 0 ]; then
    if ! docker info >/dev/null 2>&1; then
      warn "docker is not running — wave 3 will fail at the compose step"
      warn "  start Docker Desktop and re-run with --only=wave3"
    fi
  fi

  run_workflow "cloud-v5-02-sage-cloud-e2e" "${CLOUD}" "${CLOUD}/workflows/v5-02-sage-cloud-e2e.ts" \
    || warn "wave3 had failures — see log"

  commit_all "${CLOUD}" "chore(v5): wave3 autonomous output (sage-cloud-slack E2E stack)"
else
  info "wave3 skipped"
fi

# ── Docker E2E validation: cloud v5-02B (isolated local validation) ──────

if [ "${ONLY}" = "docker-e2e" ]; then
  log ""
  log "════════════════════════════════════════════════════════════════"
  log " DOCKER E2E VALIDATION: cloud ↔ sage ↔ slack"
  log "════════════════════════════════════════════════════════════════"

  if [ "${DRY_RUN}" -eq 0 ]; then
    if ! docker info >/dev/null 2>&1; then
      warn "docker is not running — docker-e2e will fail at the compose step"
      warn "  start Docker Desktop and re-run with --only=docker-e2e"
    fi
  fi

  run_workflow "cloud-v5-02b-sage-cloud-docker-e2e" "${CLOUD}" "${CLOUD}/workflows/v5-02b-sage-cloud-docker-e2e.ts" \
    || warn "docker-e2e had failures — see log"
fi

# ── GitHub validation: cloud v5-03B (isolated local validation) ──────

if wave_enabled github-validation; then
  log ""
  log "════════════════════════════════════════════════════════════════"
  log " GITHUB VALIDATION: cloud GitHub clone runner"
  log "════════════════════════════════════════════════════════════════"

  run_workflow "cloud-v5-03b-github-validation" "${CLOUD}" "${CLOUD}/workflows/v5-03b-cloud-github-validation.ts" \
    || warn "github-validation had failures — see log"
else
  info "github-validation skipped"
fi

# ── Wave 4: promote sage personas into workforce/workload-router ─────

if wave_enabled wave4; then
  log ""
  log "════════════════════════════════════════════════════════════════"
  log " WAVE 4: promote sage personas into workforce/workload-router"
  log "════════════════════════════════════════════════════════════════"

  if [ -z "${WORKFORCE}" ] || [ ! -d "${WORKFORCE}/.git" ]; then
    warn "wave4 skipped — workforce repo not resolved (set WORKFORCE_DIR to enable)"
    # skip the rest of wave 4 without failing the run
  else
  if [ "${DRY_RUN}" -eq 0 ]; then
    if ! command -v gh >/dev/null 2>&1; then
      warn "gh CLI not on PATH — wave 4 cannot open the draft PR"
    elif ! gh auth status >/dev/null 2>&1; then
      warn "gh CLI not authenticated — wave 4 cannot open the draft PR"
    fi
    for f in \
      "${SAGE}/internal/agent-relay/personas/sage-slack-egress-migrator.json" \
      "${SAGE}/internal/agent-relay/personas/sage-proactive-rewirer.json" \
      "${SAGE}/internal/agent-relay/personas/cloud-slack-proxy-guard.json" \
      "${SAGE}/internal/agent-relay/personas/agent-relay-e2e-conductor.json"; do
      if [ ! -f "$f" ]; then
        warn "missing sage persona source: $f — wave 4 will fail"
      fi
    done
  fi

  run_workflow "cloud-v5-04-promote-personas" "${CLOUD}" "${CLOUD}/workflows/v5-04-promote-personas-to-workforce.ts" \
    || warn "wave4 had failures — see log; review ${WORKFORCE} state in the morning"

  # The workflow commits + pushes + opens its own draft PR in workforce.
  # commit_all here only catches any stray leftover state in cloud itself.
  commit_all "${CLOUD}" "chore(v5): wave4 autonomous output (promote personas to workforce)"
  fi  # close: workforce resolved
else
  info "wave4 skipped"
fi

# ── Summary ──────────────────────────────────────────────────────────

log ""
log "════════════════════════════════════════════════════════════════"
log " SUMMARY"
log "════════════════════════════════════════════════════════════════"
log "logs:     ${LOG_DIR}"
log "manifest: ${MANIFEST}"
log ""
log "next steps in the morning:"
log "  1. cat ${MANIFEST}"
log "  2. review per-workflow logs at ${LOG_DIR}/*.log"
log "  3. in each repo: git log --oneline main..HEAD to see autonomous commits"
log "  4. if satisfied, push branches and mark PRs ready for review"
log ""
log "done: $(date)"
