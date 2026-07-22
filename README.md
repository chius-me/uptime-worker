# uptime-worker

Cloudflare Worker uptime monitoring with a D1-backed status store, a Durable Object scheduler, and durable notification delivery.

## D1 schema management

Deployments and local development apply the ordered SQL files in `migrations/`. Do not run `deploy/init.sql` during normal deployment.

### New install

1. Create the database with `npm run d1:create`.
2. Put the returned database ID in `wrangler.toml`.
3. Initialize the remote database with `wrangler d1 migrations apply uptime_worker_d1 --remote` (or `npm run d1:migrate`).
4. For local development, run `npm run d1:init` to apply the same migrations locally.

### Compatibility install

For an existing installation that was initialized from `deploy/init.sql`, keep the existing database and its ID. Run `wrangler d1 migrations apply uptime_worker_d1 --remote` once before the next deployment. The migrations use idempotent `CREATE ... IF NOT EXISTS` statements, so this records the migration history without replacing existing tables or data.

`deploy/init.sql` remains only as a compatibility schema snapshot for legacy/manual recovery. CI and package scripts use D1 migrations, and future schema changes belong in `migrations/`.
