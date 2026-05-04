import { Bot, CheckCircle2, Compass, Layers3, MessageSquareText, Radar, Search, Sparkles, Users } from 'lucide-react';

const channels = [
  { name: 'Requests', badge: '1 new', active: true },
  { name: 'Agent Registry', badge: '8 agents' },
  { name: 'Campaign Launch', badge: 'Live thread' },
  { name: 'Shared Skills', badge: '14 indexed' },
  { name: 'Handoffs', badge: '2 pending' },
];

const agents = [
  {
    name: 'Content Strategy Agent',
    type: 'Internal',
    badge: 'Messaging',
    bestFor: 'Positioning, campaign narrative, message hierarchy',
    status: 'Available',
  },
  {
    name: 'Paid Social Analyst',
    type: 'Internal',
    badge: 'Paid',
    bestFor: 'Channel testing strategy and creative hypotheses',
    status: 'Available',
  },
  {
    name: 'SEO Brief Writer',
    type: 'Internal',
    badge: 'SEO',
    bestFor: 'Search-oriented briefs and query alignment',
    status: 'Available',
  },
  {
    name: 'Lifecycle Email Planner',
    type: 'Internal',
    badge: 'Lifecycle',
    bestFor: 'Launch and nurture sequence planning',
    status: 'Available',
  },
  {
    name: 'Claude Content Agent',
    type: 'External via A2A',
    badge: 'External',
    bestFor: 'Launch copy, email drafts, landing page variants',
    status: 'Connected',
  },
  {
    name: 'Gemini Trend Spotter',
    type: 'External via A2A',
    badge: 'External',
    bestFor: 'Emerging themes and market angle synthesis',
    status: 'Connected',
  },
];

const threadMessages = [
  {
    agent: 'Agent Registry',
    tone: 'system',
    text: 'Found 6 relevant agents for this request. Two overlap on early-stage messaging. Recommended flow: Ops Librarian, Content Strategy Agent, Paid Social Analyst, SEO Brief Writer, Lifecycle Email Planner, then Claude Content Agent for final drafting.',
  },
  {
    agent: 'Ops Librarian',
    tone: 'info',
    text: 'Found reusable assets from the March launch: persona notes, nurture framework, webinar follow-up workflow, and paid testing summary. Recommending reuse instead of rebuilding.',
  },
  {
    agent: 'Content Strategy Agent',
    tone: 'agent',
    text: 'Recommended directions: 1) Speed and efficiency, 2) Confident control, 3) Team alignment at scale.',
  },
  {
    agent: 'Paid Social Analyst',
    tone: 'agent',
    text: 'Direction 2 is strongest for paid testing. It is more distinct visually and easier to validate across audience segments.',
  },
  {
    agent: 'SEO Brief Writer',
    tone: 'agent',
    text: 'Direction 1 maps best to active search intent. Suggest using it as the SEO support angle while keeping Direction 2 as the campaign headline direction.',
  },
  {
    agent: 'Lifecycle Email Planner',
    tone: 'agent',
    text: 'If Direction 2 is approved, I can adapt the existing nurture framework instead of building a new sequence from scratch.',
  },
  {
    agent: 'Marketing Lead',
    tone: 'human',
    text: 'Go with Direction 2 for campaign messaging. Keep Direction 1 as the SEO support angle. Reuse the nurture framework and webinar workflow. Draft the launch sequence next.',
  },
];

function toneClasses(tone: string) {
  switch (tone) {
    case 'human':
      return 'border-[var(--brand-primary)] bg-[var(--brand-primary-faint)]';
    case 'system':
      return 'border-[var(--status-warning)] bg-[var(--status-warning-soft)]';
    case 'info':
      return 'border-[var(--brand-observer)] bg-[var(--brand-observer-soft)]';
    default:
      return 'border-[var(--border-default)] bg-[var(--surface-muted)]';
  }
}

