import { useEffect } from "react";
import { useLocation } from "wouter";
import { ADMIN_TOKEN_KEY, WORKSPACE_TOKEN_KEY } from "@/lib/api";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const token = localStorage.getItem(ADMIN_TOKEN_KEY);

  useEffect(() => {
    if (!token && location !== "/login") {
      setLocation("/login");
    }
  }, [token, location, setLocation]);

  if (!token) return null;

  return <>{children}</>;
}

export function RequireWorkspaceAuth({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const token = localStorage.getItem(WORKSPACE_TOKEN_KEY);

  useEffect(() => {
    if (!token && location !== "/workspace/login") {
      setLocation("/workspace/login");
    }
  }, [token, location, setLocation]);

  if (!token) return null;
  return <>{children}</>;
}
