# Production deployment checklist

## Release status

**Production deploy: NOT performed. Production readiness: NO-GO.**

Local checks verified for the current source:

- `npm run build` — shared package, server TypeScript, and Next.js production build.
- `npm test` — 12 game-rules/bot unit tests; no database integration tests exist yet.
- `npm run lint --workspace apps/web` — ESLint.
- `npx prisma validate` — schema validation.
- `npm audit` and `npm audit --omit=dev` — 0 reported vulnerabilities after compatible dependency updates.

The local PostgreSQL database was not available at `localhost:5432` (`prisma migrate status` returned P1001); migrations were **not applied or tested against a running database**. No Render or Vercel deployment was performed.

The current source includes a PostgreSQL game repository, version-checked atomic actions, private per-seat hand rows, public action history, zero-payout results, and startup recovery using saved turn deadlines. These behaviors are **not production-verified** until the incremental migration is applied and recovery/concurrency integration tests pass.

Do not enable paid/entry-fee rooms or call the game production-ready until the following are addressed and verified:

- PostgreSQL now stores game state, private hands, action history, versions, and timer deadlines; the in-process room object is a runtime projection. Restart recovery and concurrent transactions are not database-tested.
- No Redis Socket.IO adapter or shared broadcast exists. Run a single backend instance only; multi-instance room delivery is not safe.
- Settlement is not implemented. Results have zero payout, entry fees remain zero, and wallet settlement/reconciliation is disabled.
- Spectator seat/watch flows, configurable rules, admin moderation/room actions, and broader integration/end-to-end/security tests are incomplete.
- Browser access tokens are stored in `localStorage`; XSS would expose them. Move to a reviewed secure session design before handling valuable accounts.
- Socket.IO has in-process limits only. Multi-instance deployment needs a shared adapter/state store and distributed rate limiting.

## 1. Prepare PostgreSQL

1. Create a managed PostgreSQL database (Render PostgreSQL is supported).
2. Keep the connection string private. Use the provider's internal connection string for a service in the same private network.
3. Configure `DATABASE_URL` in the Render service, not in source control or frontend variables.
4. Confirm the production database is backed up and that restore has been tested.
5. Apply migrations from the repository root:

   ```sh
   npm ci --include=dev
   npm run db:generate
   npm run db:migrate
   ```

6. Confirm `npx prisma migrate status` reports all migrations applied. Apply both `prisma/migrations/20261126000000_initial/` and `prisma/migrations/20261126010500_game_persistence/`; never edit an already-applied migration.

## 2. Deploy the backend to Render

1. Create a Render Web Service from this repository and use the repository root as the service root.
2. `render.yaml` provides the service and database blueprint. Review plan, region, networking, retention, and backup requirements before applying it.
3. Use these commands:

   - Build: `npm ci --include=dev && npm run db:generate && npm run build --workspace apps/server`
   - Start: `npm run db:migrate && npm run start --workspace apps/server`
   - Health check: `/health`

4. Set service environment variables:

   | Variable | Required value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `PORT` | Supplied by Render |
   | `DATABASE_URL` | Render PostgreSQL connection string |
   | `JWT_SECRET` | Render-generated secret, at least 32 characters |
   | `JWT_REFRESH_SECRET` | A separate Render-generated secret, at least 32 characters |
   | `CORS_ORIGINS` | Exact comma-separated frontend origins, e.g. `https://your-app.vercel.app` |
   | `ADMIN_USERNAME` | Chosen bootstrap admin username; required when running seed |
   | `ADMIN_PASSWORD` | Unique, strong bootstrap password; required when running seed |

   Do not add a trailing slash to CORS origins. Do not expose server secrets as `NEXT_PUBLIC_*`.

5. Run the initial admin seed once from a secure Render shell after migrations:

   ```sh
   npm run db:seed
   ```

   The seed requires `ADMIN_PASSWORD`, hashes it with bcrypt, creates the user only if absent, and flags the account to change its password. Do not put a real password in `render.yaml`, a committed `.env`, or deployment logs. If the bootstrap user already exists, seed intentionally does not rotate its password.

6. Verify `https://<render-host>/health` returns HTTP 200 and `"database":"ok"`. If the database is unavailable it should return HTTP 503.

## 3. Deploy the frontend to Vercel

