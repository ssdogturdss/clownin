import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MessageSquare, CheckCircle, XCircle, Loader2 } from "lucide-react";

interface SessionNameCoverage {
  total: number;
  named: number;
  unnamed: number;
}

async function fetchSessionNameCoverage(): Promise<SessionNameCoverage> {
  const token = localStorage.getItem("admin_token");
  const res = await fetch(
    `${window.location.origin}/api/admin/session-name-coverage`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }
  );
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`);
  }
  return res.json();
}

function useSessionNameCoverage() {
  return useQuery<SessionNameCoverage>({
    queryKey: ["admin", "session-name-coverage"],
    queryFn: fetchSessionNameCoverage,
  });
}

export default function SessionsPage() {
  const { data, isLoading, error, dataUpdatedAt, refetch, isFetching } =
    useSessionNameCoverage();

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
            means the migration did not fully apply.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
