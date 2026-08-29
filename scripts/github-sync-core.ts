import type {
  ContributionEvidence,
  PortfolioRepository,
  PortfolioSnapshot,
} from "../src/lib/portfolio-schema";

export interface CommitAuthor {
  user: { id: string; login: string } | null;
}

export interface AuditedCommit {
  oid: string;
  committedDate: string;
  authors: CommitAuthor[];
}

export interface AuditedRepository {
  repository: PortfolioRepository;
  discoveredByContributionGraph: boolean;
}

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubRequestError";
  }
}

export function isEligibleStandaloneRepository(repository: {
  isPrivate: boolean;
  isFork: boolean;
}): boolean {
  return !repository.isPrivate && !repository.isFork;
}

export async function collectForkDelta(
  fetchPage: (page: number) => Promise<{
    aheadBy: number;
    commitNodeIds: string[];
  }>,
): Promise<string[]> {
  const ids: string[] = [];
  let page = 1;
  let expectedAheadBy: number | null = null;

  do {
    const response = await fetchPage(page);
    if (expectedAheadBy === null) expectedAheadBy = response.aheadBy;
    if (response.aheadBy !== expectedAheadBy) {
      throw new Error("Fork comparison changed while it was being paginated");
    }
    ids.push(...response.commitNodeIds);
    if (ids.length >= expectedAheadBy || response.commitNodeIds.length < 100) {
      break;
    }
    page += 1;
  } while (true);

  if (ids.length !== expectedAheadBy) {
    throw new Error(
      `Incomplete fork comparison: ${ids.length}/${expectedAheadBy ?? 0}`,
    );
  }
  return [...new Set(ids)];
}

