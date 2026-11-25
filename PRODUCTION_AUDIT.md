# Production Audit

**Audit date:** 2026-11-26  
**Deployment status:** Not deployed. **Production gate: NO-GO.**  
**Scope:** Repository source and local checks only. The local PostgreSQL service is unavailable, so database behavior and migration application are unverified.

## Executive summary

The project now has a Prisma-backed game persistence layer and startup recovery code. A game start saves the public session state, a separate private hand row for each seat, the round, deadline, and start action in one transaction. Game transitions use a session version compare-and-swap, persist the public history/action and private hands in the same transaction, and commit zero-payout results with game completion. Startup restores waiting/playing rooms and schedules active turns against the stored deadline. Invalid/incomplete active state is cancelled instead of dealing new cards.

This is an implementation milestone, not proof of production readiness. The new migration has not been applied to PostgreSQL; no repository integration, restart, concurrency, socket or settlement tests have run. Keep entry fees and payout at zero. Deploy one backend instance only; there is no Redis Socket.IO adapter or cross-instance broadcast.

## Current local evidence

| Check | Result |
| --- | --- |
| Prisma schema validation | Passed after schema edits |
| Prisma client generation | Passed |
| `npm run build` | Passed: shared, server, and Next.js production builds |
| `npm test` | Passed: 12 existing rules/bot tests; no persistence tests |
| `npm run lint` | Passed |
| `npm audit --omit=dev` | Passed: 0 reported vulnerabilities |
| Migration status | Blocked: PostgreSQL at `localhost:5432` unavailable (P1001) |
| Production deploy | Not performed |

## Audit findings

### Frontend

- Next.js workspace build and ESLint have passed in prior checks; re-run the full build after the current server changes.
- Frontend routes and auth flows exist. Browser refresh/access tokens remain in `localStorage`, so an XSS can expose them.
- Lobby/game use the REST API and Socket.IO; production endpoint/environment configuration must be tested against the actual Vercel and Render origins.
- Loading/error handling and responsive layouts are not comprehensively browser-tested. Admin UI/API coverage is partial.

### Backend and persistence

- Express and Socket.IO server have auth/rate limits, `/health`, CORS allow-listing, and graceful shutdown code.
- New incremental migration: `prisma/migrations/20261126010500_game_persistence/migration.sql`. It adds session versions/deadlines, private hand state, action idempotency/version fields, settlement metadata, and bot seat fields.
- `GameRepository` is used for start, action persistence, and startup restore. Session updates compare the expected version; turn changes, private hand writes, action history, results and finish status share a database transaction.
- Startup loads active rooms before listening and preserves persisted deadlines. Reconnect sends public state/history and only the requesting player's own hand.
- Migration application, PostgreSQL transaction isolation behavior, recovery, duplicate requests, and multi-worker races have not been verified against a database.
- Recovery currently cancels malformed/incomplete active sessions and returns the room to waiting; it does not re-deal cards. Operators need logs and a future admin/reconciliation workflow for these cases.
- In-memory room projections and Socket.IO room membership are still instance-local. Database version checks prevent conflicting writes, but they do not synchronize broadcasts or memberships across instances. Single instance only.

### Game rules and bot

- The existing rules engine covers core combinations, opening 3♠, passing and several special combinations. Full rule coverage (stacked cuts, penalties, optional instant wins and variants) remains incomplete.
- Bot strategy is basic. Existing unit tests cover only rules and bot behavior; timeout/recovery interactions have no automated integration coverage.

### Wallet and settlement

- Room creation still restricts entry fee to zero. Game completion records zero-payout results only.
- No atomic game wallet settlement, settlement retry/reconciliation, or end-to-end idempotency workflow is implemented. Do not enable entry fees or payouts.

### Spectator and admin

- Persistence schema includes spectators, but a complete spectator join/leave/watch/seat-request flow and backend socket permissions are not implemented.
- Admin auth and some user/wallet APIs exist; dashboard, moderation, room controls, audit-log UI, rules/bot configuration and full authorization tests remain incomplete.

### Security and operations

- JWT secrets are required in production and CORS is origin-allow-listed. Review all production values and logs before deployment.
- Access/refresh tokens in browser localStorage remain a material XSS risk. HttpOnly cookies/CSRF migration has not been completed.
- Rate limiting and socket authorization are process-local. Shared distributed rate limits and socket adapter are absent.
- Render/Vercel configuration and deployment instructions exist, but no production environment or domain has been exercised.

## Required gates before production

1. Apply the incremental migration to an isolated PostgreSQL test database; verify migration status and a clean rollback/restore procedure.
2. Add and pass integration tests for registration/login, room lifecycle, game actions, private hand access, duplicate/concurrent actions, restart recovery, timeout/bot, result idempotency, and authorization.
3. Test that restart keeps dealt hands, current seat, public history and original deadline; test the race where two workers act on one version.
4. Keep deployment at one backend instance until Redis adapter, shared socket membership/broadcast, and cross-instance tests are implemented.
5. Keep entry fee and payout disabled until settlement, reconciliation and failure-retry tests pass.
6. Complete spectator permissions, admin workflows, security review (including browser token storage), and production smoke tests.
7. Deploy only with user authorization; none has been performed for this audit.
