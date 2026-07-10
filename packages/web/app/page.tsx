import type { Metadata } from "next";
import { buildGoogleAuthHref } from "@/lib/auth/google-redirect";
import { toAppPath } from "@/lib/app-path";
import { LogoIcon } from "./components/Brand";
import { SigninBackground } from "./components/SigninBackground";
import { ThemeToggle } from "./components/ThemeToggle";

export const metadata: Metadata = {
  alternates: {
    canonical: "https://agentrelay.com/cloud",
  },
};

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
    </svg>
  );
}

type HomeProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstSearchParamValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default async function Home({ searchParams }: HomeProps) {
  const devLoginEnabled = process.env.NEXT_PUBLIC_SST_STAGE === "development";
  const params = await searchParams;
  const loginInviteToken =
    firstSearchParamValue(params?.invite_token) ??
    firstSearchParamValue(params?.inviteToken) ??
    firstSearchParamValue(params?.invite);

  return (
    <div className="brand-shell brand-grid">
      <SigninBackground />
      <main className="relative z-10 flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="brand-card signin-card rounded-2xl px-8 py-10">
            <div className="flex flex-col items-center text-center">
              <LogoIcon className="h-10" />
              <h1 className="mt-5 text-2xl font-bold tracking-tight text-[var(--fg)]">
                Sign in to Agent Relay
              </h1>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">
                Sign in to access your dashboard.
              </p>
              <a
                href={buildGoogleAuthHref("/dashboard", { loginInviteToken })}
                className="mt-8 flex w-full items-center justify-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--surface-glass)] px-5 py-3 text-sm font-semibold text-[var(--fg)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-strong)]"
              >
                <GoogleIcon />
                Sign in with Google
              </a>
              {devLoginEnabled ? (
                <a
                  href={toAppPath("/api/auth/dev-login")}
                  className="mt-3 flex w-full items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--border-strong)] bg-transparent px-5 py-3 text-sm font-semibold text-[var(--fg-muted)] transition-colors hover:bg-[var(--surface-glass)]"
                >
                  Dev login (local, no Google)
                </a>
              ) : null}
            </div>
          </div>
        </div>
      </main>
      <ThemeToggle
        className="fixed bottom-5 left-5 z-20 h-9 w-9 backdrop-blur-sm"
        hoverBgClassName="hover:bg-[var(--surface-glass)]"
      />
    </div>
  );
}
