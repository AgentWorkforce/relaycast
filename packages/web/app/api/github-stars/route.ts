const REPO = "AgentWorkforce/relay";

export async function GET() {
  let count = 0;

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      next: { revalidate: 86400 },
    });

    if (res.ok) {
      const data = await res.json();
      count = typeof data.stargazers_count === "number" ? data.stargazers_count : 0;
    }
  } catch {
    count = 0;
  }

  return Response.json({ stars: count });
}
