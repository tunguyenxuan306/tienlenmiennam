import cors from "cors";
import express from "express";
import helmet from "helmet";
import http from "node:http";
import { Server } from "socket.io";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { PrismaClient, UserRole } from "@prisma/client";
import { z } from "zod";
import { classifyCards, canBeat, createDeck, Suit, SUIT_ORDER } from "./rules";
import { applyWalletTransaction } from "./wallet";
import { chooseBotCards } from "./bot";
import { GameRepository, PersistedGameRoom as MemoryRoom } from "./gameRepository";

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();
const gameRepository = new GameRepository(prisma);
app.set("trust proxy", 1);
app.disable("x-powered-by");
const configuredOrigins = (process.env.CORS_ORIGINS ?? process.env.FRONTEND_URL ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const origins = configuredOrigins.length ? configuredOrigins : ["https://tienlenmiennam-sigma.vercel.app"];
const isProduction = process.env.NODE_ENV === "production";

if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must be configured with at least 32 characters in production");
}
if (isProduction && (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32)) {
  throw new Error("JWT_REFRESH_SECRET must be configured with at least 32 characters in production");
}
if (isProduction && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be configured in production");
}
if (isProduction && !configuredOrigins.length) {
  throw new Error("CORS_ORIGINS must contain the deployed frontend origin in production");
}

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origins.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: "64kb" }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }));
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

const accessSecret = process.env.JWT_SECRET ?? "local-only-access-secret-not-for-production";
const refreshSecret = process.env.JWT_REFRESH_SECRET ?? "local-only-refresh-secret-not-for-production";

type AuthPayload = { sub: string; role: UserRole; mustChangePassword?: boolean };

function signAccess(user: { id: string; role: UserRole }) {
  return jwt.sign({ sub: user.id, role: user.role }, accessSecret, { expiresIn: "15m" });
}

async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  let payload: AuthPayload;
  try {
    payload = jwt.verify(header.slice(7), accessSecret) as AuthPayload;
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true, mustChangePassword: true }
    });
    if (!user || user.status !== "ACTIVE") return res.status(401).json({ error: "Account unavailable" });
    (req as express.Request & { auth: AuthPayload }).auth = {
      sub: user.id,
      role: user.role,
      mustChangePassword: user.mustChangePassword
    };
    return next();
  } catch {
    return res.status(503).json({ error: "Authentication service unavailable" });
  }
}

function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  if (auth.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  if (auth.mustChangePassword) {
    return res.status(403).json({ error: "Change the bootstrap password before using admin functions" });
  }
  return next();
}

function hashRefreshToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "ok", service: "tien-len-server", timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: "unavailable", database: "unavailable", service: "tien-len-server" });
  }
});

app.get("/api", (_req, res) => {
  res.json({ name: "Tiến Lên Online API", version: "1" });
});

const registerSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/),
  password: z.string().min(8).max(72),
  nickname: z.string().trim().min(2).max(32),
  email: z.string().email().optional()
});

app.post("/api/auth/register", authRateLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid registration data", issues: parsed.error.issues });
  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          username: parsed.data.username,
          nickname: parsed.data.nickname,
          email: parsed.data.email,
          passwordHash
        }
      });
      await tx.wallet.create({ data: { userId: created.id, balance: BigInt(0) } });
      return created;
    });
    return res.status(201).json({ id: user.id, username: user.username, nickname: user.nickname });
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") return res.status(409).json({ error: "Username or email already exists" });
    return res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/login", authRateLimit, async (req, res) => {
  const parsed = z.object({
    username: z.string().min(3).max(64),
    password: z.string().min(1).max(72)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid login data" });

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ username: parsed.data.username }, { email: parsed.data.username }],
      status: "ACTIVE"
    }
  });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const accessToken = signAccess(user);
  const refreshToken = jwt.sign({ sub: user.id }, refreshSecret, { expiresIn: "30d" });
  await prisma.$transaction(async (tx) => {
    await tx.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    if (user.role === "ADMIN") {
      await tx.adminLog.create({
        data: { actorId: user.id, action: "ADMIN_LOGIN", ipAddress: req.ip }
      });
    }
  });

  return res.json({
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      role: user.role,
      mustChangePassword: user.mustChangePassword
    }
  });
});

