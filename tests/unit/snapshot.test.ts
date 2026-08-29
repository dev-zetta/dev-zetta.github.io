import { describe, expect, it } from "vitest";

import { featuredProjects } from "../../src/data/featured";
import snapshotJson from "../../src/data/portfolio.generated.json";
import { portfolioSnapshotSchema } from "../../src/lib/portfolio-schema";

const snapshot = portfolioSnapshotSchema.parse(snapshotJson);

describe("generated portfolio snapshot", () => {
  it("contains only unique, evidenced public repositories", () => {
    expect(snapshot.repositories.length).toBeGreaterThan(0);
    expect(
      new Set(
        snapshot.repositories.map((repository) => repository.nameWithOwner),
      ).size,
    ).toBe(snapshot.repositories.length);
    for (const repository of snapshot.repositories) {
      expect(repository.contribution.total).toBeGreaterThan(0);
      expect(repository.contribution.commits).toHaveLength(
        repository.contribution.total,
      );
    }
  });

  it("resolves every curated featured project", () => {
    const names = new Set(
      snapshot.repositories.map((repository) => repository.nameWithOwner),
    );
    expect(featuredProjects).toHaveLength(6);
    for (const featured of featuredProjects)
      expect(names.has(featured.nameWithOwner)).toBe(true);
  });

  it("contains the expected contributed-fork baseline", () => {
    const forks = snapshot.repositories.filter(
      (repository) => repository.relationship === "fork",
    );
    expect(forks.map((repository) => repository.nameWithOwner).sort()).toEqual(
      [
        "dev-zetta/aoostar-rs",
        "dev-zetta/developer-journey-app",
        "dev-zetta/mkv-muxing-batch-gui",
        "dev-zetta/sacd_extract2",
      ].sort(),
    );
  });
});
