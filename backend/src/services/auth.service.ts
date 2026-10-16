import argon2 from "argon2";
import { z } from "zod";
import { createUser } from "../repositories/user.repository.js";
import type { User } from "../models/user.model.js";
import {
  findUserByEmail,
  findUserById,
} from "../repositories/user.repository.js";
import { HttpError } from "../middlewares/errors.js";
import { createSession } from "./session.service.js";

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(128),
});
export async function registerUser(input: unknown): Promise<User> {
  try {
    const { email, password } = registerSchema.parse(input);

    const hashed = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const user = await createUser(email, hashed);

    return user;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new HttpError(409, "This email is already registered");
    }
    throw error;
  }
}

const dummyHash = argon2.hash("unused-constant-timing-password", {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
});
export async function loginUser(input: unknown,mfaKey?:Buffer) {
  const { email, password,factor } = registerSchema
    .extend({ password: z.string().min(1).max(128),factor:z.string().max(128).optional() }).strict()
    .parse(input);
  const user = await findUserByEmail(email);
  const valid = await argon2.verify(
    user?.password_hash ?? (await dummyHash),
    password,
  );
  if (!user || !valid) throw new HttpError(401, "Invalid email or password");
  return createSession(user.id,user.password_hash,factor,mfaKey);
}
export async function currentUser(id: string) {
  const user = await findUserById(id);
  if (!user) throw new HttpError(401, "Account no longer exists");
  return user;
}
