export type ContainerRole = "api" | "worker" | "migrate";
/** Deployment-owned fixed paths only; never accepts application/tenant paths. */
export function loadSecretFiles(
  role: ContainerRole,
  environment: Record<string, string | undefined>,
  read: (path: string) => string,
) {
  const result = { ...environment };
  const password =
    role === "api"
      ? "db-api-password"
      : role === "worker"
        ? "db-worker-password"
        : "db-owner-password";
  const allowed: Record<string, string> = {
    PGPASSWORD: `/run/secrets/${password}`,
    ...(role === "api"
      ? {
          JWT_SECRET: "/run/secrets/jwt-signing-key",
          IDENTITY_ENCRYPTION_KEY: "/run/secrets/identity-key",
        }
      : {}),
  };
  if (
    role !== "api" &&
    [
      "JWT_SECRET",
      "JWT_SECRET_FILE",
      "IDENTITY_ENCRYPTION_KEY",
      "IDENTITY_ENCRYPTION_KEY_FILE",
    ].some((key) => result[key] !== undefined)
  )
    throw new Error(
      "Signing/identity keys are forbidden for this container role",
    );
  for (const [name, path] of Object.entries(allowed)) {
    const selected = result[name + "_FILE"];
    if (selected === undefined) continue;
    if (selected !== path || result[name] !== undefined)
      throw new Error("Invalid or ambiguous secret source");
    const value = read(path).replace(/\r?\n$/, "");
    if (!value) throw new Error("Secret unavailable");
    result[name] = value;
    delete result[name + "_FILE"];
  }
  return result;
}
