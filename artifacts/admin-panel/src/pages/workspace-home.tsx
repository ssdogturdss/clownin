import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowRight, Code2, FolderPlus, Loader2, LogOut, Plus } from "lucide-react";
import { toast } from "sonner";
import { WORKSPACE_TOKEN_KEY, workspaceFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ProjectSummary = { id: number; name: string; language: string; description?: string | null; updatedAt?: string };

async function readJson<T>(response: Response | Promise<Response>): Promise<T> {
  const resolved = await response;
  const body = await resolved.json().catch(() => ({}));
  if (!resolved.ok) throw new Error((body as { error?: string }).error ?? "Request failed");
  return body as T;
}

export default function WorkspaceHome() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("javascript");

  const projectsQuery = useQuery({
    queryKey: ["workspace-projects"],
    queryFn: () => readJson<ProjectSummary[]>(workspaceFetch("/projects")),
  });

  const createProject = useMutation({
    mutationFn: () => readJson<ProjectSummary>(workspaceFetch("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), language }),
    })),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["workspace-projects"] });
      setOpen(false);
      setName("");
      toast.success("Project created");
      setLocation(`/workspace/${project.id}`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not create project"),
  });

  function signOut() {
    localStorage.removeItem(WORKSPACE_TOKEN_KEY);
    setLocation("/workspace/login");
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/70 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/workspace" className="flex items-center gap-2 font-semibold text-foreground">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary"><Code2 className="size-4" /></span>
            Clownin Workspace
          </Link>
          <div className="flex items-center gap-2">
            <NewProjectDialog
              open={open}
              onOpenChange={setOpen}
              name={name}
              onNameChange={setName}
              language={language}
              onLanguageChange={setLanguage}
              isCreating={createProject.isPending}
              onCreate={() => createProject.mutate()}
            />
            <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out" title="Sign out">
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-primary">Your projects</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Build from anywhere.</h1>
            <p className="mt-2 max-w-xl text-muted-foreground">Open a project to edit code, run it in a terminal, preview a server, and ship it when you are ready.</p>
          </div>
          <NewProjectDialog
            open={open}
            onOpenChange={setOpen}
            name={name}
            onNameChange={setName}
            language={language}
            onLanguageChange={setLanguage}
            isCreating={createProject.isPending}
            onCreate={() => createProject.mutate()}
            prominent
          />
        </div>

        {projectsQuery.isLoading ? (
          <div className="flex min-h-56 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 size-5 animate-spin" /> Loading projects</div>
        ) : projectsQuery.isError ? (
          <Card className="border-destructive/40">
            <CardContent className="py-10 text-center text-destructive">{projectsQuery.error instanceof Error ? projectsQuery.error.message : "Could not load your projects"}</CardContent>
          </Card>
        ) : projectsQuery.data?.length ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projectsQuery.data.map((project) => (
              <Link key={project.id} href={`/workspace/${project.id}`} className="group">
                <Card className="h-full transition-colors hover:border-primary/70 hover:bg-card/80">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{project.language}</span>
                      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
                    </div>
                    <CardTitle className="mt-3 line-clamp-1 text-lg">{project.name}</CardTitle>
                    <CardDescription className="line-clamp-2 min-h-10">{project.description || "Open this project in the browser workspace."}</CardDescription>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex min-h-72 flex-col items-center justify-center text-center">
              <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground"><FolderPlus className="size-6" /></span>
              <h2 className="mt-5 text-lg font-semibold">Start your first project</h2>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">Create a JavaScript, TypeScript, or Python workspace and start coding in the browser.</p>
              <Button className="mt-5" onClick={() => setOpen(true)}><Plus className="mr-2 size-4" /> New project</Button>
            </CardContent>
          </Card>
        )}
      </section>
    </main>
  );
}

function NewProjectDialog({ open, onOpenChange, name, onNameChange, language, onLanguageChange, isCreating, onCreate, prominent = false }: {
  open: boolean; onOpenChange: (open: boolean) => void; name: string; onNameChange: (name: string) => void;
  language: string; onLanguageChange: (language: string) => void; isCreating: boolean; onCreate: () => void; prominent?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant={prominent ? "default" : "outline"}><Plus className="mr-2 size-4" /> New project</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Create a project</DialogTitle><DialogDescription>Choose a name and runtime. You can add files and change code after it is created.</DialogDescription></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2"><Label htmlFor="project-name">Project name</Label><Input id="project-name" value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="My new app" autoFocus /></div>
          <div className="space-y-2"><Label>Primary language</Label><Select value={language} onValueChange={onLanguageChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="javascript">JavaScript</SelectItem><SelectItem value="typescript">TypeScript</SelectItem><SelectItem value="python">Python</SelectItem></SelectContent></Select></div>
        </div>
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={onCreate} disabled={!name.trim() || isCreating}>{isCreating && <Loader2 className="mr-2 size-4 animate-spin" />}Create project</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}