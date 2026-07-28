import { db, usersTable, projectsTable, projectFilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { logger } from "./logger";

export async function seedDemoData(): Promise<void> {
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

  const passwordHash = await bcrypt.hash("demo1234", 10);
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
  logger.info("Demo login: demo@clownin.dev / demo1234");
}
