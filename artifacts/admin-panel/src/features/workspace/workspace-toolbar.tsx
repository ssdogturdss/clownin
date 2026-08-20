import * as React from 'react';
import { Play, Save, Globe, Github, Rocket, LayoutPanelLeft, Columns, AppWindow, Code2, Square, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Project, WorkspaceState, WorkspaceActions } from './types';

export function WorkspaceToolbar({
  project,
  state,
  actions,
}: {
  project: Project | null;
  state: WorkspaceState;
  actions: WorkspaceActions;
}) {
  return (
    <header className="flex h-14 items-center gap-2 border-b bg-background px-2 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
        <Button variant="ghost" size="icon" onClick={actions.onToggleLeftPanel} className="h-9 w-9 text-muted-foreground hover:text-foreground">
          <LayoutPanelLeft className="h-4 w-4" />
        </Button>
        <div className="hidden min-w-0 flex-col min-[480px]:flex">
          <span className="truncate text-sm font-semibold tracking-tight">{project?.name || 'Loading Workspace...'}</span>
          <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">{project?.language || 'workspace'}</span>
        </div>
      </div>
      
      <div className="hidden items-center gap-3 lg:flex">
        <div className="flex items-center rounded-md bg-muted/50 p-1 mr-2 border border-border/50 shadow-inner">
          <Button
            variant={state.previewMode === 'code' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => actions.onTogglePreviewMode('code')}
            className={`h-7 px-3 text-xs ${state.previewMode === 'code' ? 'shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Code2 className="mr-2 h-3.5 w-3.5" />
            Code
          </Button>
          <Button
            variant={state.previewMode === 'split' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => actions.onTogglePreviewMode('split')}
            className={`h-7 px-3 text-xs hidden sm:flex ${state.previewMode === 'split' ? 'shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <Columns className="mr-2 h-3.5 w-3.5" />
            Split
          </Button>
          <Button
            variant={state.previewMode === 'preview' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => actions.onTogglePreviewMode('preview')}
            className={`h-7 px-3 text-xs ${state.previewMode === 'preview' ? 'shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            <AppWindow className="mr-2 h-3.5 w-3.5" />
            Preview
          </Button>
        </div>

        <Button variant="outline" size="sm" onClick={actions.onSave} disabled={state.isSaving} className="h-8 shadow-xs" data-testid="button-workspace-save">
          <Save className="mr-2 h-3.5 w-3.5" />
          {state.isSaving ? 'Saving...' : 'Save'}
        </Button>
        <Button variant="secondary" size="sm" onClick={state.isRunning ? actions.onStopRun : actions.onRun} className="h-8 shadow-xs border-primary/20 hover:border-primary/50 text-primary transition-colors" data-testid="button-workspace-run">
          {state.isRunning ? <Square className="mr-2 h-3.5 w-3.5 fill-current" /> : <Play className="mr-2 h-3.5 w-3.5" />}
          {state.isRunning ? 'Stop' : 'Run'}
        </Button>
        <div className="h-4 w-[1px] bg-border mx-1"></div>
        <Button variant="ghost" size="sm" onClick={state.isServing ? actions.onStopServe : actions.onServe} className="h-8 text-muted-foreground hover:text-foreground" data-testid="button-workspace-serve">
          {state.isServing ? <Square className="mr-2 h-3.5 w-3.5 fill-current" /> : <Globe className="mr-2 h-3.5 w-3.5" />}
          {state.isServing ? 'Stop server' : 'Serve'}
        </Button>
        <Button variant="ghost" size="sm" onClick={actions.onGitHub} className="h-8 text-muted-foreground hover:text-foreground">
          <Github className="mr-2 h-3.5 w-3.5" />
          GitHub
        </Button>
        <Button variant="default" size="sm" onClick={actions.onDeploy} className="h-8 shadow-sm">
          <Rocket className="mr-2 h-3.5 w-3.5" />
          Deploy
        </Button>
      </div>

      <div className="flex shrink-0 items-center gap-1 lg:hidden">
        <Button variant={state.previewMode === 'code' ? 'secondary' : 'ghost'} size="icon" onClick={() => actions.onTogglePreviewMode('code')} aria-label="Show code" title="Show code">
          <Code2 className="size-4" />
        </Button>
        <Button variant={state.previewMode === 'preview' ? 'secondary' : 'ghost'} size="icon" onClick={() => actions.onTogglePreviewMode('preview')} aria-label="Show preview" title="Show preview">
          <AppWindow className="size-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={actions.onSave} disabled={state.isSaving} aria-label={state.isSaving ? 'Saving file' : 'Save file'} title={state.isSaving ? 'Saving file' : 'Save file'} data-testid="button-workspace-save">
          <Save className="size-4" />
        </Button>
        <Button variant="secondary" size="icon" onClick={state.isRunning ? actions.onStopRun : actions.onRun} aria-label={state.isRunning ? 'Stop run' : 'Run code'} title={state.isRunning ? 'Stop run' : 'Run code'} data-testid="button-workspace-run">
          {state.isRunning ? <Square className="size-3.5 fill-current" /> : <Play className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon" onClick={state.isServing ? actions.onStopServe : actions.onServe} aria-label={state.isServing ? 'Stop server' : 'Serve project'} title={state.isServing ? 'Stop server' : 'Serve project'} data-testid="button-workspace-serve">
          {state.isServing ? <Square className="size-3.5 fill-current" /> : <Globe className="size-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More workspace actions" title="More workspace actions"><MoreHorizontal className="size-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem className="hidden md:flex" onSelect={() => actions.onTogglePreviewMode('split')}><Columns /> Split view</DropdownMenuItem>
            <DropdownMenuSeparator className="hidden md:block" />
            <DropdownMenuItem onSelect={actions.onGitHub}><Github /> Export to GitHub</DropdownMenuItem>
            <DropdownMenuItem onSelect={actions.onDeploy}><Rocket /> Deploy project</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
