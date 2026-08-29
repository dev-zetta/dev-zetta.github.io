# Contribution methodology

The portfolio is a public-work inventory, not a list of every repository visible to the authenticated account. A repository qualifies only when current public Git history contains at least one commit that GitHub resolves to the `dev-zetta` account as a primary author or co-author.

## Standalone repositories

The sync enumerates GitHub's contribution collections in one-year windows from the account creation date through the present. It unions those candidates with authenticated commit search so that current history is checked even when contribution summaries are stale.

For every public, non-fork candidate, the current default branch and `gh-pages` branch, when present, are paginated completely. Each commit's GraphQL `authors` connection is inspected. GitHub defines this connection as the Git author followed by authors resolved from `Co-authored-by` trailers.

Search results can contain mirrors. Repositories with identical non-empty sets of attributed commit OIDs are collapsed. The repository recorded by GitHub's contribution collection is preferred, followed by public relationship and repository activity signals. This currently removes a duplicate Klipper history while retaining its canonical upstream repository.

## Forks

GitHub's normal profile contribution rules exclude commits made only in forks, so every public fork owned by `dev-zetta` receives a separate audit.

Each fork branch is compared with the same-named upstream branch when it exists, otherwise with the upstream default branch. All ahead commits are paginated, their author lists are resolved, and matching OIDs are deduplicated across fork branches. If GitHub cannot compare rewritten or unrelated histories, the fork branch is scanned directly and still must contain an account-attributed commit.

An untouched, identical, or merely stale fork therefore does not qualify. A contributed fork records its upstream relationship and links evidence through the fork itself.

## Counts and limitations

- Counts describe currently reachable public commits, not historical contribution-graph totals.
- Primary and co-authored counts are reported separately.
- OIDs are deduplicated within a repository.
- Counts are never summed globally because one commit may be reachable in multiple repository networks.
- Private repositories and their metadata are removed before snapshot construction.
- API truncation, unresolved pagination, authentication mismatch, or partial failure aborts the update before generated files are replaced.

## Update integrity

The snapshot is schema-validated and deterministically sorted. Generated files are replaced atomically only after the complete audit succeeds. A successful audit with no semantic change leaves both files untouched, so it cannot create an empty update or version bump.
