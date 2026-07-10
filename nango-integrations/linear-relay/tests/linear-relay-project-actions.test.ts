import { describe, expect, it, vi } from 'vitest';

import addIssuesToProject from '../actions/add-issues-to-project.js';
import archiveProject from '../actions/archive-project.js';
import createProject from '../actions/create-project.js';
import updateProject from '../actions/update-project.js';

const projectNode = {
    id: 'project-1',
    name: 'Factory Cloud',
    description: 'Cloud project writeback',
    state: 'started',
    progress: 0.25,
    startDate: '2026-06-01',
    targetDate: '2026-09-30',
    color: '#00ff00',
    icon: 'rocket',
    url: 'https://linear.app/acme/project/factory-cloud',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-02T12:00:00.000Z',
    lead: {
        id: 'user-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com'
    },
    status: {
        id: 'status-started',
        name: 'Started',
        type: 'started',
        color: '#00ff00'
    },
    teams: {
        nodes: [
            {
                id: 'team-1',
                key: 'CLD',
                name: 'Cloud'
            }
        ]
    }
};

const expectedProject = {
    id: 'project-1',
    name: 'Factory Cloud',
    description: 'Cloud project writeback',
    state: 'started',
    progress: 0.25,
    startDate: '2026-06-01',
    targetDate: '2026-09-30',
    color: '#00ff00',
    icon: 'rocket',
    url: 'https://linear.app/acme/project/factory-cloud',
    createdAt: '2026-06-01T12:00:00.000Z',
    updatedAt: '2026-06-02T12:00:00.000Z',
    leadId: 'user-1',
    status: {
        id: 'status-started',
        name: 'Started',
        type: 'started',
        color: '#00ff00'
    },
    teamIds: ['team-1']
};

function projectStatusesResponse() {
    return {
        data: {
            data: {
                projectStatuses: {
                    nodes: [
                        { id: 'status-planned', type: 'planned' },
                        { id: 'status-started', type: 'started' }
                    ]
                }
            }
        }
    };
}

function createNango(overrides: Record<string, unknown> = {}) {
    class ActionError extends Error {
        type?: string;

        constructor({ message, type }: { message: string; type?: string }) {
            super(message);
            this.name = 'ActionError';
            this.type = type;
        }
    }

    return {
        ActionError,
        post: vi.fn(),
        zodValidateInput: vi.fn(async ({ zodSchema, input }) => ({ data: zodSchema.parse(input) })),
        ...overrides
    };
}

