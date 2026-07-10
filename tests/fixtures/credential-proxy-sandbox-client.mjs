import { existsSync } from "node:fs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveRequestTarget() {
  if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      url: `${process.env.ANTHROPIC_BASE_URL}/v1/messages`,
      token: process.env.ANTHROPIC_API_KEY,
    };
  }

  if (process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      url: `${process.env.OPENAI_BASE_URL}/v1/responses`,
      token: process.env.OPENAI_API_KEY,
    };
  }

  if (process.env.OPENAI_API_BASE && process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      url: `${process.env.OPENAI_API_BASE}/v1/responses`,
      token: process.env.OPENAI_API_KEY,
    };
  }

  if (process.env.GOOGLE_API_BASE && process.env.GOOGLE_API_KEY) {
    return {
      provider: "google",
      url: `${process.env.GOOGLE_API_BASE}/v1beta/models/gemini-pro:generateContent`,
      token: process.env.GOOGLE_API_KEY,
    };
  }

  throw new Error("No proxy-wired provider environment was found");
}

function assertProxyOnlyCredentialSurface(envSnapshot, allowedToken) {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (key.endsWith("API_KEY") && value !== allowedToken) {
      throw new Error(`Sandbox env contains a non-proxy API key value in ${key}`);
    }
  }
}

async function main() {
  const requestTarget = resolveRequestTarget();
  const requestCount = Number.parseInt(process.env.QA_REQUEST_COUNT ?? "1", 10);
  const credentialPaths = JSON.parse(process.env.QA_CREDENTIAL_PATHS ?? "[]");

  assert(Number.isInteger(requestCount) && requestCount > 0, "QA_REQUEST_COUNT must be a positive integer");
  assert(Array.isArray(credentialPaths), "QA_CREDENTIAL_PATHS must be a JSON array");

  const fileChecks = credentialPaths.map((filePath) => ({
    path: filePath,
    exists: existsSync(filePath),
  }));

  const mountedCredential = fileChecks.find((entry) => entry.exists);
  if (mountedCredential) {
    throw new Error(`Credential file unexpectedly exists in sandbox: ${mountedCredential.path}`);
  }

  const envSnapshot = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => /(API_KEY|BASE_URL|CREDENTIAL_PROXY)/.test(key))
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  assertProxyOnlyCredentialSurface(envSnapshot, requestTarget.token);

  const responses = [];
  for (let index = 0; index < requestCount; index += 1) {
    const response = await fetch(requestTarget.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requestTarget.token}`,
        "Content-Type": "application/json",
        "x-sandbox-probe": `request-${index + 1}`,
      },
      body: JSON.stringify({
        model: "qa-probe",
        max_tokens: 8,
        messages: [{ role: "user", content: `request-${index + 1}` }],
      }),
    });

    let body;
    try {
      body = await response.json();
    } catch {
      body = { parseError: "response was not valid JSON" };
    }

    responses.push({
      status: response.status,
      body,
    });
  }

  process.stdout.write(
    JSON.stringify(
      {
        provider: requestTarget.provider,
        envSnapshot,
        fileChecks,
        responses,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
