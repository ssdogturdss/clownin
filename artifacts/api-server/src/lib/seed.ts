import { db, usersTable, projectsTable, projectFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { logger } from "./logger";

/**
 * Find or create the system user (ss@clownin.dev) and return their DB ID.
 *
 * The system user's password is sourced exclusively from the STUDIO_MASTER_KEY
 * environment secret — never hardcoded.  On every startup, if STUDIO_MASTER_KEY
 * is set, the password hash is re-synced so rotating the key takes effect
 * immediately without a manual DB update.
 *
 */
export async function ensureSystemUser(): Promise<number> {
  const masterKey = process.env.STUDIO_MASTER_KEY;
  if (!masterKey) {
    logger.warn(
      "STUDIO_MASTER_KEY is not set — system user cannot be authenticated. " +
      "Set STUDIO_MASTER_KEY in your deployment secret manager before first use.",
    );
  }

  const existing = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, "ss@clownin.dev"))
    .limit(1);

  if (existing.length > 0) {
    if (masterKey) {
      // Sync the password hash with the current STUDIO_MASTER_KEY value so
      // key rotation takes effect on the next server restart.
      const passwordHash = await bcrypt.hash(masterKey, 10);
      await db
        .update(usersTable)
        .set({ passwordHash })
        .where(eq(usersTable.id, existing[0].id));
      logger.info({ userId: existing[0].id }, "System user password synced with STUDIO_MASTER_KEY");
    }
    return existing[0].id;
  }

  if (!masterKey) {
    throw new Error(
      "Cannot create system user: STUDIO_MASTER_KEY is not set. " +
      "Add it to your deployment environment and restart the server.",
    );
  }

  const passwordHash = await bcrypt.hash(masterKey, 10);
  const [user] = await db
    .insert(usersTable)
    .values({ username: "admin", email: "ss@clownin.dev", passwordHash })
    .returning({ id: usersTable.id });

  logger.info({ userId: user.id }, "System user created");
  return user.id;
}

export async function seedDemoData(): Promise<void> {
  const demoPassword = process.env.DEMO_USER_PASSWORD;
  if (!demoPassword) {
    throw new Error(
      "DEMO_USER_PASSWORD is required when seeding demo data. " +
      "Set a unique temporary password in the shell that runs the seed command.",
    );
  }

  // Check if demo user already exists
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, "demo@clownin.dev"))
    .limit(1);

  if (existing.length > 0) {
    logger.info("Seed data already exists, skipping");
    return;
  }

  logger.info("Seeding demo data...");

  const passwordHash = await bcrypt.hash(demoPassword, 10);
  const [user] = await db
    .insert(usersTable)
    .values({
      username: "clownin_demo",
      email: "demo@clownin.dev",
      passwordHash,
    })
    .returning();

  // Project 1: Hello World JS
  const [jsProject] = await db
    .insert(projectsTable)
    .values({
      userId: user.id,
      name: "Hello Clownin",
      language: "javascript",
      description: "A simple Hello World project",
    })
    .returning();

  await db.insert(projectFilesTable).values([
    {
      projectId: jsProject.id,
      path: "index.js",
      language: "javascript",
      content: `// Welcome to Clownin! 🤡
// The coding playground that never takes itself too seriously.

function greet(name) {
  return \`Hello, \${name}! Welcome to Clownin! 🤡\`;
}

const names = ["World", "Clownin", "Coder"];
names.forEach((name) => {
  console.log(greet(name));
});

console.log("\\nReady to code? Let's go! 🎪");
`,
    },
    {
      projectId: jsProject.id,
      path: "utils.js",
      language: "javascript",
      content: `// Utility functions

export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
`,
    },
  ]);

  // Project 2: Python
  const [pyProject] = await db
    .insert(projectsTable)
    .values({
      userId: user.id,
      name: "Python Playground",
      language: "python",
      description: "Python experiments",
    })
    .returning();

  await db.insert(projectFilesTable).values([
    {
      projectId: pyProject.id,
      path: "main.py",
      language: "python",
      content: `# Welcome to Clownin Python! 🤡

def greet(name: str) -> str:
    return f"Hello, {name}! Welcome to Clownin! 🤡"

names = ["World", "Python", "Clownin"]
for name in names:
    print(greet(name))

# Let's do some math
numbers = list(range(1, 11))
total = sum(numbers)
print(f"\\nSum of 1-10: {total}")
print(f"Average: {total / len(numbers)}")
`,
    },
  ]);

  logger.info({ userId: user.id }, "Demo data seeded successfully");
  logger.info("Demo account created for demo@clownin.dev");
}
