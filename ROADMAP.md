# Roadmap triển khai

## Giai đoạn 1 — Nền tảng
- [x] Monorepo npm workspaces
- [x] Frontend Next.js nền
- [x] Backend Express và Socket.IO nền
- [x] Package dùng chung
- [x] Environment mẫu và README
- [x] Prisma/schema

## Giai đoạn 2 — Database
- [x] User, role, wallet, transaction
- [x] Room, session, round, action, result (schema)
- [~] Durable game session, private seat state, action history, deadline (migration authored; DB apply/integration unverified)
- [x] Spectator, chat, admin log, settings
- [x] Migration và seed
- [x] Bootstrap admin

## Giai đoạn 3 — Backend
- [x] JWT và refresh-token rotation
- [x] REST authorization cơ bản
- [~] Wallet idempotency và atomic admin adjustment (chưa có game settlement/payout)
- [~] Rules engine (chưa đủ luật phụ/chặt chồng/thối/tới trắng)
- [~] Rooms và admin APIs (chưa đầy đủ moderation/config)

## Giai đoạn 4 — Realtime
- [x] Socket auth và kiểm tra quyền sự kiện
- [~] Room/game events (DB persistence/version CAS implemented; runtime cache and realtime are instance-local)
- [~] Reconnect/timeout (startup restore and persisted deadline implemented; integration unverified)
- [ ] Redis Socket.IO adapter and multi-instance realtime
- [~] Bot AI (basic; cần test tích hợp và chiến thuật)

## Giai đoạn 5 — Frontend
- [x] Auth/profile
- [x] Lobby
- [x] Game table cơ bản
- [x] Admin cơ bản

## Giai đoạn 6 — Chất lượng
- [~] Rules/bot unit tests (12 existing tests; persistence not covered)
- [ ] Security/API integration tests
- [x] Production build
- [ ] Integration/E2E tests (PostgreSQL unavailable locally)

## Giai đoạn 7 — Deployment
- [ ] Render (chưa deploy)
- [ ] Vercel (chưa deploy)
- [ ] Backup và vận hành
- [ ] PostgreSQL migration/recovery verification
- [ ] Enforce single instance until shared Socket.IO adapter is deployed
