import pool from "../config/database.js";
import { findOrganizationBySlug } from "../repositories/organization.repository.js";
import { getOrganizationBySlug } from "../services/organization.service.js";
try {
  const organization = await getOrganizationBySlug("demo");
  console.log("Organization:", organization);
} catch (error) {
  console.error("Repository test failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}