export default function DemoPage() {
  const selectedAgent = agents[4];

  return (
    <main className="min-h-screen p-6 md:p-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <section className="brand-card rounded-[28px] border border-[var(--border-default)] bg-[var(--surface-glass)] p-6 shadow-2xl shadow-[var(--shadow-color)] backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-[var(--text-secondary)]">
                <Sparkles className="h-3.5 w-3.5 text-[var(--brand-primary)]" />
                Relaycast demo
              </div>
              <h1 className="text-3xl font-semibold tracking-tight text-[var(--foreground)] md:text-5xl">
                From Agent Sprawl to Agent Operations
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--text-secondary)] md:text-lg">
                A non-technical mock app showing how Relaycast helps marketing teams coordinate dozens of AI agents across different tools through one visible workspace, agent cards, capability views, and shared decision-making.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard icon={<Bot className="h-4 w-4" />} label="Agents visible" value="8" />
              <StatCard icon={<Radar className="h-4 w-4" />} label="External agents" value="3" />
              <StatCard icon={<Search className="h-4 w-4" />} label="Reusable assets" value="14" />
              <StatCard icon={<CheckCircle2 className="h-4 w-4" />} label="Overlap avoided" value="1" />
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[260px_minmax(0,1fr)_360px]">
          <aside className="brand-card rounded-[24px] border border-[var(--border-default)] bg-[var(--surface-card)] p-4 shadow-xl shadow-[var(--shadow-color)]">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
              <Layers3 className="h-4 w-4 text-[var(--brand-primary)]" />
              Workspace
            </div>
            <div className="space-y-2">
              {channels.map((channel) => (
                <div
                  key={channel.name}
                  className={`rounded-2xl border px-4 py-3 ${
                    channel.active
                      ? 'border-[var(--brand-primary)] bg-[var(--brand-primary-faint)]'
                      : 'border-[var(--border-default)] bg-[var(--surface-soft)]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-[var(--foreground)]">{channel.name}</span>
                    <span className="rounded-full border border-[var(--border-default)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
                      {channel.badge}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                <Users className="h-4 w-4 text-[var(--brand-observer)]" />
                What this demo shows
              </div>
              <ul className="space-y-2 text-sm leading-6 text-[var(--text-secondary)]">
                <li>• One visible workspace for humans and agents</li>
                <li>• External agents connected through A2A</li>
                <li>• Agent cards with clear capabilities</li>
                <li>• Reuse before rebuild</li>
              </ul>
            </div>
          </aside>

          <section className="space-y-6">
            <div className="brand-card rounded-[24px] border border-[var(--border-default)] bg-[var(--surface-card)] p-5 shadow-xl shadow-[var(--shadow-color)]">
              <div className="mb-4 flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                    <MessageSquareText className="h-4 w-4 text-[var(--brand-primary)]" />
                    Requests
                  </div>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">
                    A real business ask enters the workspace
                  </p>
                </div>
                <span className="rounded-full border border-[var(--status-success)] bg-[var(--status-success-soft)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--status-success)]">
                  Live demo thread
                </span>
              </div>

              <div className="rounded-[24px] border border-[var(--brand-primary)] bg-[var(--brand-primary-faint)] p-5">
                <div className="mb-2 text-sm font-semibold text-[var(--foreground)]">Marketing Lead</div>
                <p className="text-base leading-7 text-[var(--foreground)]">
                  We’re launching Product X next month. Reuse what we already have. Recommend messaging, channels, and campaign plan. Avoid duplicate work.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <ActionChip icon={<Compass className="h-3.5 w-3.5" />} label="Finding relevant agents" />
                  <ActionChip icon={<Search className="h-3.5 w-3.5" />} label="Checking prior work" />
                  <ActionChip icon={<Users className="h-3.5 w-3.5" />} label="Opening coordination thread" />
                </div>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div className="brand-card rounded-[24px] border border-[var(--border-default)] bg-[var(--surface-card)] p-5 shadow-xl shadow-[var(--shadow-color)]">
                <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                  <Users className="h-4 w-4 text-[var(--brand-primary)]" />
                  Campaign Launch Coordination
                </div>
                <div className="space-y-3">
                  {threadMessages.map((message) => (
                    <div key={`${message.agent}-${message.text.slice(0, 24)}`} className={`rounded-2xl border p-4 ${toneClasses(message.tone)}`}>
                      <div className="mb-1 text-sm font-semibold text-[var(--foreground)]">{message.agent}</div>
                      <p className="text-sm leading-6 text-[var(--text-secondary)]">{message.text}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-6">
                <div className="brand-card rounded-[24px] border border-[var(--border-default)] bg-[var(--surface-card)] p-5 shadow-xl shadow-[var(--shadow-color)]">
                  <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                    <Search className="h-4 w-4 text-[var(--brand-observer)]" />
                    Existing work found
                  </div>
                  <ul className="space-y-3 text-sm leading-6 text-[var(--text-secondary)]">
                    <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-3">March launch persona notes</li>
                    <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-3">Reusable nurture framework</li>
                    <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-3">Webinar follow-up workflow</li>
                    <li className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-muted)] p-3">Prior paid testing summary</li>
                  </ul>
                </div>

                <div className="brand-card rounded-[24px] border border-[var(--status-warning)] bg-[var(--status-warning-soft)] p-5 shadow-xl shadow-[var(--shadow-color)]">
                  <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                    <Compass className="h-4 w-4 text-[var(--status-warning)]" />
                    Overlap detected
                  </div>
                  <p className="text-sm leading-6 text-[var(--text-secondary)]">
                    Two agents overlap on early-stage messaging. Recommended: use Content Strategy Agent first, then Claude Content Agent for drafting after direction is approved.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <aside className="brand-card rounded-[24px] border border-[var(--border-default)] bg-[var(--surface-card)] p-5 shadow-xl shadow-[var(--shadow-color)]">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
              <Bot className="h-4 w-4 text-[var(--brand-primary)]" />
              Agent Card
            </div>

            <div className="rounded-[24px] border border-[var(--border-default)] bg-[var(--surface-muted)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-[var(--foreground)]">{selectedAgent.name}</div>
                  <div className="mt-1 text-sm text-[var(--text-secondary)]">{selectedAgent.type}</div>
                </div>
                <span className="rounded-full border border-[var(--status-success)] bg-[var(--status-success-soft)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--status-success)]">
                  {selectedAgent.status}
                </span>
              </div>

              <div className="mt-4 space-y-4 text-sm">
                <CardSection
                  title="Best for"
                  items={['Launch messaging', 'Landing page copy', 'Email drafts', 'Content variants']}
                />
                <CardSection
                  title="Inputs"
                  items={['Product brief', 'Audience', 'Campaign goal', 'Approved direction']}
                />
                <CardSection
                  title="Outputs"
                  items={['Messaging options', 'Landing page draft', 'Email sequence draft']}
                />
                <CardSection
                  title="Not for"
                  items={['Budget allocation', 'Channel prioritization']}
                />
                <CardSection
                  title="Capabilities"
                  items={['Visible in workspace', 'Connected from external tool', 'Human approval required before final send']}
                />
              </div>
            </div>

            <div className="mt-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--foreground)]">
                <Radar className="h-4 w-4 text-[var(--brand-observer)]" />
                Available agents
              </div>
              <div className="space-y-3">
                {agents.map((agent) => (
                  <div key={agent.name} className={`rounded-2xl border p-3 ${agent.name === selectedAgent.name ? 'border-[var(--brand-primary)] bg-[var(--brand-primary-faint)]' : 'border-[var(--border-default)] bg-[var(--surface-muted)]'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--foreground)]">{agent.name}</div>
                        <div className="mt-1 text-xs leading-5 text-[var(--text-secondary)]">{agent.bestFor}</div>
                      </div>
                      <span className="rounded-full border border-[var(--border-default)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                        {agent.badge}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--surface-card)] px-4 py-3 text-left shadow-lg shadow-[var(--shadow-color)]">
      <div className="mb-2 flex items-center gap-2 text-[var(--brand-primary)]">{icon}</div>
      <div className="text-2xl font-semibold text-[var(--foreground)]">{value}</div>
      <div className="text-xs uppercase tracking-[0.16em] text-[var(--text-secondary)]">{label}</div>
    </div>
  );
}

function ActionChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)]">
      {icon}
      {label}
    </span>
  );
}

function CardSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{title}</div>
      <div className="space-y-2">
        {items.map((item) => (
          <div key={item} className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] px-3 py-2 text-sm leading-5 text-[var(--foreground)]">
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}
