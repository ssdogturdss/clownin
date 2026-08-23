// Auth is disabled — all routes are open, no login required.
export function RequireAuth({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function RequireWorkspaceAuth({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
