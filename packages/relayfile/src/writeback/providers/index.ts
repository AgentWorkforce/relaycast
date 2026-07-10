import type {
  DispatchResult,
  IntegrationCredential,
  ProviderDispatchOptions,
  WritebackEnv,
  WritebackInput,
} from "../types.js";
import * as confluence from "./confluence.js";
import * as github from "./github.js";
import * as googleMail from "./google-mail.js";
import * as jira from "./jira.js";
import * as linear from "./linear.js";
import * as notion from "./notion.js";
import * as slack from "./slack.js";

export async function dispatchProviderWriteback(
  input: WritebackInput,
  cred: IntegrationCredential,
  env: WritebackEnv,
  options: ProviderDispatchOptions = {},
): Promise<DispatchResult> {
  switch (input.provider) {
    case "confluence":
      return confluence.dispatch(input, cred, env, options);
    case "github":
      return github.dispatch(input, cred, env, options);
    case "google-mail":
      return googleMail.dispatch(input, cred, env, options);
    case "jira":
      return jira.dispatch(input, cred, env, options);
    case "linear":
      return linear.dispatch(input, cred, env, options);
    case "notion":
      return notion.dispatch(input, cred, env, options);
    case "slack":
      return slack.dispatch(input, cred, env, options);
  }
}