app.post("/api/auth/refresh", authRateLimit, async (req, res) => {
  const refreshToken = z.string().safeParse(req.body?.refreshToken);
  if (!refreshToken.success) return res.status(400).json({ error: "Refresh token required" });
  try {
    const payload = jwt.verify(refreshToken.data, refreshSecret) as { sub: string };
    const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken.data) } });
    if (!stored || stored.revokedAt || stored.userId !== payload.sub || stored.expiresAt <= new Date()) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== "ACTIVE") return res.status(401).json({ error: "Account unavailable" });
    const nextRefreshToken = jwt.sign({ sub: user.id }, refreshSecret, { expiresIn: "30d" });
    const nextTokenHash = hashRefreshToken(nextRefreshToken);
    const rotated = await prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { revokedAt: new Date() }
      });
      if (revoked.count !== 1) return false;
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: nextTokenHash,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        }
      });
      return true;
    });
    if (!rotated) return res.status(401).json({ error: "Refresh token has already been used" });
    return res.json({ accessToken: signAccess(user), refreshToken: nextRefreshToken });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  const refreshToken = z.string().optional().safeParse(req.body?.refreshToken);
  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  if (refreshToken.success && refreshToken.data) {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken(refreshToken.data), userId: auth.sub, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  }
  if (auth.role === "ADMIN") {
    await prisma.adminLog.create({
      data: { actorId: auth.sub, action: "ADMIN_LOGOUT", ipAddress: req.ip }
    });
  }
  return res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const userId = (req as express.Request & { auth: AuthPayload }).auth.sub;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { wallet: true }
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  return res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    role: user.role,
    balance: user.wallet ? user.wallet.balance.toString() : "0",
    gamesPlayed: user.gamesPlayed,
    gamesWon: user.gamesWon
  });
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().max(72), newPassword: z.string().min(8).max(72) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid password data" });
  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  const user = await prisma.user.findUnique({ where: { id: auth.sub } });
  if (!user || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12), mustChangePassword: false }
    }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } })
  ]);
  return res.json({ ok: true });
});

const rooms = new Map<string, MemoryRoom>();

app.get("/api/rooms", requireAuth, async (_req, res) => {
  const dbRooms = await prisma.gameRoom.findMany({
    where: { status: { in: ["WAITING", "PLAYING"] }, visibility: "PUBLIC" },
    include: { players: true, spectators: true },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return res.json(dbRooms.map((room) => ({
    id: room.id,
    code: room.code,
    name: room.name,
    status: room.status,
    visibility: room.visibility,
    entryFee: room.entryFee.toString(),
    playerCount: room.players.filter((player) => !player.leftAt).length,
    spectatorCount: room.spectators.filter((spectator) => !spectator.leftAt).length,
    botEnabled: room.botEnabled
  })));
});

app.post("/api/rooms", requireAuth, async (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(2).max(48),
    visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
    entryFee: z.literal(0).default(0),
    botEnabled: z.boolean().default(true),
    maxSpectators: z.coerce.number().int().min(0).max(100).default(20)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid room data" });

  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  const owner = await prisma.user.findUnique({ where: { id: auth.sub } });
  if (!owner) return res.status(404).json({ error: "User not found" });
  const code = crypto.randomBytes(3).toString("hex").toUpperCase();
  const room = await prisma.gameRoom.create({
    data: {
      code,
      name: parsed.data.name,
      ownerId: owner.id,
      visibility: parsed.data.visibility,
      entryFee: BigInt(parsed.data.entryFee),
      botEnabled: parsed.data.botEnabled,
      maxSpectators: parsed.data.maxSpectators,
      players: { create: { userId: owner.id, seat: 0, isReady: true } }
    }
  });
  rooms.set(room.id, {
    id: room.id,
    code: room.code,
    name: room.name,
    ownerId: owner.id,
    entryFee: room.entryFee,
    botEnabled: room.botEnabled,
    status: "WAITING",
    players: [{ userId: owner.id, seat: 0, isBot: false, nickname: owner.nickname }],
    spectators: [],
    hands: {},
    currentSeat: 0,
    currentCards: [],
    publicHistory: [],
    passedSeats: [],
    lastPlayedSeat: 0,
    firstLeadPending: false,
    activeSessionId: null,
    version: 0,
    turnDeadlineAt: null
  });
  return res.status(201).json({ id: room.id, code: room.code, name: room.name });
});

app.post("/api/rooms/:code/join", requireAuth, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  const roomCode = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;
  const room = await prisma.gameRoom.findUnique({
    where: { code: roomCode.toUpperCase() },
    include: { players: true }
  });
  if (!room || room.status === "CLOSED" || room.status === "CANCELLED") {
    return res.status(404).json({ error: "Room not found" });
  }
  const activePlayers = room.players.filter((player) => !player.leftAt);
  if (activePlayers.some((player) => player.userId === auth.sub)) {
    return res.json({ id: room.id, code: room.code });
  }
  if (room.status !== "WAITING") return res.status(409).json({ error: "Cannot join a game after it has started" });
  const seat = [0, 1, 2, 3].find((candidate) => !activePlayers.some((player) => player.seat === candidate));
  if (seat === undefined) return res.status(409).json({ error: "No seats available" });

  try {
    await prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId: auth.sub } });
    if (!wallet) throw new Error("Wallet not found");
    if (room.entryFee > BigInt(0) && wallet.balance < room.entryFee) throw new Error("Insufficient funds");
    if (room.entryFee > BigInt(0)) {
      await applyWalletTransaction(tx, {
        walletId: wallet.id,
        amount: -room.entryFee,
        type: "ENTRY_FEE",
        reason: `Entry fee for room ${room.code}`,
        source: "room-entry",
        idempotencyKey: `room-entry:${room.id}:${auth.sub}`,
        actorUserId: auth.sub,
        targetUserId: auth.sub
      });
    }
    await tx.roomPlayer.create({
      data: { roomId: room.id, userId: auth.sub, seat }
    });
    }, { isolationLevel: "Serializable" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Could not join room";
    return res.status(message === "Insufficient funds" ? 402 : message.includes("Unique constraint") ? 409 : 400)
      .json({ error: message });
  }
  const memoryRoom = rooms.get(room.id);
  if (memoryRoom) {
    const user = await prisma.user.findUnique({ where: { id: auth.sub } });
    if (user) memoryRoom.players.push({ userId: user.id, seat, isBot: false, nickname: user.nickname });
  }
  return res.json({ id: room.id, code: room.code, seat });
});

