import { DeployWizard } from "./_components/deploy-wizard";
import type { DeployMode } from "./_lib/types";

type DeployPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default async function DeployPage({ searchParams }: DeployPageProps) {
  const sp = await searchParams;
  const personaUrl = readParam(sp.persona);
  // Launch Agent defaults to live (real persona resolve + deploy). Pass
  // `?live=0` to force the baked-in demo for screenshots / offline previews.
  // We intentionally don't gate on `NEXT_PUBLIC_LAUNCH_AGENT_LIVE`: that env
  // var must be inlined at build time, and a missed inline silently dropped the
  // whole page back to demo even in prod.
  const mode: DeployMode = readParam(sp.live) === "0" ? "demo" : "live";

  return <DeployWizard personaUrl={personaUrl} mode={mode} />;
}
