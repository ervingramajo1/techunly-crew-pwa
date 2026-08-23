const TOKEN_KEY = 'techunly_crew_token';
const SESSION_KEY = 'techunly_crew_session';
const BOOTSTRAP_CACHE_KEY = 'techunly_crew_bootstrap_cache';

export type CrewBootstrapCache<T> = {
  bootstrap: T;
  syncedAt: string;
};

export function saveCrewToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getCrewToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function clearCrewToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(BOOTSTRAP_CACHE_KEY);
}

export function saveCrewSession<T>(session: T): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getCrewSession<T>(): T | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveCrewBootstrapCache<T>(bootstrap: T, syncedAt = new Date().toISOString()): CrewBootstrapCache<T> {
  const cache = { bootstrap, syncedAt };
  localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify(cache));
  return cache;
}

export function getCrewBootstrapCache<T>(): CrewBootstrapCache<T> | null {
  const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CrewBootstrapCache<T>;
    if (!parsed || typeof parsed !== 'object' || !parsed.bootstrap) return null;
    return parsed;
  } catch {
    return null;
  }
}