app.get("/api/wallet/transactions", requireAuth, async (req, res) => {
  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  const wallet = await prisma.wallet.findUnique({ where: { userId: auth.sub } });
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  const transactions = await prisma.transaction.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return res.json(transactions.map((transaction) => ({
    id: transaction.id,
    code: transaction.code,
    type: transaction.type,
    amount: transaction.amount.toString(),
    balanceBefore: transaction.balanceBefore.toString(),
    balanceAfter: transaction.balanceAfter.toString(),
    reason: transaction.reason,
    source: transaction.source,
    createdAt: transaction.createdAt
  })));
});

app.post("/api/admin/wallet/:userId", requireAuth, requireAdmin, async (req, res) => {
  const parsed = z.object({
    amount: z.coerce.number().int().min(1).max(100000000),
    direction: z.enum(["ADD", "DEDUCT"]),
    reason: z.string().trim().min(3).max(255),
    idempotencyKey: z.string().trim().min(8).max(128)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid wallet adjustment" });
  const auth = (req as express.Request & { auth: AuthPayload }).auth;
  const targetUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const wallet = await prisma.wallet.findUnique({ where: { userId: targetUserId } });
  if (!wallet) return res.status(404).json({ error: "Wallet not found" });
  try {
    const result = await prisma.$transaction(async (tx) => {
      const transaction = await applyWalletTransaction(tx, {
        walletId: wallet.id,
        amount: parsed.data.direction === "ADD" ? BigInt(parsed.data.amount) : -BigInt(parsed.data.amount),
        type: parsed.data.direction === "ADD" ? "ADMIN_ADD" : "ADMIN_DEDUCT",
        reason: parsed.data.reason,
        source: "admin-wallet-adjustment",
        idempotencyKey: parsed.data.idempotencyKey,
        actorUserId: auth.sub,
        targetUserId
      });
      await tx.adminLog.create({
        data: {
          actorId: auth.sub,
          targetId: targetUserId,
          action: parsed.data.direction === "ADD" ? "WALLET_ADD" : "WALLET_DEDUCT",
          after: { transactionCode: transaction.code, amount: parsed.data.amount },
          ipAddress: req.ip,
          metadata: { reason: parsed.data.reason }
        }
      });
      return transaction;
    }, { isolationLevel: "Serializable" });
    return res.json({ ok: true, transactionCode: result.code });
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message });
  }
});

