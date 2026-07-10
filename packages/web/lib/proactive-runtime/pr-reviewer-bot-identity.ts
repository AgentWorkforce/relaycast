// Single source of truth for the pr-reviewer GitHub App's bot login.
//
// GitHub derives a GitHub App's bot account login as `<app-slug>[bot]`, where
// the slug comes from the App's name. Renaming the App changes its slug — and
// therefore the login that arrives in webhook payloads and authors its commits.
// To rename: update PR_REVIEWER_BOT_LOGIN to the new `<slug>[bot]`; the commit
// identity + self-trigger guard derive from it, so this is the only literal to
// change. Keep the prior login in PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS for safe
// transition — in-flight events/commits still carry the old login, and the
// `derivedBotLogins` observability log in integration-watch-dispatcher surfaces
// the actual incoming login so the new slug can be confirmed.
//
// 2026-06: App renamed "Agent Relay Bot" (agent-relay-bot) → "agent-relay-code".
export const PR_REVIEWER_BOT_LOGIN = "agent-relay-code[bot]";

// Prior App login, retained so the self-trigger guard still suppresses events
// and commits authored under the old name during/after the rename transition.
export const PR_REVIEWER_PRIOR_BOT_LOGIN = "agent-relay-bot[bot]";

export const PR_REVIEWER_BOT_COMMIT_NAME = PR_REVIEWER_BOT_LOGIN;
export const PR_REVIEWER_BOT_COMMIT_EMAIL = `${PR_REVIEWER_BOT_LOGIN}@users.noreply.github.com`;

// Sender logins treated as the pr-reviewer's own actions (suppress self-trigger
// so the reviewer never reacts to its own commits/comments). Includes the new
// login, the prior login (transition), and the file writer bot.
export const PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS = new Set([
  PR_REVIEWER_BOT_LOGIN,
  PR_REVIEWER_PRIOR_BOT_LOGIN,
  "file-by-agent-relay[bot]",
]);
