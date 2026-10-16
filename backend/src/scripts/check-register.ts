import argon2 from "argon2";
import { registerUser } from "../services/auth.service.js";
import pool from "../config/database.js";

async function main() {
  const email = `test-${Date.now()}@example.com`;
  const password = "TestPassword123!";

  try {
    // Test 1: Successful registration
    const user = await registerUser({ email, password });

    console.log("✅ User created:", {
      id: user.id,
      email: user.email,
    });

    // Test 2: Password stored as hash
    const result = await pool.query<{ password_hash: string }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [user.id]
    );

    const hash = result.rows[0]?.password_hash;

    if (!hash) {
      throw new Error("Password hash not found");
    }

    const verified = await argon2.verify(hash, password);

    console.log(
      verified && hash !== password
        ? "✅ Password hashing verified"
        : "❌ Password hashing failed"
    );

    // Test 3: Duplicate email
    try {
      await registerUser({ email, password });
      console.log("❌ Duplicate email was accepted");
    } catch {
      console.log("✅ Duplicate email rejected");
    }

    // Test 4: Invalid password
    try {
      await registerUser({
        email: "invalid@example.com",
        password: "123",
      });

      console.log("❌ Invalid password was accepted");
    } catch {
      console.log("✅ Invalid password rejected");
    }
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();