app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const query = typeof req.query.search === "string" ? req.query.search : "";
  const users = await prisma.user.findMany({
    where: query ? { OR: [{ username: { contains: query, mode: "insensitive" } }, { nickname: { contains: query, mode: "insensitive" } }] } : undefined,
    include: { wallet: true },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return res.json(users.map((user) => ({
    id: user.id,
    username: user.username,
    nickname: user.nickname,
    role: user.role,
    status: user.status,
    balance: user.wallet?.balance.toString() ?? "0",
    createdAt: user.createdAt
  })));
});

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, !origin || origins.includes(origin)),
    credentials: true
  }
});

const turnTimers = new Map<string, NodeJS.Timeout>();

function cloneRoom(room: MemoryRoom): MemoryRoom {
  return {
    ...room,
    players: room.players.map((player) => ({ ...player })),
    spectators: [...room.spectators],
    hands: Object.fromEntries(Object.entries(room.hands).map(([id, cards]) => [id, cards.map((card) => ({ ...card }))])),
    currentCards: room.currentCards.map((card) => ({ ...card })),
    publicHistory: room.publicHistory.map((entry) => ({
      ...entry,
      ...(entry.cards ? { cards: entry.cards.map((card) => ({ ...card })) } : {})
    })),
    passedSeats: [...room.passedSeats],
    turnDeadlineAt: room.turnDeadlineAt ? new Date(room.turnDeadlineAt) : null
  };
}

async function reloadRoom(roomId: string) {
  const restored = await gameRepository.restoreRooms();
  for (const room of restored) rooms.set(room.id, room);
  const room = rooms.get(roomId);
  if (room?.status === "PLAYING") scheduleTurn(room);
  return room;
}

async function commitGameAction(
  room: MemoryRoom,
  expectedVersion: number,
  actor: MemoryRoom["players"][number],
  type: "PLAY" | "PASS",
  cards?: ReturnType<typeof createDeck>,
  finished = false
) {
  if (!room.activeSessionId) return false;
  room.publicHistory.push({ seat: actor.seat, type, ...(cards ? { cards } : {}) });
  room.turnDeadlineAt = finished ? null : new Date(Date.now() + (
    room.players.find((player) => player.seat === room.currentSeat)?.isBot
      ? 1200 + crypto.randomInt(1400)
      : 30_000
  ));
  try {
    const result = await gameRepository.persistTransition({
      room,
      expectedVersion,
      actorSeat: actor.seat,
      actorUserId: actor.isBot ? null : actor.userId,
      isBot: actor.isBot,
      type,
      cards,
      idempotencyKey: `${room.activeSessionId}:${expectedVersion}:${actor.seat}:${type}:${(cards ?? [])
        .map((card) => `${card.rank}-${card.suit}`).join(",")}`,
      finished
    });
    if (result !== "committed") {
      await reloadRoom(room.id);
      return false;
    }
    room.version = expectedVersion + 1;
    rooms.set(room.id, room);
    return true;
  } catch (error) {
    console.error("Could not persist game action", error);
    await reloadRoom(room.id);
    return false;
  }
}

function finishGame(room: MemoryRoom, winnerSeat: number) {
  room.status = "WAITING";
  room.activeSessionId = null;
  room.hands = {};
  room.turnDeadlineAt = null;
  rooms.set(room.id, room);
  const timer = turnTimers.get(room.id);
  if (timer) clearTimeout(timer);
  turnTimers.delete(room.id);
  io.to(`room:${room.id}`).emit("game:finished", { winnerSeat, payout: "0" });
  for (const memberSocket of io.sockets.sockets.values()) {
    if (!memberSocket.rooms.has(`room:${room.id}`)) continue;
    memberSocket.emit("room:state", {
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      players: room.players.map(({ userId, ...player }) => player),
      spectators: room.spectators.length,
      isOwner: room.ownerId === memberSocket.data.userId
    });
  }
}

