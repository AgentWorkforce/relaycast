export function getUnsupportedWritebackReason(
  provider: string,
  path: string,
  action: string,
): string | null {
  if (action !== "file_upsert" && action !== "file_delete") {
    return `unsupported writeback action ${action} for ${path}`;
  }

  switch (provider) {
    case "notion":
      return NOTION_WRITEBACK_PATH.test(path)
        ? null
        : `unsupported Notion writeback path: ${path}`;
    case "github":
      return getActionPathPattern(action, {
        upsert: GITHUB_UPSERT_WRITEBACK_PATH,
        delete: GITHUB_DELETE_WRITEBACK_PATH,
      }).test(path)
        ? null
        : `unsupported GitHub writeback path: ${path}`;
    case "google-mail":
      return getActionPathPattern(action, {
        upsert: GOOGLE_MAIL_UPSERT_WRITEBACK_PATH,
        delete: GOOGLE_MAIL_DELETE_WRITEBACK_PATH,
      }).test(path)
        ? null
        : `unsupported Google Mail writeback path: ${path}`;
    case "linear":
      return getActionPathPattern(action, {
        upsert: LINEAR_UPSERT_WRITEBACK_PATH,
        delete: LINEAR_DELETE_WRITEBACK_PATH,
      }).test(path)
        ? null
        : `unsupported Linear writeback path: ${path}`;
    case "slack":
      return getActionPathPattern(action, {
        upsert: SLACK_UPSERT_WRITEBACK_PATH,
        delete: SLACK_DELETE_WRITEBACK_PATH,
      }).test(path)
        ? null
        : `unsupported Slack writeback path: ${path}`;
    case "jira":
      return getActionPathPattern(action, {
        upsert: JIRA_UPSERT_WRITEBACK_PATH,
        delete: JIRA_DELETE_WRITEBACK_PATH,
      }).test(path)
        ? null
        : `unsupported Jira writeback path: ${path}`;
    case "confluence":
      return getActionPathPattern(action, {
        upsert: CONFLUENCE_UPSERT_WRITEBACK_PATH,
        delete: CONFLUENCE_DELETE_WRITEBACK_PATH,
      }).test(path)
        ? null
        : `unsupported Confluence writeback path: ${path}`;
    default:
      return `unsupported provider writeback path: ${path}`;
  }
}

function getActionPathPattern(
  action: string,
  patterns: { upsert: RegExp; delete: RegExp },
): RegExp {
  return action === "file_delete" ? patterns.delete : patterns.upsert;
}

const NOTION_WRITEBACK_PATH =
  /^\/notion\/(?:databases\/[^/]+\/pages\/[^/]+(?:\.json|\/content\.md|\/comments\.json)|pages\/[^/]+(?:\.json|\/content\.md|\/comments\.json)|databases\/[^/]+\/pages\/?)$/;
const GITHUB_NUMBER_SEGMENT = String.raw`[1-9]\d*(?:__[^/]+)?`;
const GITHUB_JSON_FILE = String.raw`[^/]+\.json`;
const GITHUB_ISSUE_WRITEBACK_FILE = String.raw`(?!(?:_index|meta|metadata)\.json$)[^/]+\.json`;
export const GITHUB_UPSERT_WRITEBACK_PATH = new RegExp(
  `^/github/repos/[^/]+/[^/]+/(?:pulls/${GITHUB_NUMBER_SEGMENT}/(?:reviews|comments)/${GITHUB_JSON_FILE}|issues/(?:${GITHUB_ISSUE_WRITEBACK_FILE}|${GITHUB_NUMBER_SEGMENT}/comments/${GITHUB_JSON_FILE}))$`,
);
const GITHUB_DELETE_WRITEBACK_PATH = new RegExp(
  `^/github/repos/[^/]+/[^/]+/pulls/${GITHUB_NUMBER_SEGMENT}/reviews/\\d+\\.json$`,
);
const GOOGLE_MAIL_JSON_FILE = String.raw`(?!(?:_index|meta|metadata)\.json$)[^/]+\.json`;
const GOOGLE_MAIL_UPSERT_WRITEBACK_PATH = new RegExp(
  `^/google-mail/(?:labels|filters|send-as|messages|threads)/${GOOGLE_MAIL_JSON_FILE}$`,
);
const GOOGLE_MAIL_DELETE_WRITEBACK_PATH = GOOGLE_MAIL_UPSERT_WRITEBACK_PATH;
const LINEAR_ID_SEGMENT =
  String.raw`(?:[A-Za-z0-9_.~-]+(?:--|__))?` +
  String.raw`(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-` +
  String.raw`[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})`;
