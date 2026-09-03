# templates/

Reference copies — not used at build time, kept here so template content is
version-controlled alongside the app.

## client-project/

Mirror of the GitHub template repo **`lulrell37/client-project-template`**.
`createProjectRepo()` in `src/services/buildAgent.js` calls GitHub's
`/generate` API against that repo, so the authoritative copy is the repo itself —
edit there (or push these files to it) when changing the client scaffold.

`claude.yml` authenticates with the workflow's own `GITHUB_TOKEN`
(`github_token: ${{ github.token }}`) rather than the Claude GitHub App, so a
freshly generated client repo works without anyone installing
`github.com/apps/claude` on it. The app still sets the repo's
`ANTHROPIC_API_KEY` secret and PR permissions at creation time.
