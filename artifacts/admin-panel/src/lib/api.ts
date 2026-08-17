import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";

export const API_BASE = window.location.origin;

export function setupApiClient() {
  setBaseUrl(API_BASE);
  setAuthTokenGetter(() => localStorage.getItem("admin_token") || null);
}
