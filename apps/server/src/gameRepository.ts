import { ActionType, Prisma, PrismaClient } from "@prisma/client";
import type { Card, Suit } from "./rules";

export type PersistedPlayer = {
  userId: string;
  seat: number;
  isBot: boolean;
  nickname: string;
};

export type GameHistoryEntry = {
  seat: number;
  type: "PLAY" | "PASS";
  cards?: Card[];
};

export type PersistedGameRoom = {
  id: string;
  code: string;
  name: string;
  ownerId: string;
  entryFee: bigint;
  botEnabled: boolean;
  status: "WAITING" | "PLAYING" | "CLOSED";
  players: PersistedPlayer[];
  spectators: string[];
  hands: Record<string, Card[]>;
  currentSeat: number;
  currentCards: Card[];
  publicHistory: GameHistoryEntry[];
  passedSeats: number[];
  lastPlayedSeat: number;
  firstLeadPending: boolean;
  activeSessionId: string | null;
  version: number;
  turnDeadlineAt: Date | null;
};

type Transition = {
  room: PersistedGameRoom;
  expectedVersion: number;
  actorSeat: number;
  actorUserId: string | null;
  isBot: boolean;
  type: Extract<ActionType, "PLAY" | "PASS">;
  cards?: Card[];
  idempotencyKey: string;
  finished?: boolean;
};

