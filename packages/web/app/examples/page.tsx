"use client";

import { Footer } from "../components/Footer";
import { Header } from "../components/Header";
import { CodeBlock } from "../components/SyntaxHighlight";

interface Example { title: string; description: string; badge: string; code: string; language: "typescript" | "yaml"; }

const examples: Example[] = [
  { title: "Hello, Agent", badge: "Basics", language: "typescript", description: "Spawn a single Claude agent, send it a message, and shut down. The simplest possible use of Agent Relay.", code: `import { AgentRelay } from "@agent-relay/sdk";\n\nconst relay = new AgentRelay();\n\nconst agent = await relay.claude.spawn({ name: "Helper" });\n\nconst human = relay.human({ name: "User" });\nawait human.sendMessage({\n  to: "Helper",\n  text: "Summarize the key ideas in README.md.",\n});\n\nawait agent.waitForIdle();\nawait relay.shutdown();` },
  { title: "Two agents, one channel", badge: "Channels", language: "typescript", description: "Put two agents on a shared channel so they can see each other's messages and collaborate.", code: `import { AgentRelay } from "@agent-relay/sdk";\n\nconst relay = new AgentRelay({ channels: ["design-review"] });\n\nawait relay.claude.spawn({\n  name: "Designer",\n  task: "Propose a clean API for a rate limiter.",\n});\n\nawait relay.claude.spawn({\n  name: "Reviewer",\n  task: "Review the API proposal and suggest improvements.",\n});\n\nconst human = relay.human({ name: "PM" });\nawait human.sendMessage({\n  to: "design-review",\n  text: "Start the review. Designer goes first.",\n});` },
  { title: "Mixed model collaboration", badge: "Multi-model", language: "typescript", description: "Pair Claude with Codex. Claude plans the architecture, Codex writes the implementation.", code: `import { AgentRelay } from "@agent-relay/sdk";\n\nconst relay = new AgentRelay({ channels: ["implementation"] });\n\nawait relay.claude.spawn({\n  name: "Architect",\n  task: "Design the module structure, then hand off to Builder.",\n});\n\nawait relay.codex.spawn({\n  name: "Builder",\n  task: "Implement whatever Architect designs. Run tests after.",\n});\n\nconst director = relay.human({ name: "Director" });\nawait director.sendMessage({\n  to: "implementation",\n  text: "Build a JWT auth middleware. Architect plans, Builder codes.",\n});` },
];

function ExampleCard({ example, index }: { example: Example; index: number }) {
  return <div className="brand-card space-y-5 rounded-[28px] p-6"><div className="flex items-start gap-4"><span className="mt-1 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-glass)] text-sm font-semibold text-[var(--text-secondary)]">{index + 1}</span><div className="space-y-2"><div className="flex flex-wrap items-center gap-3"><h3 className="text-lg font-semibold text-[var(--fg)]">{example.title}</h3><span className="rounded-full border border-[var(--border-default)] bg-[var(--surface-glass)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]">{example.badge}</span></div><p className="max-w-2xl text-sm leading-6 text-[var(--fg-muted)]">{example.description}</p></div></div><CodeBlock code={example.code} language={example.language} /></div>;
}

export default function Examples() {
  return <div className="brand-shell brand-grid"><Header /><main className="relative z-10"><div className="mx-auto max-w-5xl px-4 pb-24 pt-16 md:pt-24"><div className="brand-card rounded-[32px] p-8 md:p-10"><div className="max-w-3xl"><div className="inline-flex rounded-full border border-[var(--border-default)] bg-[var(--surface-glass)] px-3 py-1 text-xs font-medium uppercase tracking-[0.22em] text-[var(--text-secondary)]">Examples</div><h1 className="mt-5 text-4xl font-bold tracking-tight text-[var(--fg)] sm:text-5xl">Build from simple prompts to full swarms</h1><p className="mt-4 text-lg leading-8 text-[var(--fg-muted)]">Learn Agent Relay step by step. Each example builds on the last, from spawning your first agent to orchestrating parallel swarms.</p></div></div><div className="mt-10 space-y-8">{examples.map((example, i) => <ExampleCard key={i} example={example} index={i} />)}</div></div></main><Footer /></div>;
}
