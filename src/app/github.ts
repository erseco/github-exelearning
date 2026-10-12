// GitHub REST API (api.github.com allows CORS): read a project folder at a commit and save
// changes back as one commit, or as a pull request when pushing is not possible.
import { type Files, IMPORT_DIRS, IMPORT_FILES, isSafePath } from '../elpx.ts';
import type { SavePlan } from '../sync.ts';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const NAME = /^[A-Za-z0-9_.-]+$/;

export interface Target {
    owner: string;
    repo: string;
    branch?: string;
    /** Project folder inside the repository ('' = root). */
    path: string;
}

/**
 * Accepts ?repo=owner/name (or ?gh= / ?url=) with optional &branch= and &path=, and full
 * GitHub URLs such as https://github.com/owner/name/tree/branch/folder.
 */
export function parseTarget(params: URLSearchParams): Target | undefined {
    const raw = (params.get('repo') ?? params.get('gh') ?? params.get('url') ?? '').trim();
    const match = raw.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.*?))?)?\/?$/);
    if (!match || !NAME.test(match[1]) || !NAME.test(match[2])) return undefined;
    const path = (params.get('path') ?? match[4] ?? '').replace(/^\/+|\/+$/g, '');
    if (path && !isSafePath(path)) return undefined;
    return { owner: match[1], repo: match[2], branch: params.get('branch') ?? match[3] ?? undefined, path };
}

export class GitHubError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export type Api = <T = any>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export function createApi(token?: string, fetchImpl: typeof fetch = fetch): Api {
    return async (path, init = {}) => {
        const response = await fetchImpl(path.startsWith('https://') ? path : API + path, {
            method: init.method ?? 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: init.body ? JSON.stringify(init.body) : undefined,
            cache: 'no-cache', // GitHub sends max-age=60: a cached branch head made saves retry on a stale commit
        });
        if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new GitHubError(response.status, detail.message ?? response.statusText);
        }
        return response.status === 204 ? undefined : response.json();
    };
}

export interface Project {
    target: Target;
    repoId: number;
    ownerId: number;
    private: boolean;
    /** Branch saves go to; becomes the pull request branch after saving as a pull request. */
    branch: string;
    /** Branch the project was opened from: pull request base and publishing branch. */
    baseBranch: string;
    protectedBranch: boolean;
    commitSha: string;
    treeSha: string;
    /** Import files (relative to the project folder) as they are in commitSha. */
    files: Files;
    /** Git modes of those files, kept when they are rewritten. */
    modes: Map<string, string>;
    /** Folders below the requested one that contain a content.xml (when the requested one does not). */
    candidates: string[];
}

const isImportPath = (path: string) =>
    IMPORT_FILES.includes(path) || IMPORT_DIRS.some((dir) => path.startsWith(`${dir}/`));

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function fromBase64(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64.replace(/\s/g, '')), (c) => c.charCodeAt(0));
}

