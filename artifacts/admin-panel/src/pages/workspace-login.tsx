import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Code2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { API_BASE, WORKSPACE_TOKEN_KEY } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function WorkspaceLogin() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.token) {
        throw new Error(body.error ?? "Check your email and password, then try again.");
      }
      localStorage.setItem(WORKSPACE_TOKEN_KEY, body.token);
      toast.success("Signed in to your workspace");
      setLocation("/workspace");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to sign in");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10 flex items-center justify-center">
      <Card className="w-full max-w-md border-border bg-card shadow-xl">
        <CardHeader className="space-y-3 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Code2 className="size-6" />
          </div>
          <div>
            <CardTitle className="text-2xl">Open your workspace</CardTitle>
            <CardDescription className="mt-2">
              Write, run, preview, and deploy your projects from any browser.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="workspace-email">Email</Label>
              <Input
                id="workspace-email"
                data-testid="input-workspace-email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="workspace-password">Password</Label>
              <Input
                id="workspace-password"
                data-testid="input-workspace-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            <Button className="w-full" type="submit" disabled={isLoading} data-testid="button-workspace-login">
              {isLoading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Code2 className="mr-2 size-4" />}
              {isLoading ? "Signing in…" : "Continue to workspace"}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Admin? <Link href="/login" className="text-primary hover:underline">Open the admin portal</Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}