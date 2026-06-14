import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export async function ensureDatabaseReady(): Promise<void> {
  try {
    await prisma.appSettings.findFirst();
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2021"
    ) {
      console.error(
        "\n[Database] Required tables are missing (e.g. AppSettings).\n" +
          "Initialize the schema from the backend folder:\n\n" +
          "  npm run db:setup\n\n" +
          "Or manually:\n" +
          "  npm run db:push\n" +
          "  npm run db:seed\n"
      );
      process.exit(1);
    }
    throw err;
  }
}
