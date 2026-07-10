import { z } from "zod";

export const RedditTrackedSubredditSchema = z
  .object({
    id: z.string(),
    subreddit_id: z.string().optional(),
    name: z.string(),
    title: z.string().optional(),
    display_name_prefixed: z.string().optional(),
    url: z.string().optional(),
    public_description: z.string().optional(),
    subscribers: z.number().optional(),
    over18: z.boolean().optional(),
    created_utc: z.number().optional(),
    icon_img: z.string().optional(),
    tracked: z.literal(true),
  })
  .passthrough();

export type RedditTrackedSubredditRecord = z.infer<typeof RedditTrackedSubredditSchema>;

export const RedditPostSchema = z
  .object({
    id: z.string(),
    post_id: z.string(),
    thing_id: z.string().optional(),
    subreddit: z.string(),
    subreddit_name_prefixed: z.string().optional(),
    title: z.string(),
    author: z.string().optional(),
    selftext: z.string().optional(),
    url: z.string().optional(),
    permalink: z.string().optional(),
    created_utc: z.number().optional(),
    edited: z.union([z.boolean(), z.number()]).optional(),
    score: z.number().optional(),
    ups: z.number().optional(),
    downs: z.number().optional(),
    num_comments: z.number().optional(),
    over_18: z.boolean().optional(),
    spoiler: z.boolean().optional(),
    stickied: z.boolean().optional(),
    locked: z.boolean().optional(),
    archived: z.boolean().optional(),
    removed_by_category: z.string().nullable().optional(),
    status: z.enum(["active", "locked", "archived", "removed", "deleted"]).optional(),
  })
  .passthrough();

export type RedditPostRecord = z.infer<typeof RedditPostSchema>;

export interface RawRedditListingChild {
  kind?: string;
  data?: Record<string, unknown>;
}

export interface RawRedditListingResponse {
  kind?: string;
  data?: {
    after?: string | null;
    before?: string | null;
    children?: RawRedditListingChild[];
  };
}

export const normalizeSubredditName = (value: string): string =>
  value.trim().replace(/^r\//i, "").toLowerCase();

const numberOrUndefined = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringOrUndefined = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const booleanOrUndefined = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const derivePostStatus = (raw: Record<string, unknown>): RedditPostRecord["status"] => {
  if (raw["removed_by_category"] !== null && raw["removed_by_category"] !== undefined) {
    return "removed";
  }
  if (raw["author"] === "[deleted]" || raw["selftext"] === "[deleted]") {
    return "deleted";
  }
  if (raw["archived"] === true) {
    return "archived";
  }
  if (raw["locked"] === true) {
    return "locked";
  }
  return "active";
};

export const buildTrackedSubredditRecord = (raw: Record<string, unknown>): RedditTrackedSubredditRecord => {
  const name = normalizeSubredditName(String(raw["display_name"] ?? raw["name"] ?? ""));
  if (!name) {
    throw new Error("Reddit subreddit payload missing display_name/name");
  }

  const sourceId = String(raw["id"] ?? "");
  return RedditTrackedSubredditSchema.parse({
    id: name,
    ...(sourceId ? { subreddit_id: sourceId } : {}),
    name,
    title: stringOrUndefined(raw["title"]),
    display_name_prefixed:
      stringOrUndefined(raw["display_name_prefixed"]) ?? `r/${name}`,
    url: stringOrUndefined(raw["url"]),
    public_description: stringOrUndefined(raw["public_description"]),
    subscribers: numberOrUndefined(raw["subscribers"]),
    over18: booleanOrUndefined(raw["over18"]),
    created_utc: numberOrUndefined(raw["created_utc"]),
    icon_img: stringOrUndefined(raw["icon_img"]),
    tracked: true,
  });
};

export const buildPostRecord = (raw: Record<string, unknown>): RedditPostRecord => {
  const postId = stringOrUndefined(raw["id"]);
  const subreddit = normalizeSubredditName(String(raw["subreddit"] ?? ""));
  if (!postId || !subreddit) {
    throw new Error("Reddit post payload missing id/subreddit");
  }

  const thingId = stringOrUndefined(raw["name"]);
  const permalink = stringOrUndefined(raw["permalink"]);
  const canonicalPermalink = permalink
    ? permalink.startsWith("http")
      ? permalink
      : `https://www.reddit.com${permalink}`
    : undefined;

  return RedditPostSchema.parse({
    id: `${subreddit}/${postId}`,
    post_id: postId,
    thing_id: thingId,
    subreddit,
    subreddit_name_prefixed:
      stringOrUndefined(raw["subreddit_name_prefixed"]) ?? `r/${subreddit}`,
    title: stringOrUndefined(raw["title"]) ?? "(untitled)",
    author: stringOrUndefined(raw["author"]),
    selftext: stringOrUndefined(raw["selftext"]),
    url: stringOrUndefined(raw["url"]),
    permalink: canonicalPermalink,
    created_utc: numberOrUndefined(raw["created_utc"]),
    edited:
      typeof raw["edited"] === "boolean" || typeof raw["edited"] === "number"
        ? (raw["edited"] as boolean | number)
        : undefined,
    score: numberOrUndefined(raw["score"]),
    ups: numberOrUndefined(raw["ups"]),
    downs: numberOrUndefined(raw["downs"]),
    num_comments: numberOrUndefined(raw["num_comments"]),
    over_18: booleanOrUndefined(raw["over_18"]),
    spoiler: booleanOrUndefined(raw["spoiler"]),
    stickied: booleanOrUndefined(raw["stickied"]),
    locked: booleanOrUndefined(raw["locked"]),
    archived: booleanOrUndefined(raw["archived"]),
    removed_by_category:
      typeof raw["removed_by_category"] === "string"
        ? raw["removed_by_category"]
        : raw["removed_by_category"] === null
          ? null
          : undefined,
    status: derivePostStatus(raw),
  });
};