export function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** Read the files the eXeLearning importer needs from target at the branch head. */
export async function loadProject(api: Api, target: Target, authenticated: boolean, fetchImpl: typeof fetch = fetch): Promise<Project> {
    const { owner, repo } = target;
    const info = await api(`/repos/${owner}/${repo}`);
    const branch = target.branch ?? info.default_branch;
    const head = await api(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
    const commitSha: string = head.commit.sha;
    const treeSha: string = head.commit.commit.tree.sha;
    const tree = await api(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
    if (tree.truncated) throw new GitHubError(413, 'The repository is too large to list.');

    const prefix = target.path ? `${target.path}/` : '';
    const entries = (tree.tree as { path: string; type: string; mode: string; sha: string }[])
        .filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path.startsWith(prefix))
        .map((e) => ({ ...e, rel: e.path.slice(prefix.length) }))
        .filter((e) => isSafePath(e.rel) && isImportPath(e.rel) && !e.rel.split('/').some((s) => s.startsWith('.')));

    const candidates = entries.some((e) => e.rel === 'content.xml')
        ? []
        : (tree.tree as { path: string }[])
              .filter((e) => e.path.endsWith('/content.xml') && e.path.startsWith(prefix))
              .map((e) => e.path.slice(0, -'/content.xml'.length));

    const files: Files = new Map();
    const modes = new Map<string, string>();
    await mapLimit(entries, 6, async (e) => {
        let bytes: Uint8Array;
        if (authenticated || info.private) {
            bytes = fromBase64((await api(`/repos/${owner}/${repo}/git/blobs/${e.sha}`)).content);
        } else {
            // Public repositories: raw files do not count against the anonymous API limit.
            const response = await fetchImpl(`${RAW}/${owner}/${repo}/${commitSha}/${encodePath(e.path)}`);
            if (!response.ok) throw new GitHubError(response.status, `Could not download ${e.path}`);
            bytes = new Uint8Array(await response.arrayBuffer());
        }
        files.set(e.rel, bytes);
        modes.set(e.rel, e.mode);
    });

    return {
        target,
        repoId: info.id,
        ownerId: info.owner.id,
        private: info.private,
        branch,
        baseBranch: branch,
        protectedBranch: !!head.protected,
        commitSha,
        treeSha,
        files,
        modes,
        candidates,
    };
}

export interface SaveResult {
    kind: 'commit' | 'pull-request';
    url: string;
    branch: string;
    commitSha: string;
    treeSha: string;
}

/**
 * Write plan.write (and plan.removed when deleteRemoved) in one commit on project.branch.
 * Falls back to a new branch + pull request when asked, when the branch is protected, or when
 * someone else changed the same files meanwhile.
 */
export async function saveProject(
    api: Api,
    project: Project,
    plan: SavePlan,
    exported: Files,
    options: { message: string; pullRequest: boolean; deleteRemoved: boolean },
): Promise<SaveResult> {
    const { owner, repo } = project.target;
    const repoPath = `/repos/${owner}/${repo}`;
    const full = (path: string) => (project.target.path ? `${project.target.path}/${path}` : path);

    const blobs = await mapLimit(plan.write, 4, async (path) => {
        const blob = await api(`${repoPath}/git/blobs`, {
            method: 'POST',
            body: { content: toBase64(exported.get(path) as Uint8Array), encoding: 'base64' },
        });
        return { path: full(path), mode: project.modes.get(path) ?? '100644', type: 'blob', sha: blob.sha as string | null };
    });
    const removals = options.deleteRemoved
        ? plan.removed.map((path) => ({ path: full(path), mode: '100644', type: 'blob', sha: null }))
        : [];

    const commitOn = async (parent: string, baseTree: string) => {
        const tree = await api(`${repoPath}/git/trees`, { method: 'POST', body: { base_tree: baseTree, tree: [...blobs, ...removals] } });
        const commit = await api(`${repoPath}/git/commits`, {
            method: 'POST',
            body: { message: options.message, tree: tree.sha, parents: [parent] },
        });
        return { commitSha: commit.sha as string, treeSha: tree.sha as string, url: commit.html_url as string };
    };

    const pullRequest = async (commit: { commitSha: string; treeSha: string }): Promise<SaveResult> => {
        const branch = `exelearning/edit-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
        await api(`${repoPath}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.commitSha } });
        const pr = await api(`${repoPath}/pulls`, {
            method: 'POST',
            body: { title: options.message, head: branch, base: project.baseBranch, body: 'Edited with eXeLearning (https://github.exelearning.dev).' },
        });
        return { ...commit, kind: 'pull-request', url: pr.html_url, branch };
    };

    let parent = project.commitSha;
    let baseTree = project.treeSha;
    for (let attempt = 0; attempt < 3; attempt++) {
        const commit = await commitOn(parent, baseTree);
        if (options.pullRequest || project.protectedBranch) return pullRequest(commit);
        try {
            await api(`${repoPath}/git/refs/heads/${encodePath(project.branch)}`, {
                method: 'PATCH',
                body: { sha: commit.commitSha, force: false },
            });
            return { kind: 'commit', branch: project.branch, ...commit };
        } catch (error) {
            if (!(error instanceof GitHubError) || error.status !== 422) throw error;
            if (!/fast.?forward/i.test(error.message)) return pullRequest(commit); // protected or rejected
            // The branch moved: rebase onto the new head unless the same files changed there.
            const head = await api(`${repoPath}/branches/${encodeURIComponent(project.branch)}`);
            const compare = await api(`${repoPath}/compare/${parent}...${head.commit.sha}`);
            const ours = new Set([...blobs, ...removals].map((entry) => entry.path));
            if ((compare.files ?? []).some((file: { filename: string }) => ours.has(file.filename))) return pullRequest(commit);
            parent = head.commit.sha;
            baseTree = head.commit.commit.tree.sha;
        }
    }
    throw new GitHubError(409, 'The branch keeps changing; try again.');
}