export async function requestWithRetry<T>(
  request: () => Promise<Response>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request();
      if (response.ok) {
        return (await response.json()) as T;
      }

      const body = await response.text();
      const message = `GitHub request failed (${response.status}): ${body.slice(0, 300)}`;
      if (
        ![429, 502, 503, 504].includes(response.status) ||
        attempt === attempts
      ) {
        throw new GitHubRequestError(message, response.status);
      }

      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const delay = Math.min(
        10_000,
        Math.max(retryAfter * 1_000, attempt * 750),
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error;
      if (error instanceof GitHubRequestError || attempt === attempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("GitHub request failed");
}

export async function paginate<T>(
  fetchPage: (cursor: string | null) => Promise<{
    nodes: T[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>,
): Promise<T[]> {
  const nodes: T[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchPage(cursor);
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) {
      return nodes;
    }
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) {
      throw new Error("GitHub pagination stopped without a usable next cursor");
    }
    cursor = page.pageInfo.endCursor;
  } while (true);
}

export function collectAttributedEvidence(
  commits: readonly AuditedCommit[],
  userId: string,
  userLogin: string,
  repositoryUrl: string,
): ContributionEvidence[] {
  const evidence = new Map<string, ContributionEvidence>();

  for (const commit of commits) {
    const authorIndex = commit.authors.findIndex(
      (author) =>
        author.user?.id === userId || author.user?.login === userLogin,
    );
    if (authorIndex < 0) continue;

    evidence.set(commit.oid, {
      oid: commit.oid,
      date: commit.committedDate,
      url: `${repositoryUrl}/commit/${commit.oid}`,
      attribution: authorIndex === 0 ? "primary" : "coauthor",
    });
  }

  return [...evidence.values()].sort(
    (left, right) =>
      right.date.localeCompare(left.date) || left.oid.localeCompare(right.oid),
  );
}

export function contributionFromEvidence(
  evidence: readonly ContributionEvidence[],
) {
  if (evidence.length === 0) return null;
  const commits = [...evidence].sort(
    (left, right) =>
      right.date.localeCompare(left.date) || left.oid.localeCompare(right.oid),
  );
  const primary = commits.filter(
    (commit) => commit.attribution === "primary",
  ).length;
  const coauthored = commits.length - primary;

  return {
    total: commits.length,
    primary,
    coauthored,
    latest: commits[0]!,
    commits,
  };
}

export function collapseDuplicateHistories(
  repositories: readonly AuditedRepository[],
): AuditedRepository[] {
  const groups = new Map<string, AuditedRepository[]>();

  for (const repository of repositories) {
    const signature = repository.repository.contribution.commits
      .map((commit) => commit.oid)
      .sort()
      .join(",");
    const existing = groups.get(signature) ?? [];
    existing.push(repository);
    groups.set(signature, existing);
  }

  return [...groups.values()].map(
    (group) =>
      [...group].sort((left, right) => {
        if (
          left.discoveredByContributionGraph !==
          right.discoveredByContributionGraph
        ) {
          return left.discoveredByContributionGraph ? -1 : 1;
        }
        if (left.repository.relationship !== right.repository.relationship) {
          return left.repository.relationship === "external" ? -1 : 1;
        }
        if (left.repository.stars !== right.repository.stars) {
          return right.repository.stars - left.repository.stars;
        }
        return left.repository.nameWithOwner.localeCompare(
          right.repository.nameWithOwner,
        );
      })[0]!,
  );
}

export function sortRepositories(
  repositories: readonly PortfolioRepository[],
): PortfolioRepository[] {
  return [...repositories].sort(
    (left, right) =>
      right.contribution.latest.date.localeCompare(
        left.contribution.latest.date,
      ) || left.nameWithOwner.localeCompare(right.nameWithOwner),
  );
}

export function snapshotWithoutGeneratedAt(
  snapshot: PortfolioSnapshot,
): Omit<PortfolioSnapshot, "generatedAt"> {
  const { generatedAt: _generatedAt, ...semantic } = snapshot;
  return semantic;
}

export function snapshotsAreSemanticallyEqual(
  left: PortfolioSnapshot,
  right: PortfolioSnapshot,
): boolean {
  return (
    JSON.stringify(snapshotWithoutGeneratedAt(left)) ===
    JSON.stringify(snapshotWithoutGeneratedAt(right))
  );
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function relationLabel(repository: PortfolioRepository): string {
  if (repository.relationship === "fork" && repository.upstream) {
    return `Fork of [${escapeMarkdown(repository.upstream.nameWithOwner)}](${repository.upstream.url})`;
  }
  return repository.relationship === "owned" ? "Owned" : "External";
}

export function renderReadmeInventory(snapshot: PortfolioSnapshot): string {
  const lines = [
    `_${snapshot.repositories.length} public repositories with current commit evidence · data updated ${snapshot.generatedAt.slice(0, 10)}_`,
    "",
    "| Project | Relationship | Primary tech | Verified contribution | Latest |",
    "| --- | --- | --- | ---: | --- |",
  ];

  for (const repository of snapshot.repositories) {
    const coauthored = repository.contribution.coauthored
      ? `, ${repository.contribution.coauthored} co-authored`
      : "";
    lines.push(
      `| [${escapeMarkdown(repository.nameWithOwner)}](${repository.url}) | ${relationLabel(repository)} | ${escapeMarkdown(repository.primaryLanguage ?? "—")} | [${repository.contribution.total} ${repository.contribution.total === 1 ? "commit" : "commits"}](${repository.contribution.latest.url}) (${repository.contribution.primary} primary${coauthored}) | ${repository.contribution.latest.date.slice(0, 10)} |`,
    );
  }

  lines.push(
    "",
    "> Counts are per repository and are intentionally not summed globally; the same Git commit can exist in more than one repository network.",
  );
  return lines.join("\n");
}

export function replaceReadmeInventory(
  readme: string,
  inventory: string,
): string {
  const start = "<!-- portfolio:start -->";
  const end = "<!-- portfolio:end -->";
  const startIndex = readme.indexOf(start);
  const endIndex = readme.indexOf(end);

  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error("README portfolio markers are missing or out of order");
  }

  return `${readme.slice(0, startIndex + start.length)}\n\n${inventory}\n\n${readme.slice(endIndex)}`;
}