1. Import the same repository into Vercel.
2. Set Root Directory to `apps/web` and enable inclusion of files outside that directory so the npm workspace root and lockfile can be used.
3. Configure the workspace commands if auto-detection does not use the monorepo root:

   - Install: `cd ../.. && npm ci`
   - Build: `cd ../.. && npm run build --workspace apps/web`
   - Framework: Next.js; keep the default Next.js output handling.

4. Set these **build-time** variables for Production and Preview as appropriate:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | `https://<render-host>` |
   | `NEXT_PUBLIC_SOCKET_URL` | `https://<render-host>` |

5. Add the exact Vercel production and preview origins that should be allowed to the Render `CORS_ORIGINS` value, then redeploy the backend.
6. Use HTTPS for both services. Socket.IO connects to the HTTPS URL and upgrades to WebSocket where supported.

## 4. Production smoke tests

Run these against the deployed services using test accounts and a non-production-value wallet:

- [ ] `GET /health` reports database ready.
- [ ] `GET /api` returns the API version.
- [ ] Browser can load `/`, `/login`, `/register`, `/lobby`, `/profile`, `/admin`, and `/room/<code>`.
- [ ] Register and login work; invalid credentials are rejected.
- [ ] Refresh rotates the refresh token; replaying the old token is rejected.
- [ ] A normal user receives 403 from `/api/admin/users` and `/api/admin/wallet/...`.
- [ ] An admin must change the bootstrap password before admin actions.
- [ ] A normal player can create a free room and join using its code.
- [ ] Unauthenticated socket connections and non-members joining private room state are rejected.
- [ ] Each player receives only their own hand; spectators (when implemented) receive no private hand.
- [ ] Opening play requires the three of spades; invalid combinations, duplicate cards, wrong-turn plays, and invalid passes are rejected.
- [ ] Bot turns and human timeout behavior are exercised.
- [ ] Game completion/result records are checked in PostgreSQL.
- [ ] Restart the backend during a test game; verify same hands, turn, public history, and remaining persisted deadline are restored without dealing again.
- [ ] Send concurrent actions at the same game version; verify only one transition commits and one result is recorded.
- [ ] Repeat an admin wallet request with the same idempotency key and verify balance changes once; reuse the key with different values and verify rejection.
- [ ] Confirm browser console, Render logs, and Vercel logs contain no secrets or unhandled errors.

Passing these checks does not replace settlement, spectator, Redis/multi-instance, admin, and security work listed above.

## 5. Common issues

| Symptom | Check |
| --- | --- |
| Render fails at startup with missing secret | Set both JWT secrets to separate values of at least 32 characters. |
| `/health` is 503 | Verify `DATABASE_URL`, network access, PostgreSQL availability, and applied migrations. |
| `prisma migrate deploy` fails | Run `db:generate`, verify migration files and database permissions, then inspect Render logs before retrying. |
| Browser reports CORS failure | Add the exact `https://` frontend origin to `CORS_ORIGINS`; no wildcard or trailing slash. |
| Login works but lobby/game fails | Verify `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SOCKET_URL`, access token freshness, and Render availability. |
| Socket connects but room cannot be joined | Confirm the user joined through the REST endpoint and is an active room member. |
| Vercel cannot find workspace dependencies | Verify Root Directory is `apps/web`, external-root files are enabled, and install/build commands execute from the repository root. |
| Game recovery fails or state is inconsistent | Inspect Render logs and session/private-state rows; recovery cancels unrecoverable sessions rather than dealing again. Do not repair production rows manually without an audited procedure. |
| Multiple backend instances disagree about a room | Only one instance is supported; configure a shared Socket.IO adapter and test cross-instance delivery before scaling. |
| Admin seed does nothing | The username already exists; seed will not overwrite it. Use a reviewed password-reset procedure instead. |

## Final go-live gate

- [ ] Database backup and restore tested.
- [ ] Migrations applied and status verified.
- [ ] Bootstrap admin password changed.
- [ ] Production CORS contains only approved origins.
- [ ] Full integration, socket authorization, reconnect, timeout, and settlement tests pass.
- [ ] Durable game migration is applied; restart and concurrent-action integration tests pass.
- [ ] Redis adapter is deployed and cross-instance Socket.IO tests pass, or deployment remains explicitly single-instance.
- [ ] Secure browser session/token storage is reviewed.
- [ ] Production smoke tests pass.
- [ ] Deployment has been performed and independently verified.
