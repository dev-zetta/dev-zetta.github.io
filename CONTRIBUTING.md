# Contributing and releasing

This repository separates source changes from published portfolio updates. A merge to `main` does not immediately change the live site.

## Local checks

Use Node.js 24 and the committed npm lockfile.

```bash
npm ci
npm run verify
```

The Playwright suite installs Chromium separately with `npx playwright install --with-deps chromium` on a new machine.

## Refreshing GitHub data

```bash
npm run sync:github
```

The command reads `GH_TOKEN` or `GITHUB_TOKEN`, then falls back to `gh auth token`. It writes the validated snapshot and the generated README table only when public semantic data changes. Never commit a token or substitute private repository information into the generated files.

The scheduled workflow performs the same sync every Monday and opens a review pull request when needed. It never auto-merges that pull request.

## Commit and release policy

Use Conventional Commits:

- `fix:` and `fix(data):` produce patch releases.
- `feat:` produces minor releases.
- `feat!:` or a `BREAKING CHANGE:` footer produces a major release.

Release Please collects merged changes in a release pull request. Merging that release pull request updates the package version and changelog, creates a `vX.Y.Z` tag and GitHub Release, and deploys that exact tag to GitHub Pages.

## Editorial boundaries

Featured summaries are curated in `src/data/featured.ts`. They must remain supported by public repository documentation and attributed commits. Private project names, customer details, credentials, and unverified claims are out of scope.
