import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LogoIcon } from "../components/Brand";
import { SigninBackground } from "../components/SigninBackground";
import { ThemeToggle } from "../components/ThemeToggle";
import { WAITLIST_EMAIL_COOKIE, getWaitlistStanding } from "@/lib/waitlist/store";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "You're on the waitlist · Agent Relay",
};

const SHARE_URL = "https://agentrelay.com";
const SHARE_TEXT =
  "I just joined the Agent Relay waitlist — agents that actually get work done. Check it out:";

function linkedInShareHref(): string {
  return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SHARE_URL)}`;
}

function xShareHref(): string {
  return `https://x.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SHARE_URL)}`;
}

function emailShareHref(): string {
  const subject = encodeURIComponent("You should check out Agent Relay");
  const body = encodeURIComponent(`${SHARE_TEXT}\n\n${SHARE_URL}`);
  return `mailto:?subject=${subject}&body=${body}`;
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.34V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </svg>
  );
}

function ShareButton({
  href,
  icon,
  label,
  external = true,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="flex items-center justify-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--surface-glass)] px-4 py-3 text-sm font-semibold text-[var(--fg)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-strong)]"
    >
      {icon}
      {label}
    </a>
  );
}

export default async function WaitlistPage() {
  const cookieStore = await cookies();
  const email = cookieStore.get(WAITLIST_EMAIL_COOKIE)?.value ?? null;
  const standing = await getWaitlistStanding(email);

  return (
    <div className="brand-shell brand-grid">
      <SigninBackground />
      <main className="relative z-10 flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="brand-card signin-card rounded-2xl px-8 py-10">
            <div className="flex flex-col items-center text-center">
              <LogoIcon className="h-10" />
              <h1 className="mt-5 text-2xl font-bold tracking-tight text-[var(--fg)]">
                You&rsquo;re on the waitlist
              </h1>
              <p className="mt-2 text-sm text-[var(--fg-muted)]">
                Thanks for signing up. We&rsquo;ll let you know as soon as you have access.
              </p>

              {standing ? (
                <div className="mt-6 w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-glass)] px-5 py-4">
                  <p className="text-sm text-[var(--fg-muted)]">
                    You&rsquo;re number{" "}
                    <span className="font-bold text-[var(--fg)]">
                      {standing.position.toLocaleString()}
                    </span>{" "}
                    of{" "}
                    <span className="font-bold text-[var(--fg)]">
                      {standing.total.toLocaleString()}
                    </span>{" "}
                    on the waitlist.
                  </p>
                </div>
              ) : null}

              <div className="mt-8 w-full border-t border-[var(--border-default)] pt-6">
                <p className="text-sm font-semibold text-[var(--fg)]">
                  Want to get ahead on the waitlist?
                </p>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">
                  Share Agent Relay on LinkedIn, X, or invite someone by email.
                </p>
                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <ShareButton href={linkedInShareHref()} icon={<LinkedInIcon />} label="LinkedIn" />
                  <ShareButton href={xShareHref()} icon={<XIcon />} label="X" />
                  <ShareButton
                    href={emailShareHref()}
                    icon={<EmailIcon />}
                    label="Email"
                    external={false}
                  />
                </div>
              </div>
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