describe('linear-relay project actions', () => {
    it('creates a Linear project and maps state to statusId', async () => {
        const nango = createNango({
            post: vi
                .fn()
                .mockResolvedValueOnce(projectStatusesResponse())
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            projectCreate: {
                                success: true,
                                project: projectNode
                            }
                        }
                    }
                })
        });

        const result = await createProject.exec(nango as any, {
            name: 'Factory Cloud',
            description: 'Cloud project writeback',
            teamIds: ['team-1'],
            leadId: 'user-1',
            startDate: '2026-06-01',
            targetDate: '2026-09-30',
            color: '#00ff00',
            icon: 'rocket',
            state: 'started'
        });

        expect(result).toEqual(expectedProject);
        expect(nango.post).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                endpoint: '/graphql',
                data: expect.objectContaining({
                    query: expect.stringContaining('mutation CreateProject'),
                    variables: {
                        input: {
                            name: 'Factory Cloud',
                            description: 'Cloud project writeback',
                            teamIds: ['team-1'],
                            leadId: 'user-1',
                            startDate: '2026-06-01',
                            targetDate: '2026-09-30',
                            color: '#00ff00',
                            icon: 'rocket',
                            statusId: 'status-started'
                        }
                    }
                })
            })
        );
    });

    it('rejects create-project input without a required project name', async () => {
        const nango = createNango();

        await expect(createProject.exec(nango as any, { teamIds: ['team-1'] })).rejects.toThrow();
        expect(nango.post).not.toHaveBeenCalled();
    });

    it('throws a typed ActionError when Linear returns a projectCreate GraphQL error', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    errors: [{ message: 'project mutation denied' }]
                }
            })
        });

        await expect(createProject.exec(nango as any, { name: 'Factory Cloud', teamIds: ['team-1'] })).rejects.toMatchObject({
            type: 'linear_graphql_error',
            message: 'project mutation denied'
        });
    });

    it('updates a Linear project with changed fields only', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        projectUpdate: {
                            success: true,
                            project: projectNode
                        }
                    }
                }
            })
        });

        const result = await updateProject.exec(nango as any, {
            id: 'project-1',
            name: 'Factory Cloud',
            targetDate: '2026-09-30'
        });

        expect(result).toEqual(expectedProject);
        expect(nango.post).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    query: expect.stringContaining('mutation UpdateProject'),
                    variables: {
                        id: 'project-1',
                        input: {
                            name: 'Factory Cloud',
                            targetDate: '2026-09-30'
                        }
                    }
                })
            })
        );
    });

    it('rejects update-project input without any project fields', async () => {
        const nango = createNango();

        await expect(updateProject.exec(nango as any, { id: 'project-1' })).rejects.toThrow(
            'At least one project field must be provided.'
        );
        expect(nango.post).not.toHaveBeenCalled();
    });

    it('bulk-adds issues to a project in chunks and returns per-issue failures', async () => {
        const resolvers: Array<(value: unknown) => void> = [];
        const nango = createNango({
            post: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolvers.push(resolve);
                    })
            )
        });

        const pending = addIssuesToProject.exec(nango as any, {
            projectId: 'project-1',
            issueIds: ['issue-1', 'issue-2', 'issue-3', 'issue-4', 'issue-5', 'issue-6', 'issue-7']
        });

        await Promise.resolve();
        expect(nango.post).toHaveBeenCalledTimes(5);

        for (let index = 0; index < 5; index += 1) {
            resolvers[index]?.({
                data: {
                    data: {
                        issueUpdate: {
                            success: true
                        }
                    }
                }
            });
        }

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(nango.post).toHaveBeenCalledTimes(7);

        resolvers[5]?.({
            data: {
                errors: [{ message: 'issue not found' }]
            }
        });
        resolvers[6]?.({
            data: {
                data: {
                    issueUpdate: {
                        success: false
                    }
                }
            }
        });

        const result = await pending;

        expect(result).toEqual({
            results: [
                { issueId: 'issue-1', success: true },
                { issueId: 'issue-2', success: true },
                { issueId: 'issue-3', success: true },
                { issueId: 'issue-4', success: true },
                { issueId: 'issue-5', success: true },
                { issueId: 'issue-6', success: false, error: 'issue not found' },
                { issueId: 'issue-7', success: false, error: 'Linear issueUpdate returned success=false.' }
            ]
        });
        expect(nango.post).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                data: expect.objectContaining({
                    query: expect.stringContaining('mutation AddIssueToProject'),
                    variables: {
                        id: 'issue-1',
                        input: { projectId: 'project-1' }
                    }
                })
            })
        );
    });

    it('archives a Linear project through projectArchive', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        projectArchive: {
                            success: true
                        }
                    }
                }
            })
        });

        const result = await archiveProject.exec(nango as any, { id: 'project-1' });

        expect(result).toEqual({ id: 'project-1', success: true });
        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/graphql',
            data: {
                query: expect.stringContaining('mutation ArchiveProject'),
                variables: {
                    id: 'project-1',
                    trash: false
                }
            },
            retries: 3
        });
    });

    it('rejects archive-project input without a project id', async () => {
        const nango = createNango();

        await expect(archiveProject.exec(nango as any, {})).rejects.toThrow();
        expect(nango.post).not.toHaveBeenCalled();
    });

    it('throws a typed ActionError when Linear returns a projectArchive GraphQL error', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    errors: [{ message: 'archive denied' }]
                }
            })
        });

        await expect(archiveProject.exec(nango as any, { id: 'project-1' })).rejects.toMatchObject({
            type: 'linear_graphql_error',
            message: 'archive denied'
        });
    });

    it('throws a typed ActionError when Linear projectArchive returns success=false', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        projectArchive: {
                            success: false
                        }
                    }
                }
            })
        });

        await expect(archiveProject.exec(nango as any, { id: 'project-1' })).rejects.toMatchObject({
            type: 'linear_project_archive_failed',
            message: 'Linear projectArchive returned success=false.'
        });
    });
});
