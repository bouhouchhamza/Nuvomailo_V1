
import "dotenv/config";

export default {
  "database-url-var": {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE
  },
  "migrations-dir": "migrations"
};
