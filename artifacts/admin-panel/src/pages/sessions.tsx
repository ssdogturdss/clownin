import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MessageSquare, CheckCircle, XCircle, Loader2, CheckCircle2 } from "lucide-react";

interface SessionNameCoverage {
  total: number;
  named: number;
  unnamed: number;
}

interface UnnamedSession {
  sessionId: string | null;
  projectId: number | null;
  projectName: string | null;
  createdAt: string | null;
}

interface UnnamedSessionsResult {
  sessions: UnnamedSession[];
  limit: number;
}

const API_ORIGIN = window.location.origin;

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("admin_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchSessionNameCoverage(): Promise<SessionNameCoverage> {
  const res = await fetch(`${API_ORIGIN}/api/admin/session-name-coverage`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

async function fetchUnnamedSessions(): Promise<UnnamedSessionsResult> {
  const res = await fetch(`${API_ORIGIN}/api/admin/unnamed-sessions?limit=50`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function useSessionNameCoverage() {
  return useQuery<SessionNameCoverage>({
    queryKey: ["admin", "session-name-coverage"],
    queryFn: fetchSessionNameCoverage,
  });
}

function useUnnamedSessions(enabled: boolean) {
  return useQuery<UnnamedSessionsResult>({
    queryKey: ["admin", "unnamed-sessions"],
    queryFn: fetchUnnamedSessions,
    enabled,
  });
}

export default function SessionsPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch, isFetching } =
    useSessionNameCoverage();

  const hasUnnamed = (data?.unnamed ?? 0) > 0;
  const {
    data: unnamedData,
    isLoading: isLoadingUnnamed,
  } = useUnnamedSessions(!!data && hasUnnamed);

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertDescription>Failed to load session name coverage data.</AlertDescription>
      </Alert>
    );
  }

  const coveragePct =
    data && data.total > 0
      ? Math.round((data.named / data.total) * 100)
      : data?.total === 0
      ? 100
      : 0;

  const updatedAt = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Sessions</h1>
          <p className="text-muted-foreground mt-2">
            Session name coverage — confirms the backfill migration ran correctly.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          data-testid="btn-refresh-coverage"
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {updatedAt && (
        <p className="text-xs text-muted-foreground" data-testid="text-updated-at">
          Last checked at {updatedAt}
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
        <Card data-testid="card-total-sessions">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Sessions
            </CardTitle>
            <MessageSquare className="h-5 w-5 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold" data-testid="text-total-count">
              {data?.total.toLocaleString() ?? "—"}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-named-sessions">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Named Sessions
            </CardTitle>
            <CheckCircle className="h-5 w-5 text-green-500" />
          </CardHeader>
          <CardContent>
            <div
              className="text-4xl font-bold text-green-500"
              data-testid="text-named-count"
            >
              {data?.named.toLocaleString() ?? "—"}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-unnamed-sessions">
          <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Unnamed Sessions
            </CardTitle>
            <XCircle
              className={`h-5 w-5 ${
                (data?.unnamed ?? 0) > 0 ? "text-red-500" : "text-muted-foreground"
              }`}
            />
          </CardHeader>
          <CardContent>
            <div
              className={`text-4xl font-bold ${
                (data?.unnamed ?? 0) > 0 ? "text-red-500" : ""
              }`}
              data-testid="text-unnamed-count"
            >
              {data?.unnamed.toLocaleString() ?? "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="card-coverage-bar">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Coverage
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-foreground font-medium">
              {coveragePct}% of sessions have a name
            </span>
            {(data?.unnamed ?? 0) === 0 ? (
              <span className="text-green-500 text-xs font-medium">
                ✓ Backfill complete
              </span>
            ) : (
              <span className="text-red-500 text-xs font-medium">
                ⚠ {data?.unnamed.toLocaleString()} sessions missing names
              </span>
            )}
          </div>
          <div className="w-full bg-muted rounded-full h-3 overflow-hidden">
            <div
              className={`h-3 rounded-full transition-all ${
                coveragePct === 100
                  ? "bg-green-500"
                  : coveragePct >= 90
                  ? "bg-yellow-500"
                  : "bg-red-500"
              }`}
              style={{ width: `${coveragePct}%` }}
              data-testid="coverage-bar-fill"
            />
          </div>
        </CardContent>
      </Card>

      {/* Unnamed sessions detail table */}
      <Card data-testid="card-unnamed-sessions-table">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Unnamed Sessions
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasUnnamed ? (
            <div
              className="flex flex-col items-center gap-2 py-8 text-center"
              data-testid="empty-state-unnamed"
            >
              <CheckCircle2 className="h-8 w-8 text-green-500" />
              <p className="text-sm font-medium text-foreground">No unnamed sessions</p>
              <p className="text-xs text-muted-foreground">
                All eligible sessions have a name — the backfill migration ran successfully.
              </p>
            </div>
          ) : isLoadingUnnamed ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {(unnamedData?.sessions.length ?? 0) > 0 ? (
                <div className="overflow-x-auto" data-testid="table-unnamed-sessions">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="pb-2 pr-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Session ID
                        </th>
                        <th className="pb-2 pr-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Project
                        </th>
                        <th className="pb-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          Created
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {unnamedData!.sessions.map((s) => (
                        <tr key={s.sessionId ?? "unknown"} className="hover:bg-muted/50">
                          <td className="py-2 pr-4 font-mono text-xs text-foreground">
                            {s.sessionId ?? "—"}
                          </td>
                          <td className="py-2 pr-4 text-xs text-foreground">
                            {s.projectName ? (
                              <>
                                <span>{s.projectName}</span>
                                <span className="ml-1 text-muted-foreground">
                                  #{s.projectId}
                                </span>
                              </>
                            ) : s.projectId != null ? (
                              <span className="text-muted-foreground">#{s.projectId}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground">
                            {s.createdAt
                              ? new Date(s.createdAt).toLocaleString()
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(data?.unnamed ?? 0) > (unnamedData?.limit ?? 50) && (
                    <p className="mt-3 text-xs text-muted-foreground" data-testid="text-truncation-notice">
                      Showing first {unnamedData?.limit ?? 50} of{" "}
                      {data?.unnamed.toLocaleString()} unnamed sessions.
                    </p>
                  )}
                </div>
              ) : (
                <p className="py-4 text-sm text-muted-foreground">No rows returned.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-api-hint">
        <CardHeader>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Programmatic check
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">
            Run this after each deploy to confirm the backfill migration applied correctly:
          </p>
          <pre
            className="bg-muted rounded-md px-4 py-3 text-xs font-mono overflow-x-auto"
            data-testid="code-curl-example"
          >{`curl -H "Authorization: Bearer <token>" \\
  https://<host>/api/admin/session-name-coverage`}</pre>
          <p className="text-xs text-muted-foreground mt-2">
            Returns{" "}
            <code className="bg-muted px-1 rounded">{"{ total, named, unnamed }"}</code>.
            An <code className="bg-muted px-1 rounded">unnamed</code> value greater than 0
            means the migration did not fully apply. Use{" "}
            <code className="bg-muted px-1 rounded">/api/admin/unnamed-sessions</code> to
            list the specific sessions (up to 50 rows).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
