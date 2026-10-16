import pool from "../config/database.js";
import { findOrganizationBySlug } from "../repositories/organization.repository.js";

try {
  const organization = await findOrganizationBySlug("demo");

  console.log("Organization:", organization);
} catch (error) {
  console.error("Repository test failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}