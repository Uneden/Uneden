import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const { Pool } = pg;

// Supabase (prod) requires TLS. Local Postgres (`supabase start`) has none:
// set DATABASE_SSL=false to connect without it.
const ssl = process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});

pool.on("error", (err) => {
  console.error("[pg pool] Idle client error:", err.message);
});

export default pool;
