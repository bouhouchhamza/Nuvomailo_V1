export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function createApi(
  token?: string,
  onUnauthorized?: () => void,
  renew?: (failedToken: string) => Promise<string>,
) {
  return async function api<T>(
    path: string,
    method = "GET",
    body?: unknown,
    format: "json" | "blob" = "json",
  ): Promise<T> {
    const options = (accessToken?: string): RequestInit => ({
      method,
      credentials: "same-origin",
      headers: {
        ...(method !== "GET" ? { "X-Nuvomailo-CSRF": "1" } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    let response = await fetch(`/api${path}`, options(token));
    if (response.status === 401 && token && renew) {
      try {
        response = await fetch(`/api${path}`, options(await renew(token)));
      } catch {
        onUnauthorized?.();
        throw new ApiError(401, "Your session expired. Please sign in again.");
      }
    }
    if (response.ok && format === "blob") return (await response.blob()) as T;
    const data =
      response.status === 204
        ? undefined
        : await response
            .json()
            .catch(() => ({ error: "Invalid server response" }));
    if (!response.ok) {
      if (response.status === 401 && token) onUnauthorized?.();
      const issues = data?.issues as { message: string }[] | undefined;
      throw new ApiError(
        response.status,
        issues?.map((i) => i.message).join("; ") ||
          data?.error ||
          "Request failed",
      );
    }
    return data as T;
  };
}
export type Api = ReturnType<typeof createApi>;