function scheduleTurn(room: MemoryRoom) {
  const previous = turnTimers.get(room.id);
  if (previous) clearTimeout(previous);
  if (room.status !== "PLAYING") return;
  const actor = room.players.find((player) => player.seat === room.currentSeat);
  if (!actor) return;
  const deadline = room.turnDeadlineAt?.getTime() ?? Date.now() + (actor.isBot ? 1200 + crypto.randomInt(1400) : 30_000);
  const timer = setTimeout(async () => {
    const current = rooms.get(room.id);
    if (!current || current.status !== "PLAYING" || current.currentSeat !== actor.seat) return;
    const expectedVersion = current.version;
    const next = cloneRoom(current);
    const nextActor = next.players.find((player) => player.seat === next.currentSeat);
    if (!nextActor) return;
    const hand = next.hands[nextActor.userId] ?? [];
    let chosen: ReturnType<typeof createDeck> = [];
    if (next.firstLeadPending) {
      const threeOfSpades = hand.find((card) => card.rank === 3 && card.suit === "SPADES");
      if (threeOfSpades) chosen = [threeOfSpades];
    } else {
      chosen = chooseBotCards(hand, next.currentCards);
    }

    if (chosen.length) {
      next.hands[nextActor.userId] = hand.filter((held) =>
        !chosen.some((card) => held.rank === card.rank && held.suit === card.suit)
      );
      next.currentCards = chosen;
      next.passedSeats = [];
      next.lastPlayedSeat = nextActor.seat;
      next.firstLeadPending = false;
      const finished = next.hands[nextActor.userId].length === 0;
      if (!finished) next.currentSeat = (next.currentSeat + 1) % 4;
      if (!await commitGameAction(next, expectedVersion, nextActor, "PLAY", chosen, finished)) return;
      io.to(`room:${room.id}`).emit("game:played", {
        seat: nextActor.seat,
        cards: chosen,
        remaining: next.hands[nextActor.userId].length,
        bot: nextActor.isBot,
        timeout: !nextActor.isBot
      });
      if (finished) {
        finishGame(next, nextActor.seat);
        return;
      }
    } else if (next.currentCards.length) {
      next.passedSeats.push(nextActor.seat);
      const passedOthers = next.passedSeats.filter((seat) => seat !== next.lastPlayedSeat).length;
      if (passedOthers >= next.players.length - 1) {
        next.currentCards = [];
        next.passedSeats = [];
        next.currentSeat = next.lastPlayedSeat;
      } else {
        next.currentSeat = (next.currentSeat + 1) % 4;
      }
      if (!await commitGameAction(next, expectedVersion, nextActor, "PASS")) return;
      io.to(`room:${room.id}`).emit("game:passed", { seat: nextActor.seat, bot: nextActor.isBot, timeout: !nextActor.isBot });
    } else {
      next.currentSeat = (next.currentSeat + 1) % 4;
      if (!await commitGameAction(next, expectedVersion, nextActor, "PASS")) return;
      io.to(`room:${room.id}`).emit("game:passed", { seat: nextActor.seat, bot: nextActor.isBot, timeout: !nextActor.isBot });
    }
    io.to(`room:${room.id}`).emit("game:turn", { seat: next.currentSeat });
    scheduleTurn(next);
  }, Math.max(0, deadline - Date.now()));
  turnTimers.set(room.id, timer);
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string") return next(new Error("Socket authentication required"));
  try {
    const payload = jwt.verify(token, accessSecret) as AuthPayload;
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, status: true }
    });
    if (!user || user.status !== "ACTIVE") return next(new Error("Account unavailable"));
    socket.data.userId = user.id;
    socket.data.role = user.role;
    socket.data.token = token;
    return next();
  } catch {
    return next(new Error("Socket authentication failed"));
  }
});

