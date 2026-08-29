import { execFileSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectAttributedEvidence,
  collectForkDelta,
  collapseDuplicateHistories,
  contributionFromEvidence,
  GitHubRequestError,
  isEligibleStandaloneRepository,
  paginate,
  renderReadmeInventory,
  replaceReadmeInventory,
  requestWithRetry,
  snapshotsAreSemanticallyEqual,
  sortRepositories,
  type AuditedCommit,
  type AuditedRepository,
  type CommitAuthor,
} from "./github-sync-core";
import {
  portfolioSnapshotSchema,
  type PortfolioRepository,
  type PortfolioSnapshot,
} from "../src/lib/portfolio-schema";

const accountLogin = "dev-zetta";
const apiVersion = "2022-11-28";
const graphqlUrl = "https://api.github.com/graphql";
const restUrl = "https://api.github.com";

interface RepositoryMetadata {
  nameWithOwner: string;
  name: string;
  owner: string;
  url: string;
  description: string | null;
  isFork: boolean;
  isPrivate: boolean;
  archived: boolean;
  updatedAt: string;
  stars: number;
  primaryLanguage: string | null;
  topics: string[];
  defaultBranch: string | null;
  upstream: {
    nameWithOwner: string;
    url: string;
    defaultBranch: string;
  } | null;
}

interface CommitNode {
  id: string;
  oid: string;
  committedDate: string;
  authors: {
    nodes: CommitAuthor[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface CompareCommit {
  node_id: string;
  sha: string;
}

class GitHubClient {
  constructor(private readonly token: string) {}

  private headers() {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "dev-zetta-portfolio-sync",
      "X-GitHub-Api-Version": apiVersion,
    };
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await requestWithRetry<{
      data?: T;
      errors?: Array<{ message: string }>;
    }>(() =>
      fetch(graphqlUrl, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      }),
    );

    if (response.errors?.length) {
      throw new Error(
        `GitHub GraphQL error: ${response.errors.map((error) => error.message).join("; ")}`,
      );
    }
    if (!response.data)
      throw new Error("GitHub GraphQL response did not contain data");
    return response.data;
  }

  async rest<T>(
    path: string,
    parameters: Record<string, string | number> = {},
  ): Promise<T> {
    const url = new URL(path, restUrl);
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, String(value));
    return requestWithRetry<T>(() => fetch(url, { headers: this.headers() }));
  }
}

function getToken(): string {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (token?.trim()) return token.trim();

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "Set GH_TOKEN/GITHUB_TOKEN or authenticate the gh CLI before syncing",
    );
  }
}

function repositoryFields() {
  return `
    nameWithOwner
    name
    url
    description
    isFork
    isPrivate
    isArchived
    updatedAt
    stargazerCount
    owner { login }
    primaryLanguage { name }
    repositoryTopics(first: 100) {
      nodes { topic { name } }
      pageInfo { hasNextPage }
    }
    defaultBranchRef { name }
    parent {
      nameWithOwner
      url
      defaultBranchRef { name }
    }
  `;
}

function toMetadata(node: any): RepositoryMetadata {
  if (node.repositoryTopics.pageInfo.hasNextPage) {
    throw new Error(`Topic list is truncated for ${node.nameWithOwner}`);
  }
  return {
    nameWithOwner: node.nameWithOwner,
    name: node.name,
    owner: node.owner.login,
    url: node.url,
    description: node.description,
    isFork: node.isFork,
    isPrivate: node.isPrivate,
    archived: node.isArchived,
    updatedAt: node.updatedAt,
    stars: node.stargazerCount,
    primaryLanguage: node.primaryLanguage?.name ?? null,
    topics: node.repositoryTopics.nodes
      .map((entry: any) => entry.topic.name)
      .sort(),
    defaultBranch: node.defaultBranchRef?.name ?? null,
    upstream: node.parent
      ? {
          nameWithOwner: node.parent.nameWithOwner,
          url: node.parent.url,
          defaultBranch: node.parent.defaultBranchRef?.name,
        }
      : null,
  };
}

