
import pool from "../config/database.js";

import {
  createOrganizationWithOwner,
  findOrganizationBySlug
} from "../repositories/organization.repository.js";

const slug = `rollback-test-${Date.now()}`;

// UUID syntax صحيحة، ولكن ما عندناش User بهاد ID
const fakeOwnerId = "00000000-0000-0000-0000-000000000000";

try {
  try {
    await createOrganizationWithOwner(
      "Rollback Test",
      slug,
      fakeOwnerId
    );

    throw new Error("Test failed: expected a foreign key error");
  } catch (error) {
    const pgError = error as { code?: string };

    if (pgError.code !== "23503") {
      throw error;
    }

    console.log("Foreign key rejected as expected");
  }

  const organization = await findOrganizationBySlug(slug);

  if (organization !== null) {
    throw new Error("Test failed: rollback did not remove organization");
  }

  console.log("ROLLBACK successful: organization was not saved");
} catch (error) {
  console.error("Transaction test failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