io.on("connection", (socket) => {
  socket.emit("server:ready", { socketId: socket.id });
  socket.on("disconnect", () => {
    const anotherSocket = [...io.sockets.sockets.values()].some((candidate) =>
      candidate.id !== socket.id && candidate.data.userId === socket.data.userId
    );
    if (!anotherSocket) {
      void prisma.roomPlayer.updateMany({
        where: { userId: socket.data.userId, leftAt: null, connected: true },
        data: { connected: false }
      }).catch(() => {
        console.error(`Failed to mark disconnected user ${socket.data.userId} offline`);
      });
    }
  });
  let eventWindowStartedAt = Date.now();
  let eventCount = 0;
  socket.use(async (_packet, next) => {
    const now = Date.now();
    if (now - eventWindowStartedAt >= 10_000) {
      eventWindowStartedAt = now;
      eventCount = 0;
    }
    eventCount += 1;
    if (eventCount > 80) return next(new Error("Socket event rate limit exceeded"));
    try {
      jwt.verify(socket.data.token, accessSecret);
      const user = await prisma.user.findUnique({
        where: { id: socket.data.userId },
        select: { status: true }
      });
      if (!user || user.status !== "ACTIVE") return next(new Error("Account unavailable"));
      return next();
    } catch {
      return next(new Error("Socket authorization failed"));
    }
  });

  socket.on("room:join", async (payload: unknown) => {
    const parsed = z.object({ code: z.string().trim().min(6).max(6) }).safeParse(payload);
    if (!parsed.success) return socket.emit("room:error", { message: "Invalid room code" });
    const room = [...rooms.values()].find((candidate) => candidate.code === parsed.data.code.toUpperCase());
    if (!room) return socket.emit("room:error", { message: "Room not found or unavailable" });
    const hasSeat = room.players.some((player) => player.userId === socket.data.userId && !player.isBot);
    const isSpectator = room.spectators.includes(socket.data.userId);
    if (!hasSeat && !isSpectator) return socket.emit("room:error", { message: "Join the room before connecting" });
    if (hasSeat) {
      try {
        await prisma.roomPlayer.updateMany({
          where: { roomId: room.id, userId: socket.data.userId, leftAt: null },
          data: { connected: true }
        });
      } catch {
        return socket.emit("room:error", { message: "Could not restore player session" });
      }
    }
    socket.join(`room:${room.id}`);
    socket.emit("room:state", {
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      players: room.players.map(({ userId, ...player }) => player),
      spectators: room.spectators.length,
      isOwner: room.ownerId === socket.data.userId
    });

    const hand = room.hands[socket.data.userId];
    if (room.status === "PLAYING") {
      socket.emit("game:state", {
        currentSeat: room.currentSeat,
        currentCards: room.currentCards,
        passedSeats: room.passedSeats,
        lastPlayedSeat: room.lastPlayedSeat,
        firstLeadPending: room.firstLeadPending,
        handCounts: Object.fromEntries(room.players.map((player) => [
          player.seat,
          room.hands[player.userId]?.length ?? 0
        ])),
        history: room.publicHistory,
        turnDeadlineAt: room.turnDeadlineAt?.toISOString() ?? null
      });
    }
    if (hand) socket.emit("game:hand", { cards: hand });
  });

  socket.on("room:chat", async (payload: unknown) => {
    const parsed = z.object({ roomId: z.string().min(1), content: z.string().trim().min(1).max(500) }).safeParse(payload);
    if (!parsed.success || !socket.rooms.has(`room:${parsed.data.roomId}`)) return;
    try {
      const saved = await prisma.chatMessage.create({
        data: { roomId: parsed.data.roomId, userId: socket.data.userId, content: parsed.data.content },
        include: { user: { select: { nickname: true } } }
      });
      io.to(`room:${parsed.data.roomId}`).emit("room:chat", {
        senderId: socket.data.userId,
        nickname: saved.user.nickname,
        content: saved.content,
        createdAt: saved.createdAt.toISOString()
      });
    } catch {
      socket.emit("room:error", { message: "Could not send chat message" });
    }
  });

  socket.on("room:start", async (payload: unknown) => {
    const parsed = z.object({ roomId: z.string().min(1) }).safeParse(payload);
    if (!parsed.success) return socket.emit("room:error", { message: "Invalid room id" });
    const storedRoom = rooms.get(parsed.data.roomId);
    if (!storedRoom || !socket.rooms.has(`room:${storedRoom.id}`) ||
      storedRoom.status !== "WAITING" || storedRoom.ownerId !== socket.data.userId) {
      return socket.emit("room:error", { message: "Only room owner can start the game" });
    }
    const room = cloneRoom(storedRoom);
    if (room.players.length < 4 && room.botEnabled) {
      for (let seat = 0; seat < 4; seat++) {
        if (!room.players.some((player) => player.seat === seat)) {
          room.players.push({ userId: `bot:${room.id}:${seat}`, seat, isBot: true, nickname: `Bot ${seat + 1}` });
        }
      }
    }
    if (room.players.length !== 4) return socket.emit("room:error", { message: "Four seats are required" });
    let deck = createDeck();
    for (let i = deck.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    room.hands = {};
    room.publicHistory = [];
    room.players.forEach((player, index) => {
      room.hands[player.userId] = deck.slice(index * 13, index * 13 + 13).sort((a, b) =>
        (a.rank - b.rank) * 4 + (SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit])
      );
    });
    const firstSeat = room.players.find((player) =>
      room.hands[player.userId].some((card) => card.rank === 3 && card.suit === "SPADES")
    )?.seat ?? 0;
    room.currentSeat = firstSeat;
    room.currentCards = [];
    room.passedSeats = [];
    room.lastPlayedSeat = firstSeat;
    room.firstLeadPending = true;
    room.status = "PLAYING";
    try {
      room.version = 0;
      const currentPlayer = room.players.find((player) => player.seat === room.currentSeat);
      const firstDelay = currentPlayer?.isBot ? 1200 + crypto.randomInt(1400) : 30_000;
      room.turnDeadlineAt = new Date(Date.now() + firstDelay);
      const sessionId = await gameRepository.start(room, room.ownerId, room.turnDeadlineAt);
      if (!sessionId) throw new Error("Room state changed before game start");
      room.activeSessionId = sessionId;
    } catch {
      room.status = "WAITING";
      room.hands = {};
      room.turnDeadlineAt = null;
      return socket.emit("room:error", { message: "Could not start game; try again" });
    }
    rooms.set(room.id, room);
    io.to(`room:${room.id}`).emit("game:turn", { seat: room.currentSeat });
    for (const memberSocket of io.sockets.sockets.values()) {
      if (!memberSocket.rooms.has(`room:${room.id}`)) continue;
      memberSocket.emit("room:state", {
        id: room.id,
        code: room.code,
        name: room.name,
        status: room.status,
        players: room.players.map(({ userId, ...player }) => player),
        spectators: room.spectators.length,
        isOwner: room.ownerId === memberSocket.data.userId
      });
    }
    for (const player of room.players) {
      if (player.isBot) continue;
      const playerSocket = [...io.sockets.sockets.values()].find((candidate) => candidate.data.userId === player.userId);
      playerSocket?.emit("game:hand", { cards: room.hands[player.userId] });
    }
    scheduleTurn(room);
  });

  socket.on("game:play", async (payload: unknown) => {
    const parsed = z.object({
      roomId: z.string().min(1),
      cards: z.array(z.object({
        rank: z.number().int().min(3).max(15),
        suit: z.enum(["SPADES", "CLUBS", "DIAMONDS", "HEARTS"])
      })).min(1).max(13)
    }).safeParse(payload);
    if (!parsed.success) return socket.emit("game:error", { message: "Invalid play payload" });
    const { roomId, cards } = parsed.data;
    const storedRoom = rooms.get(roomId);
    if (!storedRoom || !socket.rooms.has(`room:${roomId}`) || storedRoom.status !== "PLAYING") return;
    const expectedVersion = storedRoom.version;
    const room = cloneRoom(storedRoom);
    const player = room.players.find((candidate) => candidate.userId === socket.data.userId);
    if (!player || player.seat !== room.currentSeat) return socket.emit("game:error", { message: "Not your turn" });
    const hand = room.hands[player.userId] ?? [];
    if (!cards?.length || cards.some((card) =>
      !hand.some((held) => held.rank === card.rank && held.suit === card.suit)
    )) return socket.emit("game:error", { message: "Card not in hand" });
    const classification = classifyCards(cards);
    if (room.firstLeadPending && !cards.some((card) => card.rank === 3 && card.suit === "SPADES")) {
      return socket.emit("game:error", { message: "The opening play must include the three of spades" });
    }
    if (classification.type === "INVALID" || (room.currentCards.length && !canBeat(cards, room.currentCards))) {
      return socket.emit("game:error", { message: "Invalid or weaker combination" });
    }
    room.hands[player.userId] = hand.filter((held) =>
      !cards.some((card) => held.rank === card.rank && held.suit === card.suit)
    );
    room.currentCards = cards;
    room.passedSeats = [];
    room.lastPlayedSeat = player.seat;
    room.firstLeadPending = false;
    const finished = room.hands[player.userId].length === 0;
    if (!finished) room.currentSeat = (room.currentSeat + 1) % 4;
    if (!await commitGameAction(room, expectedVersion, player, "PLAY", cards, finished)) {
      return socket.emit("game:error", { message: "Game state changed; resync and try again" });
    }
    io.to(`room:${room.id}`).emit("game:played", {
      seat: player.seat,
      cards,
      remaining: room.hands[player.userId].length
    });
    if (finished) {
      finishGame(room, player.seat);
      return;
    }
    io.to(`room:${room.id}`).emit("game:turn", { seat: room.currentSeat });
    scheduleTurn(room);
  });

  socket.on("game:pass", async (payload: unknown) => {
    const parsed = z.object({ roomId: z.string().min(1) }).safeParse(payload);
    if (!parsed.success) return socket.emit("game:error", { message: "Invalid pass payload" });
    const storedRoom = rooms.get(parsed.data.roomId);
    if (!storedRoom || !socket.rooms.has(`room:${storedRoom.id}`) || storedRoom.status !== "PLAYING") return;
    const expectedVersion = storedRoom.version;
    const room = cloneRoom(storedRoom);
    const player = room.players.find((candidate) => candidate.userId === socket.data.userId);
    if (!player || player.seat !== room.currentSeat) return socket.emit("game:error", { message: "Not your turn" });
    if (!room.currentCards.length || room.firstLeadPending) return socket.emit("game:error", { message: "Cannot pass when leading a new trick" });
    room.passedSeats.push(player.seat);
    const everyonePassed = room.passedSeats.filter((seat) => seat !== room.lastPlayedSeat).length === room.players.length - 1;
    if (everyonePassed) {
      room.currentCards = [];
      room.passedSeats = [];
      room.currentSeat = room.lastPlayedSeat;
    } else {
      room.currentSeat = (room.currentSeat + 1) % 4;
    }
    if (!await commitGameAction(room, expectedVersion, player, "PASS")) {
      return socket.emit("game:error", { message: "Game state changed; resync and try again" });
    }
    io.to(`room:${room.id}`).emit("game:passed", { seat: player.seat });
    io.to(`room:${room.id}`).emit("game:turn", { seat: room.currentSeat });
    scheduleTurn(room);
  });

  socket.on("player:bot", async (payload: unknown) => {
    const parsed = z.object({
      roomId: z.string().min(1),
      seat: z.number().int().min(0).max(3),
      level: z.enum(["easy", "medium", "hard"]).default("medium")
    }).safeParse(payload);
    if (!parsed.success) return socket.emit("room:error", { message: "Invalid bot request" });
    const room = rooms.get(parsed.data.roomId);
    if (!room || room.ownerId !== socket.data.userId || room.status !== "WAITING") {
      return socket.emit("room:error", { message: "Only the room owner can add a bot before the game" });
    }
    const occupied = room.players.find((candidate) => candidate.seat === parsed.data.seat);
    if (occupied) return socket.emit("room:error", { message: "Seat is already occupied" });
    const userId = `bot:${room.id}:${parsed.data.seat}`;
    const botPlayer = { userId, seat: parsed.data.seat, isBot: true, nickname: `Bot ${parsed.data.seat + 1}` };
    try {
      await prisma.roomPlayer.upsert({
        where: { roomId_seat: { roomId: room.id, seat: parsed.data.seat } },
        create: {
          roomId: room.id,
          seat: parsed.data.seat,
          isBot: true,
          botName: botPlayer.nickname,
          botLevel: parsed.data.level,
          isReady: true
        },
        update: {
          isBot: true,
          botName: botPlayer.nickname,
          botLevel: parsed.data.level,
          leftAt: null,
          isReady: true
        }
      });
    } catch {
      return socket.emit("room:error", { message: "Could not save bot seat" });
    }
    room.players.push(botPlayer);
    socket.emit("room:state", {
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      players: room.players.map(({ userId: _id, ...player }) => player),
      spectators: room.spectators.length,
      isOwner: true
    });
  });
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  const status = (error as { status?: number }).status;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
  const details = error && typeof error === "object"
    ? { name: "name" in error ? String(error.name) : "Error", code: "code" in error ? String(error.code) : undefined }
    : { name: "UnknownError" };
  console.error("Unhandled API request error", details);
  return res.status(httpStatus).json({ error: httpStatus === 500 ? "Internal server error" : "Request failed" });
});

const port = Number(process.env.PORT ?? 4000);
async function startServer() {
  const restoredRooms = await gameRepository.restoreRooms();
  for (const room of restoredRooms) rooms.set(room.id, room);
  const restoredIds = restoredRooms.map((room) => room.id);
  if (restoredIds.length) {
    await prisma.roomPlayer.updateMany({
      where: { roomId: { in: restoredIds }, leftAt: null, connected: true },
      data: { connected: false }
    });
  }
  for (const room of restoredRooms) {
    if (room.status === "PLAYING") scheduleTurn(room);
  }
  server.listen(port, () => {
    console.log(`Server listening on port ${port}; restored ${restoredRooms.length} rooms`);
  });
}
void startServer().catch(async (error: unknown) => {
  console.error("Could not recover persisted rooms; refusing to start game server", error);
  await prisma.$disconnect();
  process.exitCode = 1;
});

let isShuttingDown = false;
async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  for (const turnTimer of turnTimers.values()) clearTimeout(turnTimer);
  turnTimers.clear();
  io.close(async () => {
    await prisma.$disconnect();
    clearTimeout(timeout);
    process.exit(0);
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