export class GameRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async start(room: PersistedGameRoom, ownerId: string, deadline: Date): Promise<string | null> {
    return this.prisma.$transaction(async (tx) => {
      if (room.players.length !== 4 || new Set(room.players.map((player) => player.seat)).size !== 4 ||
        room.players.some((player) => player.seat < 0 || player.seat > 3)) {
        throw new Error("Exactly four distinct player seats are required");
      }
      const activeSession = await tx.gameSession.findFirst({
        where: { roomId: room.id, status: "PLAYING" },
        select: { id: true }
      });
      if (activeSession) throw new Error("Room already has an active game session");
      const roomUpdate = await tx.gameRoom.updateMany({
        where: { id: room.id, status: "WAITING" },
        data: { status: "PLAYING" }
      });
      if (roomUpdate.count !== 1) return null;

      const dbPlayers = await tx.roomPlayer.findMany({
        where: { roomId: room.id, leftAt: null }
      });
      for (const player of room.players) {
        const existing = dbPlayers.find((candidate) => candidate.seat === player.seat);
        if (player.isBot) {
          if (existing && (!existing.isBot || existing.userId)) {
            throw new Error("Bot seat conflicts with a persisted human player");
          }
          if (existing) {
            await tx.roomPlayer.update({
              where: { id: existing.id },
              data: { botName: player.nickname, isReady: true }
            });
          } else {
            await tx.roomPlayer.create({
              data: {
                roomId: room.id,
                seat: player.seat,
                isBot: true,
                botName: player.nickname,
                botLevel: "medium",
                isReady: true
              }
            });
          }
        } else if (!existing || existing.userId !== player.userId || existing.isBot) {
          throw new Error("Persisted human seats do not match the room state");
        }
      }

      const session = await tx.gameSession.create({
        data: {
          roomId: room.id,
          status: "PLAYING",
          startedAt: new Date(),
          version: 0,
          turnDeadlineAt: deadline,
          state: {
            currentSeat: room.currentSeat,
            currentCards: [],
            passedSeats: [],
            lastPlayedSeat: room.lastPlayedSeat,
            firstLeadPending: true
          },
          rounds: {
            create: {
              roundNo: 1,
              leadSeat: room.currentSeat,
              currentSeat: room.currentSeat,
              publicState: { handCounts: this.handCounts(room), currentCards: [], history: [] }
            }
          }
        },
        include: { rounds: true }
      });

      await tx.gamePrivateState.createMany({
        data: room.players.map((player) => ({
          sessionId: session.id,
          seat: player.seat,
          userId: player.isBot ? null : player.userId,
          isBot: player.isBot,
          cards: room.hands[player.userId] as Prisma.InputJsonValue
        }))
      });
      await tx.gameAction.create({
        data: {
          roundId: session.rounds[0].id,
          actorId: ownerId,
          actorSeat: room.players.find((player) => player.userId === ownerId)?.seat ?? 0,
          type: "START",
          idempotencyKey: `game-start:${session.id}`,
          stateVersion: 0
        }
      });
      return session.id;
    }, { isolationLevel: "Serializable" });
  }

  async persistTransition(transition: Transition): Promise<"committed" | "duplicate" | "conflict"> {
    const { room, expectedVersion } = transition;
    const sessionId = room.activeSessionId;
    if (!sessionId) return "conflict";

    try {
      return await this.prisma.$transaction(async (tx) => {
        const alreadyProcessed = await tx.gameAction.findUnique({
          where: { idempotencyKey: transition.idempotencyKey },
          select: { id: true }
        });
        if (alreadyProcessed) return "duplicate";

        const sessionUpdate = await tx.gameSession.updateMany({
          where: { id: sessionId, status: "PLAYING", version: expectedVersion },
          data: {
            version: { increment: 1 },
            state: {
              currentSeat: room.currentSeat,
              currentCards: room.currentCards,
              passedSeats: room.passedSeats,
              lastPlayedSeat: room.lastPlayedSeat,
              firstLeadPending: room.firstLeadPending
            },
            turnDeadlineAt: transition.finished ? null : room.turnDeadlineAt,
            ...(transition.finished ? { status: "FINISHED", endedAt: new Date() } : {})
          }
        });
        if (sessionUpdate.count !== 1) return "conflict";

        const round = await tx.gameRound.findFirst({
          where: { sessionId, status: "PLAYING" },
          orderBy: { roundNo: "desc" }
        });
        if (!round) throw new Error("Active game round is missing");
        await tx.gameRound.update({
          where: { id: round.id },
          data: {
            currentSeat: room.currentSeat,
            leadSeat: room.lastPlayedSeat,
            publicState: {
              handCounts: this.handCounts(room),
              currentCards: room.currentCards,
              passedSeats: room.passedSeats,
              history: room.publicHistory
            },
            ...(transition.finished ? { status: "FINISHED", endedAt: new Date() } : {})
          }
        });

        for (const player of room.players) {
          await tx.gamePrivateState.update({
            where: { sessionId_seat: { sessionId, seat: player.seat } },
            data: { cards: room.hands[player.userId] as Prisma.InputJsonValue }
          });
        }

        await tx.gameAction.create({
          data: {
            roundId: round.id,
            actorId: transition.actorUserId,
            actorSeat: transition.actorSeat,
            isBot: transition.isBot,
            type: transition.type,
            cards: transition.cards as Prisma.InputJsonValue | undefined,
            idempotencyKey: transition.idempotencyKey,
            stateVersion: expectedVersion + 1,
            publicData: { currentSeat: room.currentSeat, finished: Boolean(transition.finished) }
          }
        });

        if (transition.finished) {
          const winner = room.players.find((player) => player.seat === transition.actorSeat);
          if (!winner) throw new Error("Winning seat is missing");
          for (const player of room.players.filter((candidate) => !candidate.isBot)) {
            await tx.gameResult.upsert({
              where: { sessionId_userId: { sessionId, userId: player.userId } },
              create: {
                sessionId,
                userId: player.userId,
                rank: player.seat === winner.seat ? 1 : 2,
                payout: BigInt(0),
                isWin: player.seat === winner.seat
              },
              update: {}
            });
            await tx.user.update({
              where: { id: player.userId },
              data: {
                gamesPlayed: { increment: 1 },
                gamesWon: player.seat === winner.seat ? { increment: 1 } : undefined
              }
            });
          }
          await tx.gameRoom.updateMany({ where: { id: room.id, status: "PLAYING" }, data: { status: "WAITING" } });
        }
        return "committed";
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const duplicate = await this.prisma.gameAction.findUnique({
          where: { idempotencyKey: transition.idempotencyKey },
          select: { id: true }
        });
        if (duplicate) return "duplicate";
      }
      throw error;
    }
  }

  async restoreRooms(): Promise<PersistedGameRoom[]> {
    const records = await this.prisma.gameRoom.findMany({
      where: { status: { in: ["WAITING", "PLAYING"] } },
      include: {
        players: {
          where: { leftAt: null },
          include: { user: { select: { nickname: true } } },
          orderBy: { seat: "asc" }
        },
        spectators: { where: { leftAt: null }, select: { userId: true } },
        sessions: {
          where: { status: "PLAYING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            privateStates: true,
            rounds: { where: { status: "PLAYING" }, orderBy: { roundNo: "desc" }, take: 1 }
          }
        }
      }
    });

    const restored: PersistedGameRoom[] = [];
    for (const record of records) {
      const session = record.sessions[0];
      const players: PersistedPlayer[] = record.players.map((player) => ({
        userId: player.userId ?? `bot:${record.id}:${player.seat}`,
        seat: player.seat,
        isBot: player.isBot,
        nickname: player.user?.nickname ?? player.botName ?? `Bot ${player.seat + 1}`
      }));
      const invalidPlayerData = record.players.some((player) =>
        player.seat < 0 || player.seat > 3 ||
        (player.userId === null ? !player.isBot : player.isBot)
      );
      const base: PersistedGameRoom = {
        id: record.id,
        code: record.code,
        name: record.name,
        ownerId: record.ownerId,
        entryFee: record.entryFee,
        botEnabled: record.botEnabled,
        status: record.status === "PLAYING" ? "PLAYING" : record.status === "CLOSED" ? "CLOSED" : "WAITING",
        players,
        spectators: record.spectators.map((spectator) => spectator.userId),
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
      };

      if (record.status === "PLAYING") {
        const round = session?.rounds[0];
        const privateStates = session?.privateStates ?? [];
        if (!session || !round || players.length !== 4 || privateStates.length !== 4 || invalidPlayerData) {
          await this.cancelUnrecoverable(record.id, session?.id);
          base.status = "WAITING";
          restored.push(base);
          continue;
        }
        const state = this.asObject(session.state);
        const publicState = this.asObject(round.publicState);
        const currentSeat = state ? this.asSeat(state.currentSeat) : null;
        const lastPlayedSeat = state ? this.asSeat(state.lastPlayedSeat) : null;
        const passedSeats = state ? this.asSeatArray(state.passedSeats) : null;
        const handCounts = publicState ? this.asHandCounts(publicState.handCounts) : null;
        if (!state || !publicState || currentSeat === null || lastPlayedSeat === null ||
          passedSeats === null || typeof state.firstLeadPending !== "boolean" ||
          !handCounts || !session.turnDeadlineAt) {
          await this.cancelUnrecoverable(record.id, session.id);
          base.status = "WAITING";
          restored.push(base);
          continue;
        }
        base.activeSessionId = session.id;
        base.version = session.version;
        base.turnDeadlineAt = session.turnDeadlineAt;
        base.currentSeat = currentSeat;
        base.lastPlayedSeat = lastPlayedSeat;
        base.firstLeadPending = state.firstLeadPending;
        base.passedSeats = passedSeats;
        const currentCards = this.asCards(publicState.currentCards ?? state.currentCards);
        if (!currentCards) {
          await this.cancelUnrecoverable(record.id, session.id);
          base.status = "WAITING";
          base.activeSessionId = null;
          restored.push(base);
          continue;
        }
        base.currentCards = currentCards;
        const history = this.asHistory(publicState.history);
        if (!history) {
          await this.cancelUnrecoverable(record.id, session.id);
          base.status = "WAITING";
          base.activeSessionId = null;
          restored.push(base);
          continue;
        }
        base.publicHistory = history;
        for (const privateState of privateStates) {
          const player = players.find((candidate) => candidate.seat === privateState.seat);
          const cards = this.asCards(privateState.cards);
          if (!player || !cards || cards.length > 13 ||
            handCounts[privateState.seat] !== cards.length) {
            await this.cancelUnrecoverable(record.id, session.id);
            base.status = "WAITING";
            base.activeSessionId = null;
            base.hands = {};
            break;
          }
          base.hands[player.userId] = cards;
        }
      }
      restored.push(base);
    }
    return restored;
  }

  private async cancelUnrecoverable(roomId: string, sessionId?: string) {
    await this.prisma.$transaction(async (tx) => {
      if (sessionId) {
        const session = await tx.gameSession.findUnique({
          where: { id: sessionId },
          select: { state: true }
        });
        const previousState = session ? this.asObject(session.state) : null;
        await tx.gameSession.updateMany({
          where: { id: sessionId, status: "PLAYING" },
          data: {
            status: "CANCELLED",
            endedAt: new Date(),
            turnDeadlineAt: null,
            state: {
              ...(previousState ?? {}),
              recoveryError: "Persisted game state is incomplete or invalid"
            }
          }
        });
      }
      await tx.gameRoom.updateMany({
        where: { id: roomId, status: "PLAYING" },
        data: { status: "WAITING" }
      });
    });
  }

  private asObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, Prisma.JsonValue>
      : null;
  }

  private asSeat(value: Prisma.JsonValue | undefined): number | null {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3 ? value : null;
  }

  private asSeatArray(value: Prisma.JsonValue | undefined): number[] | null {
    if (!Array.isArray(value)) return null;
    const seats = value.map((seat) => this.asSeat(seat));
    return seats.some((seat) => seat === null) || new Set(seats).size !== seats.length
      ? null
      : seats as number[];
  }

  private asHandCounts(value: Prisma.JsonValue | undefined): number[] | null {
    const counts = this.asObject(value ?? null);
    if (!counts) return null;
    const values = [0, 1, 2, 3].map((seat) => counts[String(seat)]);
    return values.every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 13)
      ? values as number[]
      : null;
  }

  private asCards(value: Prisma.JsonValue | undefined): Card[] | null {
    if (!Array.isArray(value)) return null;
    const cards: Card[] = [];
    for (const item of value) {
      if (item === null || typeof item !== "object" || Array.isArray(item) ||
        typeof item.rank !== "number" || !Number.isInteger(item.rank) ||
        item.rank < 3 || item.rank > 15 ||
        !this.isSuit(item.suit)) {
        return null;
      }
      cards.push({ rank: item.rank, suit: item.suit });
    }
    return cards;
  }

  private isSuit(value: Prisma.JsonValue | undefined): value is Suit {
    return value === "SPADES" || value === "CLUBS" || value === "DIAMONDS" || value === "HEARTS";
  }

  private asHistory(value: Prisma.JsonValue | undefined): GameHistoryEntry[] | null {
    if (!Array.isArray(value)) return null;
    const history: GameHistoryEntry[] = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.seat !== "number" || !Number.isInteger(entry.seat) ||
        entry.seat < 0 || entry.seat > 3 ||
        (entry.type !== "PLAY" && entry.type !== "PASS")) return null;
      const cards = entry.cards === undefined ? undefined : this.asCards(entry.cards);
      if (entry.type === "PLAY" && (!cards || !cards.length)) return null;
      if (entry.type === "PASS" && entry.cards !== undefined) return null;
      history.push({ seat: entry.seat, type: entry.type, ...(cards ? { cards } : {}) });
    }
    return history;
  }

  private handCounts(room: PersistedGameRoom) {
    return Object.fromEntries(room.players.map((player) => [player.seat, room.hands[player.userId]?.length ?? 0]));
  }
}
