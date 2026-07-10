import Link from "next/link";

function XIcon() {
  return <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
}

function GitHubIcon() {
  return <svg viewBox="0 0 16 16" fill="currentColor" className="h-5 w-5"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>;
}

const footerLinks = { Product: [{ label: "Documentation", href: "https://docs.agent-relay.com" }, { label: "Examples", href: "/examples" }, { label: "Observer", href: "/observer" }, { label: "Pricing", href: "/pricing" }, { label: "Changelog", href: "/changelog" }], Company: [{ label: "About Us", href: "/about" }, { label: "Careers", href: "/careers" }, { label: "Blog", href: "/blog" }, { label: "Contact", href: "mailto:hello@agentrelay.com" }], Resources: [{ label: "GitHub", href: "https://github.com/AgentWorkforce/relay" }, { label: "Community", href: "https://github.com/AgentWorkforce/relay/discussions" }, { label: "Status", href: "https://status.agentrelay.com" }], Legal: [{ label: "Privacy Policy", href: "/privacy" }, { label: "Terms of Service", href: "/terms" }] };

export function Footer() {
  return (
    <footer className="relative z-10 border-t border-[var(--footer-line)] bg-[var(--footer-bg)] text-[var(--footer-fg)]">
      <div className="mx-auto max-w-7xl px-4 py-16">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-5">
          <div className="col-span-2 md:col-span-1">
            <Link href="/" className="text-[var(--footer-fg)]">
              <span className="text-lg font-semibold tracking-tight">Agent Relay</span>
            </Link>
            <p className="mt-4 text-sm leading-relaxed text-[var(--footer-muted)]">An SDK for building agents that communicate, coordinate, and take action.</p>
            <div className="mt-6 flex items-center gap-4 text-[var(--footer-faint)]">
              <a href="https://github.com/AgentWorkforce/relay" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[var(--footer-fg)]"><GitHubIcon /></a>
              <a href="https://x.com/agent_relay" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-[var(--footer-fg)]"><XIcon /></a>
            </div>
          </div>
          {Object.entries(footerLinks).map(([heading, links]) => (
            <div key={heading}>
              <h3 className="text-sm font-semibold text-[var(--footer-fg)]">{heading}</h3>
              <ul className="mt-4 space-y-3">
                {links.map((link) => (
                  <li key={link.label}>
                    {link.href.startsWith("http") || link.href.startsWith("mailto") ? (
                      <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--footer-muted)] transition-colors hover:text-[var(--footer-fg)]">{link.label}</a>
                    ) : (
                      <Link href={link.href} className="text-sm text-[var(--footer-muted)] transition-colors hover:text-[var(--footer-fg)]">{link.label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-[var(--footer-line)] pt-8 md:flex-row">
          <p className="text-sm text-[var(--footer-faint)]">&copy; {new Date().getFullYear()} Agent Relay. All rights reserved.</p>
          <div className="flex items-center gap-2 text-sm text-[var(--footer-faint)]">Built for the agentic era<span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "var(--brand-primary)", boxShadow: "0 0 10px color-mix(in srgb, var(--brand-primary) 65%, transparent)" }} /></div>
        </div>
      </div>
    </footer>
  );
}
