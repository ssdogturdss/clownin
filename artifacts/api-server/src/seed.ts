import { seedDemoData } from "./lib/seed";
import { logger } from "./lib/logger";

async function main(): Promise<void> {
  await seedDemoData();
  logger.info("Demo data seed completed");
}

main().catch((error: unknown) => {
  logger.error({ error }, "Demo data seed failed");
  process.exitCode = 1;
});