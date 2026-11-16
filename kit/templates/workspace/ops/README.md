# ops

Checkouts that deploy, migrate or release, one per purpose: `ops/<app>-production/` at `origin/<production branch>`, `ops/<app>-staging/` at `origin/staging`, a release clone, a CLI build. They are the only place a deploy or a shared-database migration runs.

Detach at the commit you mean to ship (`git -C ops/<x> checkout --detach origin/<branch>`), run the deploy, and leave it clean. One session at a time: claim it first. Nobody commits here: the guard hook refuses it.
