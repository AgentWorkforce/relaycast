import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunPanel } from './RunPanel';

describe('RunPanel', () => {
  it('renders each step state as text instead of relying on icon color', () => {
    const html = renderToStaticMarkup(<RunPanel run={{
      runId: '01TEST',
      flow: 'review',
      status: 'running',
      steps: [
        { id: 'inspect', type: 'deterministic', dependsOn: [], state: 'running' },
        { id: 'report', type: 'agent', dependsOn: ['inspect'], state: 'pending' },
      ],
    }} />);

    expect(html).toContain('running · deterministic');
    expect(html).toContain('pending · agent');
  });
});
