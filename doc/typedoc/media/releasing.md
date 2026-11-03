# Releasing

This page is for maintainers releasing OAG-MCP itself. To run OAG-MCP, see
[Deployment](deployment.md).

OAG-MCP is an npm package. Its `prepare` script builds `dist/` from the
TypeScript sources, on `npm install` and before `npm pack` and
`npm publish`, so the published package contains the compiled CLI.

## Checking a release candidate

```bash
make ci                     # build, lint, tests, coverage, docs, then package
```

`make ci` ends by packing OAG-MCP (`make package`, to `stage/package/`),
installing the package globally (`make reinstall`), and running the
integration tests, including one that serves from the installed command. See
[Testing](testing.md).

## Making a release

Releases are cut with [RTK](https://github.com/cliffano/rtk). It updates the
files listed in `.rtk.json` (the version in `package.json`, `CHANGELOG.md`
and the *Publish* workflow) and creates the release tag:

```bash
make release-patch          # or release-minor, release-major
```

The same can be run from GitHub, with the *Release Patch*, *Release Minor*
and *Release Major* workflows. Pushing the tag starts the *Publish* workflow,
which runs `npm publish` to the npm registry.

Nothing is published without explicit authorisation: only a maintainer who
chooses to cut a release starts one.
