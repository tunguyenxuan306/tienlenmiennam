import bcrypt from "bcryptjs";
import { PrismaClient, UserRole, AccountStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME ?? "admin";
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error("ADMIN_PASSWORD is required to bootstrap the administrator");
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.warn("Bootstrap admin already exists; seed made no password changes.");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username,
        nickname: "Administrator",
        passwordHash,
        role: UserRole.ADMIN,
        status: AccountStatus.ACTIVE,
        mustChangePassword: true
      }
    });
    await tx.wallet.create({ data: { userId: user.id, balance: BigInt(0) } });
  });

  console.log("Bootstrap admin created. Change the default password immediately.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
