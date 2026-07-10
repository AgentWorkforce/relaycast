/**
 * Deployable-agent catalog for the deploy-centered dashboard, sourced from the
 * published `AgentWorkforce/agents` repo at runtime so we DON'T vendor agent
 * definitions into cloud:
 *
 *   - which agents exist → repo directory listing (disk in dev, GitHub trees
 *     API in prod) filtered to those with a committed `persona.ts`
 *   - cloud-deployable?   → `cloud: true` in persona.ts (committed)
 *   - card art            → public raw.githubusercontent.com/.../card-sm.png
 *                           (agents without one fall back to generated art)
 *   - name                → README.md H1 (committed)
 *   - tagline             → persona.ts `description:` (committed)
 *
 * In local dev we read the sibling `../agents` checkout (fast, offline);
 * otherwise we fetch the committed files from raw GitHub. Built-in labels are
 * only a graceful fallback — never the source of truth.
 */

// Disk reads are a local-dev convenience only. In the deployed Cloudflare
// Worker there is no filesystem, so we never import `node:fs` statically (that
// would break the OpenNext-CF bundle) — it's lazily imported behind a dev gate
// and the prod path uses GitHub (trees API + raw.githubusercontent.com).
const IS_DEV = process.env.NODE_ENV !== "production";

async function nodeFs() {
  const [fsmod, pathmod] = await Promise.all([import("node:fs"), import("node:path")]);
  return { fs: fsmod.promises, path: pathmod.default };
}

const REPO = "AgentWorkforce/agents";
const BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

/** Curated agents to feature in the empty state, in order. */
const FEATURED_SLUGS = ["review", "linear", "hn-monitor"] as const;

/** Graceful fallback labels (used only if both disk + network reads fail). */
const FALLBACK: Record<string, { name: string; tagline: string }> = {
  review: { name: "Review Agent", tagline: "Reviews every PR and merges once you approve." },
  linear: { name: "Linear Agent", tagline: "Implements labelled Linear issues and opens the PR." },
  "hn-monitor": { name: "Hacker News Monitor", tagline: "Scans HN for your topics and posts a digest to Slack." },
};

const ACRONYMS = new Set(["hn", "gcp", "ai", "pr", "ci"]);

export interface CatalogAgent {
  slug: string;
  name: string;
  tagline: string;
  /** Card art URL, or null when the agent ships no image (→ generated art). */
  imageUrl: string | null;
  deployHref: string;
}

/** Featured agents always have card art, so imageUrl is non-null. */
export interface FeaturedAgent extends CatalogAgent {
  imageUrl: string;
}

function blobUrl(slug: string): string {
  return `https://github.com/${REPO}/blob/${BRANCH}/${slug}/persona.ts`;
}

function deployHref(slug: string): string {
  return `/deploy?persona=${encodeURIComponent(blobUrl(slug))}`;
}

