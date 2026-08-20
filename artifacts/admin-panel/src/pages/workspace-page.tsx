import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRoute } from "wouter";
import { ArrowLeft, Check, ExternalLink, Loader2, Rocket, Save, Upload } from "lucide-react";
import { toast } from "sonner";
import { WorkspaceContainer, type PreviewMode, type Project, type ProjectFile, type TerminalLine, type WorkspaceActions, type WorkspaceState } from "@/features/workspace";
import { workspaceFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type ProjectResponse = Project & { description?: string | null };
type StreamEvent = { type: "token" | "stdout" | "stderr" | "exit" | "system"; payload: string };
type GitHubResult = { repoUrl: string; owner: string; repoName: string; isUpdate?: boolean };
type DeployResult = { url: string; siteId?: string; deploymentId?: string; warning?: string };

const GITHUB_TOKEN_KEY = "clownin_web_github_token";
const DEPLOY_TOKEN_KEY = (platform: string) => `clownin_web_${platform}_token`;
const DEPLOY_SITE_KEY = (platform: string, projectId: number) => `clownin_web_${platform}_site_${projectId}`;

async function readJson<T>(response: Response | Promise<Response>): Promise<T> {
  const resolved = await response;
  const body = await resolved.json().catch(() => ({}));
  if (!resolved.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${resolved.status})`);
  return body as T;
}

async function consumeSse(response: Response, onEvent: (event: StreamEvent) => void) {
  if (!response.body) throw new Error("The server did not provide a stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split("\n\n");
    buffer = messages.pop() ?? "";
    for (const message of messages) {
      const data = message.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (!data) continue;
      try { onEvent(JSON.parse(data) as StreamEvent); } catch { /* Ignore malformed stream events. */ }
    }
  }
}

function languageForPath(path: string) {
  const ext = path.toLowerCase().split(".").pop();
  const languages: Record<string, string> = {
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    py: "python", sh: "bash", bash: "bash", go: "go", rs: "rust", rb: "ruby",
    java: "java", json: "json", html: "html", css: "css", md: "markdown",
  };
  return languages[ext ?? ""] ?? "plaintext";
}

function appendLine(setLines: React.Dispatch<React.SetStateAction<TerminalLine[]>>, type: TerminalLine["type"], text: string) {
  setLines((lines) => [...lines, { id: `${Date.now()}-${Math.random()}`, type, text }].slice(-1000));
}

export default function WorkspacePage() {
  const [, params] = useRoute("/workspace/:id");
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const projectId = Number(params && "id" in params ? params.id : Number.NaN);
  const runAbortRef = useRef<AbortController | null>(null);
  const serveAbortRef = useRef<AbortController | null>(null);

  const projectQuery = useQuery({
    queryKey: ["workspace-project", projectId],
    enabled: Number.isFinite(projectId),
    queryFn: () => readJson<ProjectResponse>(workspaceFetch(`/projects/${projectId}`)),
  });
  const project = projectQuery.data ?? null;

  const [selectedFileId, setSelectedFileId] = useState<string | number | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isServing, setIsServing] = useState(false);
  const [serveUrl, setServeUrl] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => window.innerWidth >= 1280 ? "split" : "code");
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isBottomPanelOpen, setIsBottomPanelOpen] = useState(false);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>([]);
  const [githubOpen, setGithubOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);

  const selectedFile = useMemo(
    () => project?.files.find((file) => file.id === selectedFileId) ?? null,
    [project, selectedFileId],
  );
  const isDirty = Boolean(selectedFile && editorContent !== selectedFile.content);

  useEffect(() => {
    if (!project) return;
    const firstFile = project.files.find((file) => file.id === selectedFileId) ?? project.files[0] ?? null;
    setSelectedFileId(firstFile?.id ?? null);
    setEditorContent(firstFile?.content ?? "");
  }, [project?.id]); // Reset only when navigation opens a different project.

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 768) setPreviewMode((mode) => mode === "split" ? "code" : mode);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const updateCachedFile = useCallback((file: ProjectFile) => {
    queryClient.setQueryData<ProjectResponse>(["workspace-project", projectId], (current) => current
      ? { ...current, files: current.files.map((item) => item.id === file.id ? file : item) }
      : current);
  }, [projectId, queryClient]);

  const previewUrlFor = useCallback(async (baseUrl: string) => {
    const { token } = await readJson<{ token: string }>(workspaceFetch(`/projects/${projectId}/serve/preview-token`));
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}preview_token=${encodeURIComponent(token)}`;
  }, [projectId]);

  const saveFile = useCallback(async () => {
    if (!selectedFile || !isDirty) return true;
    setIsSaving(true);
    try {
      const updated = await readJson<ProjectFile>(workspaceFetch(`/projects/${projectId}/files/${selectedFile.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editorContent }),
      }));
      updateCachedFile(updated);
      setEditorContent(updated.content);
      toast.success("Saved");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the file");
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [editorContent, isDirty, projectId, selectedFile, updateCachedFile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFile();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveFile]);

  const selectFile = useCallback(async (file: ProjectFile) => {
    if (file.id === selectedFileId) return;
    if (!(await saveFile())) return;
    setSelectedFileId(file.id);
    setEditorContent(file.content);
  }, [saveFile, selectedFileId]);

  const createFile = useCallback(async (path: string) => {
    if (!(await saveFile())) return;
    try {
      const file = await readJson<ProjectFile>(workspaceFetch(`/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "", language: languageForPath(path) }),
      }));
      queryClient.setQueryData<ProjectResponse>(["workspace-project", projectId], (current) =>
        current ? { ...current, files: [...current.files, file].sort((a, b) => a.path.localeCompare(b.path)) } : current);
      setSelectedFileId(file.id);
      setEditorContent(file.content);
      toast.success(`${file.path} created`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the file");
    }
  }, [projectId, queryClient, saveFile]);

  const renameFile = useCallback(async (fileId: string | number, path: string) => {
    try {
      const file = await readJson<ProjectFile>(workspaceFetch(`/projects/${projectId}/files/${fileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, language: languageForPath(path) }),
      }));
      updateCachedFile(file);
      toast.success("File renamed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not rename the file");
    }
  }, [projectId, updateCachedFile]);

  const deleteFile = useCallback(async (fileId: string | number) => {
    try {
      const response = await workspaceFetch(`/projects/${projectId}/files/${fileId}`, { method: "DELETE" });
      if (!response.ok) await readJson(response);
      const remaining = project?.files.filter((file) => file.id !== fileId) ?? [];
      queryClient.setQueryData<ProjectResponse>(["workspace-project", projectId], (current) =>
        current ? { ...current, files: current.files.filter((file) => file.id !== fileId) } : current);
      if (selectedFileId === fileId) {
        setSelectedFileId(remaining[0]?.id ?? null);
        setEditorContent(remaining[0]?.content ?? "");
      }
      toast.success("File deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the file");
    }
  }, [project?.files, projectId, queryClient, selectedFileId]);

  const runCode = useCallback(async () => {
    if (!selectedFile) { toast.error("Choose a file to run"); return; }
    if (!(await saveFile())) return;
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    setIsRunning(true);
    setIsBottomPanelOpen(true);
    setTerminalLines([]);
    appendLine(setTerminalLines, "system", `$ Running ${selectedFile.path}`);
    try {
      const response = await workspaceFetch(`/projects/${projectId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ fileId: selectedFile.id }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Run failed");
      await consumeSse(response, (event) => {
        if (event.type === "exit") appendLine(setTerminalLines, "system", `[Process exited with code ${event.payload}]`);
        else if (event.type !== "token") appendLine(setTerminalLines, event.type, event.payload);
      });
    } catch (error) {
      if ((error as DOMException).name === "AbortError") appendLine(setTerminalLines, "system", "[Run cancelled]");
      else appendLine(setTerminalLines, "stderr", error instanceof Error ? error.message : "Run failed");
    } finally {
      if (runAbortRef.current === controller) runAbortRef.current = null;
      setIsRunning(false);
    }
  }, [projectId, saveFile, selectedFile]);

  const stopRun = useCallback(() => {
    runAbortRef.current?.abort();
    runAbortRef.current = null;
  }, []);

  const listenForServeLogs = useCallback(async (controller: AbortController) => {
    try {
      const response = await workspaceFetch(`/projects/${projectId}/serve/logs`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not open server logs");
      await consumeSse(response, (event) => {
        if (event.type === "exit") {
          appendLine(setTerminalLines, "system", `[Server stopped (exit ${event.payload})]`);
          setIsServing(false);
          setServeUrl(null);
        } else if (event.type !== "token") appendLine(setTerminalLines, event.type, event.payload);
      });
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") appendLine(setTerminalLines, "stderr", error instanceof Error ? error.message : "Serve log stream failed");
    }
  }, [projectId]);

  const startServe = useCallback(async () => {
    if (!selectedFile) { toast.error("Choose an entry file to serve"); return; }
    if (!(await saveFile())) return;
    setIsBottomPanelOpen(true);
    appendLine(setTerminalLines, "system", `$ Starting ${selectedFile.path}`);
    try {
      const result = await readJson<{ url: string }>(workspaceFetch(`/projects/${projectId}/serve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: selectedFile.id }),
      }));
      setServeUrl(await previewUrlFor(result.url));
      setIsServing(true);
      setPreviewMode(window.innerWidth >= 1280 ? "split" : "preview");
      serveAbortRef.current?.abort();
      const controller = new AbortController();
      serveAbortRef.current = controller;
      void listenForServeLogs(controller);
    } catch (error) {
      appendLine(setTerminalLines, "stderr", error instanceof Error ? error.message : "Could not start the server");
      toast.error(error instanceof Error ? error.message : "Could not start the server");
    }
  }, [listenForServeLogs, previewUrlFor, projectId, saveFile, selectedFile]);

  const stopServe = useCallback(async () => {
    serveAbortRef.current?.abort();
    serveAbortRef.current = null;
    try {
      const response = await workspaceFetch(`/projects/${projectId}/serve`, { method: "DELETE" });
      if (!response.ok) await readJson(response);
      appendLine(setTerminalLines, "system", "[Stopping server]");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not stop the server");
    } finally {
      setIsServing(false);
      setServeUrl(null);
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const status = await readJson<{ running: boolean; url?: string }>(workspaceFetch(`/projects/${projectId}/serve`, { signal: controller.signal }));
        if (status.running && status.url) {
          setIsServing(true);
          setServeUrl(await previewUrlFor(status.url));
          const logsController = new AbortController();
          serveAbortRef.current = logsController;
          void listenForServeLogs(logsController);
        }
      } catch { /* The workspace can still be used if status is unavailable. */ }
    })();
    return () => {
      controller.abort();
      runAbortRef.current?.abort();
      serveAbortRef.current?.abort();
    };
  }, [listenForServeLogs, previewUrlFor, projectId]);

  const state: WorkspaceState = {
    selectedFileId, editorContent, isSaving, isRunning, isServing, serveUrl, previewMode,
    isLeftPanelOpen, isBottomPanelOpen,
  };
  const actions: WorkspaceActions = {
    onSelectFile: (file) => { void selectFile(file); },
    onEditorChange: setEditorContent,
    onSave: () => { void saveFile(); },
    onRun: () => { void runCode(); },
    onStopRun: stopRun,
    onServe: () => { void startServe(); },
    onStopServe: () => { void stopServe(); },
    onDeploy: () => { void (async () => { if (await saveFile()) setDeployOpen(true); })(); },
    onGitHub: () => { void (async () => { if (await saveFile()) setGithubOpen(true); })(); },
    onCreateFile: (path) => { void createFile(path); },
    onRenameFile: (fileId, path) => { void renameFile(fileId, path); },
    onDeleteFile: (fileId) => { void deleteFile(fileId); },
    onTogglePreviewMode: (mode) => setPreviewMode(window.innerWidth < 768 && mode === "split" ? "code" : mode),
    onToggleLeftPanel: () => setIsLeftPanelOpen((open) => !open),
    onToggleBottomPanel: () => setIsBottomPanelOpen((open) => !open),
  };

  if (projectQuery.isLoading) {
    return <main className="flex min-h-screen items-center justify-center bg-background text-muted-foreground"><Loader2 className="mr-2 size-5 animate-spin" /> Loading workspace</main>;
  }
  if (projectQuery.isError || !project) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
        <h1 className="text-xl font-semibold">This project is unavailable</h1>
        <p className="max-w-md text-muted-foreground">{projectQuery.error instanceof Error ? projectQuery.error.message : "It may have been removed or you may not have access to it."}</p>
        <Button asChild><Link href="/workspace"><ArrowLeft className="mr-2 size-4" /> Back to projects</Link></Button>
      </main>
    );
  }

  return (
    <>
      <WorkspaceContainer project={project} state={state} actions={actions} terminalLines={terminalLines} />
      <GitHubDialog open={githubOpen} onOpenChange={setGithubOpen} project={project} />
      <DeployDialog open={deployOpen} onOpenChange={setDeployOpen} project={project} />
    </>
  );
}

function GitHubDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project: Project }) {
  const [token, setToken] = useState("");
  const [repoName, setRepoName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<GitHubResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setToken(sessionStorage.getItem(GITHUB_TOKEN_KEY) ?? "");
    setRepoName(project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100));
    setResult(null);
  }, [open, project.name]);

  async function push() {
    if (!token.trim() || !repoName.trim()) { toast.error("Enter a GitHub token and repository name"); return; }
    setIsLoading(true);
    try {
      const result = await readJson<GitHubResult>(workspaceFetch(`/projects/${project.id}/github/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), repoName: repoName.trim(), isPrivate, description: project.description ?? "" }),
      }));
      sessionStorage.setItem(GITHUB_TOKEN_KEY, token.trim());
      setResult(result);
      toast.success("Project pushed to GitHub");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "GitHub export failed");
    } finally {
      setIsLoading(false);
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{result ? "GitHub export complete" : "Export to GitHub"}</DialogTitle><DialogDescription>{result ? "Your source is now available in a real GitHub repository." : "Create a repository from the current project files. Your token stays in this browser."}</DialogDescription></DialogHeader>
    {result ? <div className="rounded-lg border border-primary/30 bg-primary/5 p-4"><p className="font-medium">{result.owner}/{result.repoName}</p><a className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline" href={result.repoUrl} target="_blank" rel="noreferrer">Open repository <ExternalLink className="size-3" /></a></div> : <div className="space-y-4 py-2">
      <div className="space-y-2"><Label htmlFor="github-token">GitHub personal access token</Label><Input id="github-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="ghp_…" /></div>
      <div className="space-y-2"><Label htmlFor="github-repo">Repository name</Label><Input id="github-repo" value={repoName} onChange={(event) => setRepoName(event.target.value)} /></div>
      <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} /> Private repository</label>
    </div>}
    <DialogFooter>{result ? <Button onClick={() => onOpenChange(false)}><Check className="mr-2 size-4" /> Done</Button> : <><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={push} disabled={isLoading}>{isLoading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />}Create & push</Button></>}</DialogFooter>
  </DialogContent></Dialog>;
}

function DeployDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (open: boolean) => void; project: Project }) {
  const [platform, setPlatform] = useState<"netlify" | "vercel">("netlify");
  const [token, setToken] = useState("");
  const [siteName, setSiteName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<DeployResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setToken(sessionStorage.getItem(DEPLOY_TOKEN_KEY(platform)) ?? "");
    setSiteName(project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 63));
    setResult(null);
  }, [open, platform, project.name]);

  async function deploy() {
    if (!token.trim() || !siteName.trim()) { toast.error(`Enter a ${platform === "netlify" ? "Netlify" : "Vercel"} token and site name`); return; }
    setIsLoading(true);
    try {
      const savedSiteId = sessionStorage.getItem(DEPLOY_SITE_KEY(platform, Number(project.id)));
      const result = await readJson<DeployResult>(workspaceFetch(`/projects/${project.id}/deploy/${platform}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), siteName: siteName.trim(), projectName: siteName.trim(), ...(savedSiteId ? { siteId: savedSiteId } : {}) }),
      }));
      sessionStorage.setItem(DEPLOY_TOKEN_KEY(platform), token.trim());
      const identifier = result.siteId ?? result.deploymentId;
      if (identifier) sessionStorage.setItem(DEPLOY_SITE_KEY(platform, Number(project.id)), identifier);
      setResult(result);
      toast.success("Deployment is live");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Deployment failed");
    } finally {
      setIsLoading(false);
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
    <DialogHeader><DialogTitle>{result ? "Deployment complete" : "Deploy project"}</DialogTitle><DialogDescription>{result ? "Your live URL is ready to share." : "Deploy this project to Netlify or Vercel. The access token is saved only in this browser."}</DialogDescription></DialogHeader>
    {result ? <div className="rounded-lg border border-primary/30 bg-primary/5 p-4"><a className="inline-flex items-center gap-1 font-medium text-primary hover:underline" href={result.url} target="_blank" rel="noreferrer">{result.url}<ExternalLink className="size-3" /></a>{result.warning && <p className="mt-2 text-sm text-muted-foreground">{result.warning}</p>}</div> : <div className="space-y-4 py-2">
      <div className="space-y-2"><Label>Platform</Label><Select value={platform} onValueChange={(value) => setPlatform(value as "netlify" | "vercel")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="netlify">Netlify</SelectItem><SelectItem value="vercel">Vercel</SelectItem></SelectContent></Select></div>
      <div className="space-y-2"><Label htmlFor="deploy-token">{platform === "netlify" ? "Netlify" : "Vercel"} access token</Label><Input id="deploy-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} /></div>
      <div className="space-y-2"><Label htmlFor="site-name">Site name</Label><Input id="site-name" value={siteName} onChange={(event) => setSiteName(event.target.value)} /></div>
    </div>}
    <DialogFooter>{result ? <Button onClick={() => onOpenChange(false)}><Check className="mr-2 size-4" /> Done</Button> : <><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={deploy} disabled={isLoading}>{isLoading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Rocket className="mr-2 size-4" />}Deploy to {platform === "netlify" ? "Netlify" : "Vercel"}</Button></>}</DialogFooter>
  </DialogContent></Dialog>;
}