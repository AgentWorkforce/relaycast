import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createGitHubApiFallback,
  createGitHubIntegration,
  createGitHubLibrarianApiFallback,
} from '../src/specialist/github-api-client.js';
import type { CloneRequester } from '../src/specialist/clone-requester.js';

describe('createGitHubIntegration', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('getPullDiff requests the diff media type with auth headers', async () => {
    fetchSpy.mockResolvedValue(
      new Response('--- diff body ---', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example/',
      cloudApiToken: 'test-token',
      workspaceId: 'ws_test',
    });

    const result = await integration.getPullDiff!('octo', 'hello', 42);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.example/api/v1/github/query');
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('accept')).toBe('application/vnd.github.v3.diff');
    expect(headers.get('authorization')).toBe('Bearer test-token');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: 'ws_test',
      operation: 'getPullDiff',
      params: { owner: 'octo', repo: 'hello', number: 42 },
    });
    expect((result as { data: string }).data).toContain('diff body');
  });

  it('listPulls sets per_page + state and filters via encoded URL', async () => {
    fetchSpy.mockResolvedValue(
      new Response('[{"number":1,"title":"A"}]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });

    await integration.listPulls!('o', 'r', { state: 'open', limit: 25 });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.example/api/v1/github/query');
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: 'ws_test',
      operation: 'listPulls',
      params: { owner: 'o', repo: 'r', state: 'open', per_page: 25 },
    });
  });

  it('throws with body text on non-ok and consumes response body', async () => {
    const bodyTextSpy = vi.fn().mockResolvedValue('rate limit exceeded');
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: bodyTextSpy,
    } as unknown as Response);

    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });
    await expect(integration.getPull!('o', 'r', 1)).rejects.toThrow(/status=403/);
    expect(bodyTextSpy).toHaveBeenCalled();
  });

  it('listIssues filters out pull_request entries (GitHub returns PRs from /issues)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify([
          { number: 1, title: 'real issue' },
          { number: 2, title: 'actually a PR', pull_request: { url: 'x' } },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });
    const result = (await integration.listIssues!('o', 'r')) as { data: Array<{ number: number }> };
    expect(result.data.map((entry) => entry.number)).toEqual([1]);
  });

  it('listAccessibleOrgs requests authenticated user orgs through the cloud proxy', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify([{ login: 'AgentWorkforce' }, { login: 'OtherOrg' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });

    await expect(integration.listAccessibleOrgs()).resolves.toEqual([
      'AgentWorkforce',
      'OtherOrg',
    ]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: 'ws_test',
      operation: 'listOrgs',
      params: { per_page: 100 },
    });
  });

  it('getRepoExists maps cloud-proxied 404 responses to false', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 404 }));
    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });

    await expect(integration.getRepoExists('AgentWorkforce', 'missing')).resolves.toBe(false);
  });

  it('searchRepos requests repository search and filters results to accessible orgs', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            { full_name: 'AgentWorkforce/cloud' },
            { full_name: 'OtherOrg/cloud' },
            { full_name: 'AgentWorkforce/cloud-web' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const integration = createGitHubIntegration({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });

    await expect(integration.searchRepos('cloud', { orgs: ['AgentWorkforce'] })).resolves.toEqual([
      'AgentWorkforce/cloud',
      'AgentWorkforce/cloud-web',
    ]);

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      workspaceId: 'ws_test',
      operation: 'searchRepos',
      params: { query: 'cloud', per_page: 10 },
    });
  });
});

describe('createGitHubApiFallback (investigator-facing)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response('diff body', { status: 200, headers: { 'content-type': 'text/plain' } }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ number: 7, title: 'PR 7' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('fires a background clone request and returns the PR diff from the API', async () => {
    const requestIfNeeded = vi.fn();
    const requester: CloneRequester = { requestIfNeeded, cooldownSize: 0 };

    const fallback = createGitHubApiFallback({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      cloneRequester: requester,
      workspaceId: 'ws_test',
    });

    const result = await fallback.readPRDiff('octo', 'hello', 7);

    expect(requestIfNeeded).toHaveBeenCalledWith('ws_test', 'octo', 'hello');
    // Underlying investigator fallback returns { data: GitHubApiPullRequest }
    // when it successfully reads either a diff or the PR metadata.
    expect(result).toBeTruthy();
  });

  it('does not call requestIfNeeded when the clone requester is omitted', async () => {
    const fallback = createGitHubApiFallback({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      workspaceId: 'ws_test',
    });
    const result = await fallback.readPRDiff('octo', 'hello', 7);
    expect(result).toBeTruthy();
  });
});

describe('createGitHubLibrarianApiFallback (librarian-facing)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('extracts repo slugs from filters and triggers clone for each', async () => {
    const requestIfNeeded = vi.fn();
    const requester: CloneRequester = { requestIfNeeded, cooldownSize: 0 };
    const fallback = createGitHubLibrarianApiFallback({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      cloneRequester: requester,
      workspaceId: 'ws_test',
    });

    await fallback({
      instruction: 'investigate',
      text: '',
      filters: { repo: ['octo/hello', 'widgets/gears'] },
      types: ['pr'],
    });

    expect(requestIfNeeded).toHaveBeenCalledWith('ws_test', 'octo', 'hello');
    expect(requestIfNeeded).toHaveBeenCalledWith('ws_test', 'widgets', 'gears');
  });

  it('does not clone-warm unresolved bare repo filters before the fallback resolves them', async () => {
    const requestIfNeeded = vi.fn();
    const requester: CloneRequester = { requestIfNeeded, cooldownSize: 0 };
    const fallback = createGitHubLibrarianApiFallback({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      cloneRequester: requester,
      workspaceId: 'ws_test',
    });

    await fallback({
      instruction: 'investigate cloud',
      text: '',
      filters: { repo: ['cloud'] },
      types: ['pr'],
    });

    expect(requestIfNeeded).not.toHaveBeenCalled();
  });

  it('extracts repo: qualifier from text even when no filter is set', async () => {
    const requestIfNeeded = vi.fn();
    const requester: CloneRequester = { requestIfNeeded, cooldownSize: 0 };
    const fallback = createGitHubLibrarianApiFallback({
      cloudApiUrl: 'https://cloud.example',
      cloudApiToken: 'tok',
      cloneRequester: requester,
      workspaceId: 'ws_test',
    });

    await fallback({
      instruction: 'find PRs in repo:mono/alpha please',
      text: 'repo:mono/alpha',
      filters: {},
      types: ['pr'],
    });

    expect(requestIfNeeded).toHaveBeenCalledWith('ws_test', 'mono', 'alpha');
  });
});
