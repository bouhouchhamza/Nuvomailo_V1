import "dotenv/config";
import pg from "pg";
import { env } from "./env.js";

const { Pool } = pg;

if (!process.env.PGPASSWORD) {
  throw new Error("PGPASSWORD is missing");
}

const pool = new Pool({
  host: env.PGHOST,
  port: env.PGPORT,
  user: env.PGUSER,
  password: env.PGPASSWORD,
  database: env.PGDATABASE,

  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,
  idle_in_transaction_session_timeout: 10000,
});

export default pool;
