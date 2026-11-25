ALTER TABLE "RoomPlayer"
  DROP CONSTRAINT "RoomPlayer_userId_fkey",
  ADD CONSTRAINT "RoomPlayer_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GameAction"
  DROP CONSTRAINT "GameAction_actorId_fkey",
  ADD CONSTRAINT "GameAction_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
