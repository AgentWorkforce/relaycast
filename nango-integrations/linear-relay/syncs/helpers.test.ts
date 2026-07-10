import { describe, expect, it } from 'vitest';

import { LinearActiveIssueSchema, toLinearActiveIssueRecord, type LinearIssueNode } from './helpers.js';

// A representative Linear GraphQL node as returned by FetchActiveIssues /
// GetIssue — the shape the live sync actually receives. The record MUST
// preserve state.id, team {id,key,name}, and labels so the downstream
// relayfile adapter + factory can resolve the issue's state to a role.
const node: LinearIssueNode = {
    id: '082c0ee9-acf3-4e8a-8800-ce4d2fc9b6ec',
    identifier: 'AR-305',
    title: '[factory] Add a CLI flag to redact secrets from log output',
    description: 'Make it configurable.',
    state: { id: 'b9bec744-b60c-4745-8022-d90d6ab59ae3', name: 'Ready for Agent', type: 'unstarted' },
    priority: 2,
    assignee: { id: 'user-1', name: 'Khaliq' },
    team: { id: 'team-ar', key: 'AR', name: 'Agent Relay' },
    labels: { nodes: [{ id: 'label-1', name: 'pear', color: '#fff' }] },
    url: 'https://linear.app/agent-relay/issue/AR-305',
    createdAt: '2026-06-18T12:00:00.000Z',
    updatedAt: '2026-06-18T12:00:00.000Z'
};

describe('toLinearActiveIssueRecord — sync fidelity', () => {
    it('preserves state.id, team, and labels (not just names)', () => {
        const record = toLinearActiveIssueRecord(node);

        // The regression guard: a sparse projection dropped these, breaking
        // factory dispatch. state.id is the load-bearing field.
        expect(record.state).toEqual({ id: 'b9bec744-b60c-4745-8022-d90d6ab59ae3', name: 'Ready for Agent', type: 'unstarted' });
        expect(record.state_id).toBe('b9bec744-b60c-4745-8022-d90d6ab59ae3');
        expect(record.state_name).toBe('Ready for Agent');
        expect(record.team).toEqual({ id: 'team-ar', key: 'AR', name: 'Agent Relay' });
        expect(record.team_id).toBe('team-ar');
        expect(record.team_key).toBe('AR');
        expect(record.labels).toEqual([{ id: 'label-1', name: 'pear', color: '#fff' }]);
    });

    it('emits a record that validates against the model schema', () => {
        expect(() => LinearActiveIssueSchema.parse(toLinearActiveIssueRecord(node))).not.toThrow();
    });

    it('tolerates a node missing state/team/labels without throwing', () => {
        const sparse: LinearIssueNode = { id: 'x', identifier: 'AR-1', title: 't', url: 'u', createdAt: 'c', updatedAt: 'u2' };
        const record = toLinearActiveIssueRecord(sparse);
        expect(record.state).toBeNull();
        expect(record.team).toBeNull();
        expect(record.labels).toEqual([]);
        expect(() => LinearActiveIssueSchema.parse(record)).not.toThrow();
    });
});
