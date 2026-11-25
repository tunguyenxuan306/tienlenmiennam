import { Prisma, PrismaClient, TransactionType } from "@prisma/client";

export type WalletTransactionInput = {
  walletId: string;
  amount: bigint;
  type: TransactionType;
  reason: string;
  source: string;
  idempotencyKey: string;
  actorUserId?: string;
  targetUserId?: string;
};

export async function applyWalletTransaction(
  tx: Prisma.TransactionClient,
  input: WalletTransactionInput
) {
  if (input.amount === BigInt(0)) throw new Error("Transaction amount must not be zero");

  const existing = await tx.transaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey }
  });
  if (existing) {
    const sameRequest =
      existing.walletId === input.walletId &&
      existing.amount === input.amount &&
      existing.type === input.type &&
      existing.reason === input.reason &&
      existing.source === input.source &&
      existing.actorUserId === (input.actorUserId ?? null) &&
      existing.targetUserId === (input.targetUserId ?? null);
    if (!sameRequest) throw new Error("Idempotency key was already used for a different transaction");
    return existing;
  }

  const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet) throw new Error("Wallet not found");
  const balanceAfter = wallet.balance + input.amount;
  if (balanceAfter < BigInt(0)) throw new Error("Insufficient funds");

  const updated = await tx.wallet.updateMany({
    where: { id: wallet.id, balance: wallet.balance },
    data: { balance: balanceAfter }
  });
  if (updated.count !== 1) throw new Error("Wallet balance changed; retry the request");

  return tx.transaction.create({
    data: {
      walletId: wallet.id,
      targetUserId: input.targetUserId,
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      type: input.type,
      amount: input.amount,
      balanceBefore: wallet.balance,
      balanceAfter,
      reason: input.reason,
      source: input.source
    }
  });
}

export async function addWalletTransaction(
  prisma: PrismaClient,
  input: {
    walletId: string;
    amount: bigint;
    type: TransactionType;
    reason: string;
    source: string;
    idempotencyKey: string;
    actorUserId?: string;
    targetUserId?: string;
  }
) {
  return prisma.$transaction(async (tx) => {
    return applyWalletTransaction(tx, input);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
