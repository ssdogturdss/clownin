import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to wait for PostgreSQL.");
}

const maxAttempts = 45;

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 2_000,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    console.log("PostgreSQL is ready.");
    process.exit(0);
  } catch (error) {
    await client.end().catch(() => {});
    if (attempt === maxAttempts) {
      throw new Error(`PostgreSQL was unavailable after ${maxAttempts} attempts: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`Waiting for PostgreSQL (${attempt}/${maxAttempts})...`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}