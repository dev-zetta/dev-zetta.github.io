import { z } from "zod";

const isoDatetimeSchema = z.iso.datetime();
const githubUrlSchema = z
  .url()
  .refine((url) => url.startsWith("https://github.com/"));

export const contributionEvidenceSchema = z.object({
  oid: z.string().regex(/^[0-9a-f]{40}$/),
  date: isoDatetimeSchema,
  url: githubUrlSchema,
  attribution: z.enum(["primary", "coauthor"]),
});

export const repositoryContributionSchema = z.object({
  total: z.number().int().positive(),
  primary: z.number().int().nonnegative(),
  coauthored: z.number().int().nonnegative(),
  latest: contributionEvidenceSchema,
  commits: z.array(contributionEvidenceSchema).min(1),
});

export const repositorySchema = z.object({
  nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
  name: z.string().min(1),
  owner: z.string().min(1),
  url: githubUrlSchema,
  description: z.string().nullable(),
  relationship: z.enum(["owned", "fork", "external"]),
  upstream: z
    .object({
      nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
      url: githubUrlSchema,
    })
    .nullable(),
  primaryLanguage: z.string().nullable(),
  topics: z.array(z.string()),
  stars: z.number().int().nonnegative(),
  archived: z.boolean(),
  updatedAt: isoDatetimeSchema,
  defaultBranch: z.string().min(1),
  contribution: repositoryContributionSchema,
});

export const portfolioSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: isoDatetimeSchema,
    profile: z.object({
      login: z.literal("dev-zetta"),
      name: z.string().min(1),
      bio: z.string().min(1),
      location: z.string().min(1),
      avatarUrl: z
        .url()
        .refine((url) =>
          url.startsWith("https://avatars.githubusercontent.com/"),
        ),
      profileUrl: z.literal("https://github.com/dev-zetta"),
      hireable: z.boolean(),
      experienceYears: z.number().int().positive(),
    }),
    repositories: z.array(repositorySchema),
  })
  .superRefine((snapshot, context) => {
    const names = new Set<string>();

    for (const repository of snapshot.repositories) {
      if (names.has(repository.nameWithOwner)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate repository: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }
      names.add(repository.nameWithOwner);

      const uniqueOids = new Set(
        repository.contribution.commits.map((commit) => commit.oid),
      );
      if (uniqueOids.size !== repository.contribution.commits.length) {
        context.addIssue({
          code: "custom",
          message: `Duplicate commit evidence: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      if (
        repository.contribution.primary + repository.contribution.coauthored !==
        repository.contribution.total
      ) {
        context.addIssue({
          code: "custom",
          message: `Contribution totals do not reconcile: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      if (
        repository.contribution.total !== repository.contribution.commits.length
      ) {
        context.addIssue({
          code: "custom",
          message: `Contribution evidence count does not reconcile: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      const sortedCommits = [...repository.contribution.commits].sort(
        (left, right) =>
          right.date.localeCompare(left.date) ||
          left.oid.localeCompare(right.oid),
      );
      if (
        sortedCommits.some(
          (commit, index) =>
            commit.oid !== repository.contribution.commits[index]?.oid,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: `Contribution evidence is not deterministically sorted: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      if (
        JSON.stringify(repository.contribution.latest) !==
        JSON.stringify(repository.contribution.commits[0])
      ) {
        context.addIssue({
          code: "custom",
          message: `Latest contribution does not match evidence: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      for (const commit of repository.contribution.commits) {
        if (commit.url !== `${repository.url}/commit/${commit.oid}`) {
          context.addIssue({
            code: "custom",
            message: `Contribution URL does not match its repository and OID: ${repository.nameWithOwner}`,
            path: ["repositories"],
          });
        }
      }

      const expectedNameWithOwner = `${repository.owner}/${repository.name}`;
      if (repository.nameWithOwner !== expectedNameWithOwner) {
        context.addIssue({
          code: "custom",
          message: `Repository identity fields do not reconcile: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      const isAccountRepository = repository.owner === "dev-zetta";
      if (
        (repository.relationship === "external" && isAccountRepository) ||
        (repository.relationship !== "external" && !isAccountRepository)
      ) {
        context.addIssue({
          code: "custom",
          message: `Repository relationship does not match ownership: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }

      if (
        (repository.relationship === "fork") !==
        (repository.upstream !== null)
      ) {
        context.addIssue({
          code: "custom",
          message: `Upstream relationship is inconsistent: ${repository.nameWithOwner}`,
          path: ["repositories"],
        });
      }
    }

    const expectedOrder = [...snapshot.repositories].sort(
      (left, right) =>
        right.contribution.latest.date.localeCompare(
          left.contribution.latest.date,
        ) || left.nameWithOwner.localeCompare(right.nameWithOwner),
    );
    if (
      expectedOrder.some(
        (repository, index) =>
          repository.nameWithOwner !==
          snapshot.repositories[index]?.nameWithOwner,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Repositories are not deterministically sorted",
        path: ["repositories"],
      });
    }
  });

export type ContributionEvidence = z.infer<typeof contributionEvidenceSchema>;
export type RepositoryContribution = z.infer<
  typeof repositoryContributionSchema
>;
export type PortfolioRepository = z.infer<typeof repositorySchema>;
export type PortfolioSnapshot = z.infer<typeof portfolioSnapshotSchema>;
