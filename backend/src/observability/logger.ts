type Fields = Partial<
  Record<
    | "requestId"
    | "method"
    | "route"
    | "status"
    | "durationMs"
    | "code"
    | "mode"
    | "result",
    string | number
  >
>;
export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Fields = {},
) {
  const allowed = [
    "requestId",
    "method",
    "route",
    "status",
    "durationMs",
    "code",
    "mode",
    "result",
  ] as const;
  const safe: Fields = {};
  for (const key of allowed)
    if (fields[key] !== undefined) safe[key] = fields[key];
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), level, event, ...safe }) +
      "\n",
  );
}
