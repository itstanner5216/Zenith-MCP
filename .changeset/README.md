# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It is how version bumps and changelogs are tracked for this monorepo.

## How to record a change

After making a code change that should trigger a release, run:

```bash
pnpm changeset
```

The CLI will ask, in plain English:

1. **Which packages changed** (`zenith-mcp`, `zenith-toon`).
2. **The bump type** for each:
   - `patch` – bug fixes / internal changes (e.g. 1.0.0 -> 1.0.1)
   - `minor` – new backwards-compatible features (e.g. 1.0.0 -> 1.1.0)
   - `major` – breaking changes (e.g. 1.0.0 -> 2.0.0)
3. **A short summary** of the change (this becomes the changelog entry).

This writes a small markdown file into `.changeset/`. Commit it alongside your
code change.

## Applying the versions

When you are ready to release, run:

```bash
pnpm version-packages
```

This consumes every pending changeset, bumps the package versions, updates each
package's `CHANGELOG.md`, and deletes the consumed changeset files. Commit the
result, then trigger the **Publish to npm** workflow (or publish a GitHub
Release).
