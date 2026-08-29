import { describe, expect, it, vi } from "vitest";

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
  sortRepositories,
  snapshotsAreSemanticallyEqual,
  type AuditedRepository,
} from "../../scripts/github-sync-core";
import type {
  PortfolioRepository,
  PortfolioSnapshot,
} from "../../src/lib/portfolio-schema";

const user = { id: "USER_1", login: "dev-zetta" };
const other = { id: "USER_2", login: "someone-else" };

function repository(
  nameWithOwner: string,
  oids: string[],
  overrides: Partial<PortfolioRepository> = {},
): PortfolioRepository {
  const parts = nameWithOwner.split("/");
  const owner = parts[0]!;
  const name = parts[1]!;
  const commits = oids.map((oid, index) => ({
    oid,
    date: `2026-08-${String(20 - index).padStart(2, "0")}T12:00:00.000Z`,
    url: `https://github.com/${nameWithOwner}/commit/${oid}`,
    attribution: "primary" as const,
  }));
  return {
    nameWithOwner,
    name,
    owner,
    url: `https://github.com/${nameWithOwner}`,
    description: "Fixture repository",
    relationship: owner === "dev-zetta" ? "owned" : "external",
    upstream: null,
    primaryLanguage: "TypeScript",
    topics: ["fixture"],
    stars: 1,
    archived: false,
    updatedAt: "2026-08-20T12:00:00.000Z",
    defaultBranch: "main",
    contribution: {
      total: commits.length,
      primary: commits.length,
      coauthored: 0,
      latest: commits[0]!,
      commits,
    },
    ...overrides,
  };
}

function snapshot(
  repositories: PortfolioRepository[],
  generatedAt = "2026-08-29T12:00:00.000Z",
) {
  return {
    schemaVersion: 1,
    generatedAt,
    profile: {
      login: "dev-zetta",
      name: "Gabriel Max",
      bio: "Senior engineer with 16 years of experience",
      location: "Czechia",
      avatarUrl: "https://avatars.githubusercontent.com/u/3283719?v=4",
      profileUrl: "https://github.com/dev-zetta",
      hireable: true,
      experienceYears: 16,
    },
    repositories,
  } satisfies PortfolioSnapshot;
}

describe("commit attribution", () => {
  it("includes primary and co-authors, deduplicates OIDs, and ignores unrelated commits", () => {
    const primaryOid = "1".repeat(40);
    const coauthorOid = "2".repeat(40);
    const evidence = collectAttributedEvidence(
      [
        {
          oid: primaryOid,
          committedDate: "2026-08-20T12:00:00.000Z",
          authors: [{ user }, { user: other }],
        },
        {
          oid: coauthorOid,
          committedDate: "2026-08-21T12:00:00.000Z",
          authors: [{ user: other }, { user }],
        },
        {
          oid: coauthorOid,
          committedDate: "2026-08-21T12:00:00.000Z",
          authors: [{ user: null }, { user }],
        },
        {
          oid: "3".repeat(40),
          committedDate: "2026-08-22T12:00:00.000Z",
          authors: [{ user: other }],
        },
      ],
      user.id,
      user.login,
      "https://github.com/dev-zetta/example",
    );

    expect(evidence).toHaveLength(2);
    expect(evidence[0]).toMatchObject({
      oid: coauthorOid,
      attribution: "coauthor",
    });
    expect(evidence[1]).toMatchObject({
      oid: primaryOid,
      attribution: "primary",
    });
    expect(contributionFromEvidence(evidence)).toMatchObject({
      total: 2,
      primary: 1,
      coauthored: 1,
    });
  });
});

describe("repository eligibility", () => {
  it("excludes private repositories and forks from standalone auditing", () => {
    expect(
      isEligibleStandaloneRepository({ isPrivate: false, isFork: false }),
    ).toBe(true);
    expect(
      isEligibleStandaloneRepository({ isPrivate: true, isFork: false }),
    ).toBe(false);
    expect(
      isEligibleStandaloneRepository({ isPrivate: false, isFork: true }),
    ).toBe(false);
  });
});