export interface RepoSummary {
    owner: string;
    repo: string;
    private: boolean;
    defaultBranch: string;
    pushedAt: string;
}

/** Repositories the signed-in user can reach through the GitHub App installations, newest first. */
export async function listAccessibleRepos(api: Api): Promise<RepoSummary[]> {
    const { installations } = await api<{ installations: { id: number }[] }>('/user/installations?per_page=100');
    const repos = new Map<string, RepoSummary>();
    for (const installation of installations) {
        for (let page = 1; page < 50; page++) {
            const { repositories } = await api<{ repositories: any[] }>(
                `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
            );
            for (const r of repositories) {
                repos.set(r.full_name, { owner: r.owner.login, repo: r.name, private: r.private, defaultBranch: r.default_branch, pushedAt: r.pushed_at ?? '' });
            }
            if (repositories.length < 100) break;
        }
    }
    return [...repos.values()].sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
}

export interface Resource {
    repo: RepoSummary;
    /** Folder ('' = root) of the default branch that contains content.xml. */
    path: string;
    contentSha: string;
    screenshotSha?: string;
}

/** eXeLearning resources (folders with a content.xml) on the repository's default branch. */
export async function findProjects(api: Api, repo: RepoSummary): Promise<Resource[]> {
    let tree: { tree: { path: string; type: string; sha: string }[] };
    try {
        tree = await api(`/repos/${repo.owner}/${repo.repo}/git/trees/${encodeURIComponent(repo.defaultBranch)}?recursive=1`);
    } catch (error) {
        if (error instanceof GitHubError && error.status === 409) return []; // empty repository
        throw error;
    }
    const blobs = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
    const resources: Resource[] = [];
    for (const [file, sha] of blobs) {
        if (file !== 'content.xml' && !file.endsWith('/content.xml')) continue;
        const path = file.slice(0, -'content.xml'.length).replace(/\/$/, '');
        if (path.split('/').some((segment) => segment.startsWith('.') || segment === 'node_modules')) continue;
        resources.push({ repo, path, contentSha: sha, screenshotSha: blobs.get(path ? `${path}/screenshot.png` : 'screenshot.png') });
    }
    return resources;
}

export async function blobBytes(api: Api, repo: RepoSummary, sha: string): Promise<Uint8Array> {
    return fromBase64((await api(`/repos/${repo.owner}/${repo.repo}/git/blobs/${sha}`)).content);
}

/** The resource title (pp_title) from content.xml, if any. */
export function readTitle(xml: string): string | undefined {
    const raw = xml.match(/<key>pp_title<\/key>\s*<value>([^<]*)<\/value>/)?.[1];
    if (!raw) return undefined;
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return raw.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, e: string) =>
        e[0] === '#' ? String.fromCodePoint(Number.parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10)) : (entities[e] ?? match),
    ).trim() || undefined;
}

/** The GitHub Pages workflow template with the project's branch and folder filled in. */
export function pagesWorkflow(template: string, branch: string, path: string): string {
    return template
        .replaceAll('__BRANCH__', branch)
        .replaceAll('__PROJECT_DIR__', path || '.')
        .replaceAll('__PREFIX__', path ? `${path}/` : '');
}
