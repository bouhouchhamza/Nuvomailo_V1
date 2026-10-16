
import pool from "../config/database.js";
import type { User } from "../models/user.model.js";

export async function findUserByEmail(email: string) {
  const result = await pool.query<User & { password_hash: string }>('SELECT id, email, created_at, password_hash FROM users WHERE LOWER(email) = $1', [email]);
  return result.rows[0];
}
export async function findUserById(id: string) {
  const result = await pool.query<User>('SELECT id, email, created_at FROM users WHERE id = $1', [id]);
  return result.rows[0];
}

export async function createUser(
  email: string,
  passwordHash: string
): Promise<User> {
  const result = await pool.query<User>(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at`,
    [email, passwordHash]
  );

  const user = result.rows[0];

  if (!user) {
    throw new Error("User creation failed");
  }

  return user;
}
