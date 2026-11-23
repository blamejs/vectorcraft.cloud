# vectorcraft.cloud

https://vectorcraft.cloud/ serves the web build of the latest VectorCraft release
(`vectorcraft-web-<version>.zip` from https://github.com/storytold/vectorcraft/releases).

- `src/index.js` is the Cloudflare Worker `vectorcraft-cloud`. It serves every build in the R2 bucket `web-app-site`
  under its own path, `/b/<id>/`, and redirects `/` (and any other path) to the current build's path. A page and the
  files it loads therefore always come from one build. It sends each `.wasm` file Brotli-compressed to browsers that
  accept `br`, and adds an `X-Build` header naming the build. The bucket layout is described at the top of the file.
- `.github/workflows/publish.yml` runs every hour at minute 7. When the latest release differs from the served
  build, or the served build has not passed its check, it downloads the release's web zip and uploads it with
  `scripts/publish.sh` as a new build with the id `<tag>.<UTC time>`. It then checks the site with
  `scripts/check.sh` and records the result with `scripts/mark-checked.sh`. When the check fails, the last build
  that passed its check is served again (`scripts/rollback.sh`), and scheduled runs do not publish that release
  again. `scripts/cleanup.sh` runs on every run; it keeps the last 3 builds and deletes older ones. Run the workflow
  by hand from the Actions tab; a tag given there is published even when it is already current or failed before,
  and the next scheduled run publishes the latest release again.
- `scripts/current.sh web-app-site` prints `STATE`: the served build (`current=`), the build served before it
  (`previous=`, kept by cleanup), the last build that passed its check (`checked=`) and the last build that failed
  it (`failed=`).
- The scripts read `STATE` and write it back whole. Do not run them by hand while the workflow is running.

## Setup

The repository needs two secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the account permission Workers R2 Storage: Edit.
- `CLOUDFLARE_ACCOUNT_ID`: the account ID.

The Worker is deployed by hand: `npm ci`, `npx wrangler login`, then `npx wrangler deploy`. The bucket was created
with `npx wrangler r2 bucket create web-app-site`.

## Checks

- `npm test` runs the Worker's tests.
- `scripts/check.sh https://vectorcraft.cloud/ <id>` checks the live site, where `<id>` is the `current=` value
  that `scripts/current.sh web-app-site` prints.