async function fetchOwnedRepositories(
  client: GitHubClient,
): Promise<RepositoryMetadata[]> {
  return paginate(async (cursor) => {
    const data = await client.graphql<any>(
      `query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER]) {
            nodes { ${repositoryFields()} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { login: accountLogin, cursor },
    );
    const page = data.user.repositories;
    return {
      nodes: page.nodes.map(toMetadata),
      pageInfo: page.pageInfo,
    };
  });
}

async function fetchRepository(
  client: GitHubClient,
  nameWithOwner: string,
): Promise<RepositoryMetadata> {
  const [owner, name] = nameWithOwner.split("/");
  const data = await client.graphql<any>(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) { ${repositoryFields()} }
    }`,
    { owner, name },
  );
  if (!data.repository)
    throw new Error(`Repository disappeared during sync: ${nameWithOwner}`);
  return toMetadata(data.repository);
}

async function fetchProfile(client: GitHubClient) {
  const profile = await client.rest<any>("/user");
  if (profile.login !== accountLogin) {
    throw new Error(
      `Authenticated GitHub account is ${profile.login}, expected ${accountLogin}`,
    );
  }
  const experienceMatch = String(profile.bio ?? "").match(/(\d+)\s+years?/i);
  if (!experienceMatch)
    throw new Error(
      "Could not derive experience years from the public GitHub bio",
    );
  return {
    nodeId: profile.node_id as string,
    createdAt: profile.created_at as string,
    public: {
      login: "dev-zetta" as const,
      name: profile.name as string,
      bio: String(profile.bio).replace(/\s+/g, " ").trim(),
      location: profile.location as string,
      avatarUrl: profile.avatar_url as string,
      profileUrl: `https://github.com/${accountLogin}` as const,
      hireable: Boolean(profile.hireable),
      experienceYears: Number(experienceMatch[1]),
    },
  };
}

async function contributionGraphCandidates(
  client: GitHubClient,
  createdAt: string,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  const startYear = new Date(createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();

  for (let year = startYear; year <= currentYear; year += 1) {
    const from = `${year}-01-01T00:00:00Z`;
    const naturalEnd = `${year}-12-31T23:59:59Z`;
    const to = year === currentYear ? new Date().toISOString() : naturalEnd;
    const data = await client.graphql<any>(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            totalRepositoriesWithContributedCommits
            commitContributionsByRepository(maxRepositories: 100) {
              repository { nameWithOwner isPrivate isFork }
            }
          }
        }
      }`,
      { login: accountLogin, from, to },
    );
    const collection = data.user.contributionsCollection;
    const repositories = collection.commitContributionsByRepository;
    if (
      collection.totalRepositoriesWithContributedCommits > repositories.length
    ) {
      throw new Error(`Contribution repository list is truncated for ${year}`);
    }
    for (const item of repositories) {
      if (isEligibleStandaloneRepository(item.repository)) {
        candidates.add(item.repository.nameWithOwner);
      }
    }
  }
  return candidates;
}

async function commitSearchCandidates(
  client: GitHubClient,
): Promise<Set<string>> {
  const candidates = new Set<string>();
  let page = 1;
  let total = 0;
  do {
    const response = await client.rest<any>("/search/commits", {
      q: `author:${accountLogin}`,
      per_page: 100,
      page,
    });
    total = response.total_count;
    if (total > 1_000)
      throw new Error("GitHub commit search exceeded its 1,000-result cap");
    for (const item of response.items)
      candidates.add(item.repository.full_name);
    if (response.items.length < 100 || page * 100 >= total) break;
    page += 1;
  } while (true);
  return candidates;
}

async function fetchAdditionalAuthors(
  client: GitHubClient,
  commitId: string,
  cursor: string,
): Promise<CommitAuthor[]> {
  return paginate(async (after) => {
    const data = await client.graphql<any>(
      `query($id: ID!, $cursor: String) {
        node(id: $id) {
          ... on Commit {
            authors(first: 100, after: $cursor) {
              nodes { user { id login } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { id: commitId, cursor: after ?? cursor },
    );
    return data.node.authors;
  });
}

async function scanBranch(
  client: GitHubClient,
  repository: RepositoryMetadata,
  branch: string,
): Promise<AuditedCommit[]> {
  const [owner, name] = repository.nameWithOwner.split("/");
  const commits = await paginate<CommitNode>(async (cursor) => {
    const data = await client.graphql<any>(
      `query($owner: String!, $name: String!, $ref: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          ref(qualifiedName: $ref) {
            target {
              ... on Commit {
                history(first: 100, after: $cursor) {
                  nodes {
                    id oid committedDate
                    authors(first: 100) {
                      nodes { user { id login } }
                      pageInfo { hasNextPage endCursor }
                    }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }
      }`,
      { owner, name, ref: `refs/heads/${branch}`, cursor },
    );
    const history = data.repository?.ref?.target?.history;
    if (!history)
      return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    return history;
  });

  for (const commit of commits) {
    if (commit.authors.pageInfo.hasNextPage) {
      const cursor = commit.authors.pageInfo.endCursor;
      if (!cursor)
        throw new Error(`Author pagination cursor missing for ${commit.oid}`);
      commit.authors.nodes.push(
        ...(await fetchAdditionalAuthors(client, commit.id, cursor)),
      );
    }
  }
  return commits.map((commit) => ({
    oid: commit.oid,
    committedDate: commit.committedDate,
    authors: commit.authors.nodes,
  }));
}

async function listBranches(
  client: GitHubClient,
  nameWithOwner: string,
): Promise<string[]> {
  const [owner, name] = nameWithOwner.split("/");
  const refs = await paginate<{ name: string }>(async (cursor) => {
    const data = await client.graphql<any>(
      `query($owner: String!, $name: String!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          refs(refPrefix: "refs/heads/", first: 100, after: $cursor) {
            nodes { name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { owner, name, cursor },
    );
    if (!data.repository)
      throw new Error(`Repository not found: ${nameWithOwner}`);
    return data.repository.refs;
  });
  return refs.map((ref) => ref.name).sort();
}

async function fetchCommitsByNodeId(
  client: GitHubClient,
  ids: string[],
): Promise<AuditedCommit[]> {
  const commits: AuditedCommit[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    const batch = ids.slice(index, index + 50);
    const data = await client.graphql<any>(
      `query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Commit {
            id oid committedDate
            authors(first: 100) {
              nodes { user { id login } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`,
      { ids: batch },
    );
    for (const commit of data.nodes as CommitNode[]) {
      if (!commit)
        throw new Error("A compared commit disappeared during the fork audit");
      if (commit.authors.pageInfo.hasNextPage) {
        const cursor = commit.authors.pageInfo.endCursor;
        if (!cursor)
          throw new Error(`Author pagination cursor missing for ${commit.oid}`);
        commit.authors.nodes.push(
          ...(await fetchAdditionalAuthors(client, commit.id, cursor)),
        );
      }
      commits.push({
        oid: commit.oid,
        committedDate: commit.committedDate,
        authors: commit.authors.nodes,
      });
    }
  }
  return commits;
}

async function compareForkBranch(
  client: GitHubClient,
  fork: RepositoryMetadata,
  upstreamBranch: string,
  forkBranch: string,
): Promise<AuditedCommit[]> {
  if (!fork.upstream)
    throw new Error(`Fork is missing upstream metadata: ${fork.nameWithOwner}`);
  const comparison = encodeURIComponent(
    `${upstreamBranch}...${fork.owner}:${forkBranch}`,
  );
  const path = `/repos/${fork.upstream.nameWithOwner}/compare/${comparison}`;
  let ids: string[];
  try {
    ids = await collectForkDelta(async (page) => {
      const response = await client.rest<any>(path, { per_page: 100, page });
      return {
        aheadBy: response.ahead_by,
        commitNodeIds: response.commits.map(
          (commit: CompareCommit) => commit.node_id,
        ),
      };
    });
  } catch (error) {
    if (error instanceof GitHubRequestError) throw error;
    throw new Error(
      `Fork comparison failed for ${fork.nameWithOwner}:${forkBranch}`,
      { cause: error },
    );
  }
  return fetchCommitsByNodeId(client, ids);
}

function toPortfolioRepository(
  metadata: RepositoryMetadata,
  evidence: ReturnType<typeof collectAttributedEvidence>,
  relationship: "owned" | "fork" | "external",
): PortfolioRepository | null {
  const contribution = contributionFromEvidence(evidence);
  if (!contribution || !metadata.defaultBranch) return null;
  return {
    nameWithOwner: metadata.nameWithOwner,
    name: metadata.name,
    owner: metadata.owner,
    url: metadata.url,
    description: metadata.description,
    relationship,
    upstream: metadata.upstream
      ? {
          nameWithOwner: metadata.upstream.nameWithOwner,
          url: metadata.upstream.url,
        }
      : null,
    primaryLanguage: metadata.primaryLanguage,
    topics: metadata.topics,
    stars: metadata.stars,
    archived: metadata.archived,
    updatedAt: metadata.updatedAt,
    defaultBranch: metadata.defaultBranch,
    contribution,
  };
}

async function auditStandaloneRepository(
  client: GitHubClient,
  metadata: RepositoryMetadata,
  userId: string,
): Promise<PortfolioRepository | null> {
  if (!metadata.defaultBranch) return null;
  const branches = new Set([metadata.defaultBranch]);
  const availableBranches = await listBranches(client, metadata.nameWithOwner);
  if (availableBranches.includes("gh-pages")) branches.add("gh-pages");
  const commits = (
    await Promise.all(
      [...branches].map((branch) => scanBranch(client, metadata, branch)),
    )
  ).flat();
  const evidence = collectAttributedEvidence(
    commits,
    userId,
    accountLogin,
    metadata.url,
  );
  return toPortfolioRepository(
    metadata,
    evidence,
    metadata.owner === accountLogin ? "owned" : "external",
  );
}

async function auditFork(
  client: GitHubClient,
  fork: RepositoryMetadata,
  userId: string,
  branchCache: Map<string, string[]>,
): Promise<PortfolioRepository | null> {
  if (!fork.upstream) return null;
  const forkBranches = await listBranches(client, fork.nameWithOwner);
  let upstreamBranches = branchCache.get(fork.upstream.nameWithOwner);
  if (!upstreamBranches) {
    upstreamBranches = await listBranches(client, fork.upstream.nameWithOwner);
    branchCache.set(fork.upstream.nameWithOwner, upstreamBranches);
  }

  const commits: AuditedCommit[] = [];
  for (const forkBranch of forkBranches) {
    const baseline = upstreamBranches.includes(forkBranch)
      ? forkBranch
      : fork.upstream.defaultBranch;
    try {
      commits.push(
        ...(await compareForkBranch(client, fork, baseline, forkBranch)),
      );
    } catch (error) {
      if (
        !(error instanceof GitHubRequestError) ||
        ![404, 409, 422].includes(error.status)
      ) {
        throw error;
      }
      // Rewritten or unrelated histories cannot be compared. Scan the branch directly,
      // then retain only commits actually attributed to the account.
      commits.push(...(await scanBranch(client, fork, forkBranch)));
    }
  }
  const evidence = collectAttributedEvidence(
    commits,
    userId,
    accountLogin,
    fork.url,
  );
  return toPortfolioRepository(fork, evidence, "fork");
}

async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o644 });
  await rename(temporary, path);
}

export async function runSync() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const snapshotPath = resolve(root, "src/data/portfolio.generated.json");
  const readmePath = resolve(root, "README.md");
  const client = new GitHubClient(getToken());
  const profile = await fetchProfile(client);
  const ownedRepositories = await fetchOwnedRepositories(client);
  const ownedMap = new Map(
    ownedRepositories.map((repository) => [
      repository.nameWithOwner,
      repository,
    ]),
  );

  const graphCandidates = await contributionGraphCandidates(
    client,
    profile.createdAt,
  );
  const searchCandidates = await commitSearchCandidates(client);
  const standaloneNames = new Set([...graphCandidates, ...searchCandidates]);
  const standaloneAudits: AuditedRepository[] = [];

  for (const nameWithOwner of [...standaloneNames].sort()) {
    const metadata =
      ownedMap.get(nameWithOwner) ??
      (await fetchRepository(client, nameWithOwner));
    if (!isEligibleStandaloneRepository(metadata)) continue;
    const repository = await auditStandaloneRepository(
      client,
      metadata,
      profile.nodeId,
    );
    if (repository) {
      standaloneAudits.push({
        repository,
        discoveredByContributionGraph: graphCandidates.has(nameWithOwner),
      });
    }
  }

  const canonicalStandalone = collapseDuplicateHistories(standaloneAudits).map(
    (audit) => audit.repository,
  );
  const branchCache = new Map<string, string[]>();
  const forkRepositories: PortfolioRepository[] = [];
  for (const fork of ownedRepositories.filter(
    (repository) => repository.isFork && !repository.isPrivate,
  )) {
    const repository = await auditFork(
      client,
      fork,
      profile.nodeId,
      branchCache,
    );
    if (repository) forkRepositories.push(repository);
  }

  const candidateSnapshot: PortfolioSnapshot = portfolioSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    profile: profile.public,
    repositories: sortRepositories([
      ...canonicalStandalone,
      ...forkRepositories,
    ]),
  });

  let previous: PortfolioSnapshot | null = null;
  try {
    previous = portfolioSnapshotSchema.parse(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // An invalid or bootstrap snapshot is replaced only after the new snapshot is validated.
      previous = null;
    }
  }

  if (previous && snapshotsAreSemanticallyEqual(previous, candidateSnapshot)) {
    console.log(
      `No portfolio data changes (${candidateSnapshot.repositories.length} repositories verified).`,
    );
    return { changed: false, snapshot: previous };
  }

  const snapshotJson = `${JSON.stringify(candidateSnapshot, null, 2)}\n`;
  const readme = await readFile(readmePath, "utf8");
  const nextReadme = replaceReadmeInventory(
    readme,
    renderReadmeInventory(candidateSnapshot),
  );
  await atomicWrite(snapshotPath, snapshotJson);
  await atomicWrite(readmePath, nextReadme);
  console.log(
    `Updated portfolio data (${candidateSnapshot.repositories.length} repositories verified).`,
  );
  return { changed: true, snapshot: candidateSnapshot };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runSync().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Portfolio sync failed: ${message}`);
    process.exitCode = 1;
  });
}