function titleize(slug: string): string {
  return slug
    .split("-")
    .map((part) => (ACRONYMS.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/**
 * Extract the README display name from its FIRST heading only (Setext or ATX),
 * so a later section heading can never be mistaken for the title. ATX titles in
 * this repo are often the bare lowercase slug (e.g. "# inbox-buddy"); in that
 * case return null so the caller can titleize the slug ("Inbox Buddy") instead.
 */
function nameFromReadme(readme: string | null): string | null {
  if (!readme) return null;
  const lines = readme.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("<")) continue; // skip blanks + banner <img>

    const atx = line.match(/^#\s+(.+?)(?:\s+#+)?$/);
    if (atx) {
      const heading = atx[1].trim();
      // Use the ATX title only when it reads like a name, not the bare slug.
      return heading && (/[A-Z]/.test(heading) || /\s/.test(heading)) ? heading : null;
    }

    // Setext H1: this text line sits directly above a `====` underline.
    if (i + 1 < lines.length && /^={3,}\s*$/.test(lines[i + 1].trim())) {
      return line;
    }

    // First meaningful line is neither a heading nor a Setext title → no title.
    return null;
  }
  return null;
}

/** Pull the `description: '...'` value out of a committed persona.ts. */
function taglineFromPersonaTs(source: string | null): string | null {
  if (!source) return null;
  // Allow escaped quotes of the delimiter type inside the string (e.g. It\'s),
  // then unescape \' \" \` \\ so the literal backslash doesn't reach the UI.
  const match = source.match(/description:\s*(['"`])((?:[^\\]|\\.)*?)\1/);
  return match ? match[2].replace(/\\(['"`\\])/g, "$1").trim() : null;
}

function diskRoots(path: Awaited<ReturnType<typeof nodeFs>>["path"]): string[] {
  // Dev only: AgentWorkforce/agents is a repo sibling. Web dev server cwd is
  // packages/web (→ ../../../agents); cover a repo-root cwd too.
  return [
    path.resolve(process.cwd(), "../../../agents"),
    path.resolve(process.cwd(), "../../agents"),
  ];
}

async function readDisk(slug: string, file: string): Promise<string | null> {
  if (!IS_DEV) return null;
  try {
    const { fs, path } = await nodeFs();
    for (const root of diskRoots(path)) {
      try {
        return await fs.readFile(path.join(root, slug, file), "utf8");
      } catch {
        // try next root
      }
    }
  } catch {
    // node:fs unavailable — fall back to network
  }
  return null;
}

async function readRaw(slug: string, file: string): Promise<string | null> {
  try {
    // globalThis.fetch (not bare fetch): this runs in the OpenNext-CF Worker,
    // where a hoisted bare fetch can throw "Illegal invocation" under
    // nodejs_compat (see packages/AGENTS.md).
    const res = await globalThis.fetch(`${RAW_BASE}/${slug}/${file}`, {
      next: { revalidate: 3600 },
    } as RequestInit);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function readSource(slug: string, file: string): Promise<string | null> {
  return (await readDisk(slug, file)) ?? (await readRaw(slug, file));
}

interface Listing {
  slugs: string[];
  hasImage: Set<string>;
}

/** Enumerate agent dirs from the sibling checkout (dev). */
async function listFromDisk(): Promise<Listing | null> {
  if (!IS_DEV) return null;
  let fs: Awaited<ReturnType<typeof nodeFs>>["fs"];
  let path: Awaited<ReturnType<typeof nodeFs>>["path"];
  try {
    ({ fs, path } = await nodeFs());
  } catch {
    return null;
  }
  for (const root of diskRoots(path)) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const slugs: string[] = [];
      const hasImage = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const slug = entry.name;
        try {
          await fs.access(path.join(root, slug, "persona.ts"));
        } catch {
          continue;
        }
        slugs.push(slug);
        try {
          await fs.access(path.join(root, slug, "card-sm.png"));
          hasImage.add(slug);
        } catch {
          // no card art → generated art
        }
      }
      if (slugs.length) return { slugs, hasImage };
    } catch {
      // try next root
    }
  }
  return null;
}

/** Enumerate agent dirs from the GitHub tree (prod) in a single request. */
async function listFromRaw(): Promise<Listing | null> {
  try {
    const res = await globalThis.fetch(
      `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
      { next: { revalidate: 3600 }, headers: { Accept: "application/vnd.github+json" } } as RequestInit,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { tree?: Array<{ path: string }> };
    if (!Array.isArray(data.tree)) return null;
    const slugs = new Set<string>();
    const hasImage = new Set<string>();
    for (const node of data.tree) {
      const persona = node.path.match(/^([^/]+)\/persona\.ts$/);
      if (persona) slugs.add(persona[1]);
      const image = node.path.match(/^([^/]+)\/card-sm\.png$/);
      if (image) hasImage.add(image[1]);
    }
    return { slugs: [...slugs], hasImage };
  } catch {
    return null;
  }
}

interface BuiltAgent extends CatalogAgent {
  cloud: boolean;
}

async function buildAgent(slug: string, hasImage: boolean): Promise<BuiltAgent> {
  // Derive everything from committed files (persona.ts + README) so dev and
  // prod agree. persona.json is gitignored / unpublished, so relying on it
  // would list agents in dev that vanish from the prod catalog.
  const [readme, personaTs] = await Promise.all([
    readSource(slug, "README.md"),
    readSource(slug, "persona.ts"),
  ]);

  const cloud = personaTs ? /\bcloud:\s*true\b/.test(personaTs) : false;

  const name = nameFromReadme(readme) ?? FALLBACK[slug]?.name ?? titleize(slug);
  const tagline = taglineFromPersonaTs(personaTs) ?? FALLBACK[slug]?.tagline ?? "";

  return {
    slug,
    name,
    tagline,
    imageUrl: hasImage ? `${RAW_BASE}/${slug}/card-sm.png` : null,
    deployHref: deployHref(slug),
    cloud,
  };
}

/** All cloud-deployable agents, card-art first then alphabetical. */
export async function loadCatalogAgents(): Promise<CatalogAgent[]> {
  const listing = (await listFromDisk()) ?? (await listFromRaw());
  if (!listing) {
    return loadFeaturedAgents();
  }

  const built = await Promise.all(
    listing.slugs.map((slug) => buildAgent(slug, listing.hasImage.has(slug))),
  );

  return built
    .filter((agent) => agent.cloud)
    .sort(
      (a, b) =>
        Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl)) || a.name.localeCompare(b.name),
    )
    .map(({ cloud: _cloud, ...agent }) => agent);
}

/** The curated featured trio for the empty state. */
export async function loadFeaturedAgents(): Promise<FeaturedAgent[]> {
  const built = await Promise.all(FEATURED_SLUGS.map((slug) => buildAgent(slug, true)));
  return built.map(({ cloud: _cloud, imageUrl, ...rest }) => ({
    ...rest,
    imageUrl: imageUrl ?? `${RAW_BASE}/${rest.slug}/card-sm.png`,
  }));
}
