import { useEffect } from "react";
import { useLocation } from "wouter";

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const token = localStorage.getItem("admin_token");

  useEffect(() => {
    if (!token && location !== "/login") {
      setLocation("/login");
    }
  }, [token, location, setLocation]);

  if (!token) return null;

  return <>{children}</>;
}
