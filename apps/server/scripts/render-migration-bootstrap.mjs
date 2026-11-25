import { PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const initialMigration = "20261126000000_initial";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function shouldResolveFailedMigration(rows) {
  if (rows.some((row) => row.finished_at !== null)) {
    return false;
  }

  const unresolved = rows.filter(
    (row) => row.finished_at === null && row.rolled_back_at === null
  );
  if (unresolved.length === 0) {
    return false;
  }

  if (unresolved.length !== 1 || unresolved[0].logs === null) {
    throw new Error(
      `Refusing to resolve ${initialMigration}: its migration state is ambiguous or has no recorded failure.`
    );
  }

  const failureLog = unresolved[0].logs;
  if (typeof failureLog !== "string") {
    throw new Error(
      `Refusing to resolve ${initialMigration}: the recorded failure log is not text.`
    );
  }

  const containsBom = failureLog.includes("\uFEFF") || /\\uFEFF/i.test(failureLog);
  if (
    !failureLog.includes("syntax error at or near") ||
    !/Position:\s*1\b/.test(failureLog) ||
    !containsBom
  ) {
    throw new Error(
      `Refusing to resolve ${initialMigration}: the recorded failure does not match the known BOM syntax error at position 1.`
    );
  }

  return true;
}

async function checkFailedInitialMigration() {
  const prisma = new PrismaClient();

  try {
    const [table] = await prisma.$queryRaw`
      SELECT to_regclass('public."_prisma_migrations"')::text AS "tableName"
    `;
    if (!table.tableName) {
      console.log("Prisma migration history table does not exist; skipping resolve.");
      return false;
    }

    const rows = await prisma.$queryRaw`
      SELECT "finished_at", "rolled_back_at", "logs"
      FROM public."_prisma_migrations"
      WHERE "migration_name" = ${initialMigration}
      ORDER BY "started_at" DESC
    `;

    if (!shouldResolveFailedMigration(rows)) {
      console.log(`${initialMigration} is not in a failed state; skipping resolve.`);
      return false;
    }

    return true;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (!(await checkFailedInitialMigration())) {
    return;
  }

  console.log(`Marking failed migration ${initialMigration} as rolled back.`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    [
      "exec",
      "--",
      "prisma",
      "migrate",
      "resolve",
      "--rolled-back",
      initialMigration
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32"
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Prisma migrate resolve exited with status ${result.status}.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
