import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createApi, ApiError, type Api } from "./api";
import type { LoginResponse, User } from "./types";
interface Auth {
  user: User | null;
  api: Api;
  signIn: (data: LoginResponse) => void;
  signOut: () => void;
  endSession: () => void;
  expired: boolean;
  booting: boolean;
}
const Context = createContext<Auth | null>(null);
let pendingRefresh: Promise<LoginResponse> | null = null;
// One refresh per tab; Web Locks serialize browser tabs when available.
function refreshCookie(): Promise<LoginResponse> {
  if (!pendingRefresh) {
    const fetchSession = () =>
      createApi()<LoginResponse>("/auth/refresh", "POST");
    pendingRefresh = Promise.resolve(
      navigator.locks
        ? navigator.locks.request("nuvomailo-session-refresh", fetchSession)
        : fetchSession(),
    ).finally(() => {
      pendingRefresh = null;
    });
  }
  return pendingRefresh!;
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<LoginResponse | null>(null);
  const [expired, setExpired] = useState(false),
    [booting, setBooting] = useState(true),
    [error, setError] = useState("");
  const current = useRef<LoginResponse | null>(null),
    generation = useRef(0);
  const signIn = useCallback((data: LoginResponse) => {
    generation.current++;
    current.current = data;
    setSession(data);
    setExpired(false);
    setError("");
  }, []);
  const expire = useCallback(() => {
    generation.current++;
    current.current = null;
    setSession(null);
    setExpired(true);
  }, []);
  const renew = useCallback(async (failedToken?: string) => {
    if (
      failedToken &&
      current.current &&
      current.current.accessToken !== failedToken
    )
      return current.current.accessToken;
    const epoch = generation.current;
    const data = await refreshCookie();
    if (epoch !== generation.current)
      throw new ApiError(401, "Session changed");
    current.current = data;
    setSession(data);
    setExpired(false);
    return data.accessToken;
  }, []);
  const api = useMemo(
    () => createApi(session?.accessToken, expire, renew),
    [session?.accessToken, expire, renew],
  );
  const signOut = useCallback(() => {
    void (async () => {
      if (pendingRefresh) {
        try {
          await renew();
        } catch {
          /* Logout still attempts server revocation. */
        }
      }
      await createApi(
        current.current?.accessToken,
        undefined,
        renew,
      )("/auth/logout", "POST");
      generation.current++;
      current.current = null;
      setSession(null);
      setExpired(false);
      setError("");
    })().catch(() =>
      setError("Could not revoke your session. Try signing out again."),
    );
  }, [renew]);
  useEffect(() => {
    let active = true;
    void refreshCookie()
      .then((data) => {
        if (active) signIn(data);
      })
      .catch((e) => {
        if (active && (!(e instanceof ApiError) || e.status !== 401))
          setError("Could not restore your session. You can sign in again.");
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, [signIn]);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(
      () => {
        void renew().catch(expire);
      },
      Math.max(1000, (session.expiresIn - 60) * 1000),
    );
    return () => clearTimeout(timer);
  }, [session, renew, expire]);
  return (
    <Context.Provider
      value={{
        user: session?.user ?? null,
        api,
        signIn,
        signOut,
        endSession: expire,
        expired,
        booting,
      }}
    >
      {error && <p role="alert">{error}</p>}
      {children}
    </Context.Provider>
  );
}
export function useAuth() {
  const auth = useContext(Context);
  if (!auth) throw new Error("Missing AuthProvider");
  return auth;
}