const LINEAR_DRAFT_FILE = String.raw`(?!${LINEAR_ID_SEGMENT}\.json$)[^/]+\.json`;
const SLACK_ID_SEGMENT = String.raw`[A-Za-z0-9_.:-]+(?:--[A-Za-z0-9_.:-]+)*`;
const SLACK_DRAFT_FILE = String.raw`(?!${SLACK_ID_SEGMENT}\.json$)[^/]+\.json`;
const JSON_FILE_SEGMENT = String.raw`[^/]+\.json`;
const LINEAR_UPSERT_WRITEBACK_PATH = new RegExp(
  `^/linear/(?:issues/(?:${JSON_FILE_SEGMENT}|${LINEAR_ID_SEGMENT}/comments/${LINEAR_DRAFT_FILE})|labels/${JSON_FILE_SEGMENT}|projects/(?:${JSON_FILE_SEGMENT}|${LINEAR_ID_SEGMENT}/(?:meta|add-issues)\\.json))$`,
  "i",
);
const LINEAR_DELETE_WRITEBACK_PATH = new RegExp(
  `^/linear/(?:issues|labels|projects)/${LINEAR_ID_SEGMENT}\\.json$`,
  "i",
);
export const SLACK_UPSERT_WRITEBACK_PATH = new RegExp(
  `^/slack/(?:channels/${SLACK_ID_SEGMENT}/messages/(?:${JSON_FILE_SEGMENT}|${SLACK_ID_SEGMENT}/replies/${JSON_FILE_SEGMENT}|${SLACK_ID_SEGMENT}/reactions/${SLACK_DRAFT_FILE})|users/${SLACK_ID_SEGMENT}/messages/${JSON_FILE_SEGMENT})$`,
);
const SLACK_DELETE_WRITEBACK_PATH = new RegExp(
  `^/slack/channels/${SLACK_ID_SEGMENT}/messages/(?:${SLACK_ID_SEGMENT}\\.json|${SLACK_ID_SEGMENT}/replies/${SLACK_ID_SEGMENT}\\.json|${SLACK_ID_SEGMENT}/reactions/${SLACK_ID_SEGMENT}\\.json)$`,
);
const JIRA_ID_SEGMENT = String.raw`[^/]+`;
const JIRA_UPSERT_WRITEBACK_PATH = new RegExp(
  `^/jira/(?:issues/(?:${JSON_FILE_SEGMENT}|${JIRA_ID_SEGMENT}\\.json|${JIRA_ID_SEGMENT}/comments/${JSON_FILE_SEGMENT}|${JIRA_ID_SEGMENT}/transitions/${JSON_FILE_SEGMENT})|projects/${JSON_FILE_SEGMENT}|sprints/${JIRA_ID_SEGMENT}\\.json)$`,
);
const JIRA_DELETE_WRITEBACK_PATH = new RegExp(
  `^/jira/(?:issues/(?:${JIRA_ID_SEGMENT}\\.json|${JIRA_ID_SEGMENT}/comments/${JIRA_ID_SEGMENT}\\.json)|projects/${JIRA_ID_SEGMENT}\\.json)$`,
);
const CONFLUENCE_ID_SEGMENT = String.raw`(?:[A-Za-z0-9_.~-]+(?:--|__))?\d+`;
const CONFLUENCE_JSON_FILE = String.raw`(?!(?:_index|meta|metadata)\.json$)[^/]+\.json`;
const CONFLUENCE_UPSERT_WRITEBACK_PATH = new RegExp(
  `^/confluence/(?:pages/${CONFLUENCE_JSON_FILE}|spaces/[^/]+/pages/${CONFLUENCE_JSON_FILE})$`,
);
const CONFLUENCE_DELETE_WRITEBACK_PATH = new RegExp(
  `^/confluence/(?:pages/${CONFLUENCE_ID_SEGMENT}\\.json|spaces/[^/]+/pages/${CONFLUENCE_ID_SEGMENT}\\.json)$`,
);