describe("fork delta collection", () => {
  it("paginates every ahead commit", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => `id-${index}`);
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ aheadBy: 101, commitNodeIds: firstPage })
      .mockResolvedValueOnce({
        aheadBy: 101,
        commitNodeIds: ["id-100"],
      });

    await expect(collectForkDelta(fetchPage)).resolves.toHaveLength(101);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("fails when GitHub returns a truncated fork comparison", async () => {
    await expect(
      collectForkDelta(async () => ({
        aheadBy: 2,
        commitNodeIds: ["only-one"],
      })),
    ).rejects.toThrow("Incomplete fork comparison");
  });
});

describe("canonical repository selection", () => {
  it("prefers the contribution-graph repository for identical commit histories", () => {
    const oid = "a".repeat(40);
    const mirror = repository("mirror/example", [oid], { stars: 100 });
    const canonical = repository("canonical/example", [oid], { stars: 1 });
    const audits: AuditedRepository[] = [
      { repository: mirror, discoveredByContributionGraph: false },
      { repository: canonical, discoveredByContributionGraph: true },
    ];

    expect(
      collapseDuplicateHistories(audits).map(
        (entry) => entry.repository.nameWithOwner,
      ),
    ).toEqual(["canonical/example"]);
  });
});

describe("pagination and request failures", () => {
  it("collects every page", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [1, 2],
        pageInfo: { hasNextPage: true, endCursor: "next" },
      })
      .mockResolvedValueOnce({
        nodes: [3],
        pageInfo: { hasNextPage: false, endCursor: null },
      });
    await expect(paginate(fetchPage)).resolves.toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, null);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "next");
  });

  it("rejects a truncated page without a next cursor", async () => {
    await expect(
      paginate(async () => ({
        nodes: [1],
        pageInfo: { hasNextPage: true, endCursor: null },
      })),
    ).rejects.toThrow("usable next cursor");
  });

  it("retries transient responses and fails closed on permanent API errors", async () => {
    const transient = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(
      requestWithRetry<{ ok: boolean }>(transient, 2),
    ).resolves.toEqual({ ok: true });

    await expect(
      requestWithRetry(() =>
        Promise.resolve(new Response("forbidden", { status: 403 })),
      ),
    ).rejects.toBeInstanceOf(GitHubRequestError);
  });
});

describe("generated artifacts", () => {
  it("ignores generatedAt when detecting semantic changes", () => {
    const item = repository("dev-zetta/example", ["b".repeat(40)]);
    expect(
      snapshotsAreSemanticallyEqual(
        snapshot([item], "2026-08-20T12:00:00.000Z"),
        snapshot([item], "2026-08-29T12:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("updates only the generated README region", () => {
    const data = snapshot([repository("dev-zetta/example", ["c".repeat(40)])]);
    const inventory = renderReadmeInventory(data);
    const original =
      "Before\n<!-- portfolio:start -->\nold\n<!-- portfolio:end -->\nAfter\n";
    const updated = replaceReadmeInventory(original, inventory);
    expect(updated).toContain("Before\n<!-- portfolio:start -->");
    expect(updated).toContain("dev-zetta/example");
    expect(updated).toContain("<!-- portfolio:end -->\nAfter");
  });

  it("sorts repository output stably by latest evidence and name", () => {
    const older = repository("dev-zetta/older", ["d".repeat(40)]);
    const alpha = repository("dev-zetta/alpha", ["e".repeat(40)]);
    const beta = repository("dev-zetta/beta", ["f".repeat(40)]);
    older.contribution.latest.date = "2025-01-01T00:00:00.000Z";
    older.contribution.commits[0]!.date = "2025-01-01T00:00:00.000Z";

    expect(
      sortRepositories([beta, older, alpha]).map((item) => item.nameWithOwner),
    ).toEqual(["dev-zetta/alpha", "dev-zetta/beta", "dev-zetta/older"]);
  });
});
