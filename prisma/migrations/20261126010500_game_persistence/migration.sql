CREATE TYPE "SettlementStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PROCESSING', 'SETTLED', 'FAILED');

ALTER TABLE "RoomPlayer"
  ALTER COLUMN "userId" DROP NOT NULL,
  ADD COLUMN "botName" TEXT,
  ADD COLUMN "botLevel" TEXT;

ALTER TABLE "GameSession"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "turnDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "settlementStatus" "SettlementStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "settledAt" TIMESTAMP(3);

ALTER TABLE "GameAction"
  ALTER COLUMN "actorId" DROP NOT NULL,
  ADD COLUMN "actorSeat" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "isBot" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "stateVersion" INTEGER;
ALTER TABLE "GameAction" ALTER COLUMN "actorSeat" DROP DEFAULT;

CREATE TABLE "GamePrivateState" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "seat" INTEGER NOT NULL,
  "userId" TEXT,
  "isBot" BOOLEAN NOT NULL DEFAULT false,
  "cards" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GamePrivateState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Settlement" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
  "totalAmount" BIGINT NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GameAction_idempotencyKey_key" ON "GameAction"("idempotencyKey");
CREATE UNIQUE INDEX "GamePrivateState_sessionId_seat_key" ON "GamePrivateState"("sessionId", "seat");
CREATE INDEX "GamePrivateState_userId_idx" ON "GamePrivateState"("userId");
CREATE UNIQUE INDEX "Settlement_sessionId_key" ON "Settlement"("sessionId");
CREATE UNIQUE INDEX "Settlement_idempotencyKey_key" ON "Settlement"("idempotencyKey");
CREATE INDEX "Settlement_status_updatedAt_idx" ON "Settlement"("status", "updatedAt");

ALTER TABLE "GamePrivateState"
  ADD CONSTRAINT "GamePrivateState_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GamePrivateState"
  ADD CONSTRAINT "GamePrivateState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Settlement"
  ADD CONSTRAINT "Settlement_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
