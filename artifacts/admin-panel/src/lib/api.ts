import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";

export const API_BASE = window.location.origin;
export const ADMIN_TOKEN_KEY = "admin_token";
export const WORKSPACE_TOKEN_KEY = "workspace_token";

export function isWorkspacePath() {
  return window.location.pathname.includes("/workspace");
}

export function getWorkspaceToken() {
  return localStorage.getItem(WORKSPACE_TOKEN_KEY);
}

export function workspaceFetch(path: string, init: RequestInit = {}) {
  const token = getWorkspaceToken();
  return fetch(`${API_BASE}/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export function setupApiClient() {
  setBaseUrl(API_BASE);
  setAuthTokenGetter(() =>
    isWorkspacePath()
      ? localStorage.getItem(WORKSPACE_TOKEN_KEY)
      : localStorage.getItem(ADMIN_TOKEN_KEY),
  );
}
