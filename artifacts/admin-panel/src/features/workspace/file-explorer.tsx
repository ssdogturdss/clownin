import * as React from 'react';
import { FileCode, Plus, Edit2, Trash2, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Project, WorkspaceState, WorkspaceActions } from './types';

export function FileExplorer({
  project,
  state,
  actions,
  onOpenCreateDialog,
  onOpenRenameDialog,
  onOpenDeleteDialog,
}: {
  project: Project | null;
  state: WorkspaceState;
  actions: WorkspaceActions;
  onOpenCreateDialog: () => void;
  onOpenRenameDialog: (file: any) => void;
  onOpenDeleteDialog: (file: any) => void;
}) {
  if (!state.isLeftPanelOpen) return null;

  return (
    <div className="workspace-file-explorer absolute z-20 flex h-full w-[min(16rem,85vw)] flex-col border-r bg-sidebar text-sidebar-foreground shadow-xl transition-all duration-300 ease-in-out lg:relative lg:z-auto lg:w-64 lg:shadow-none">
      <div className="flex items-center justify-between border-b border-sidebar-border/50 px-4 py-3 bg-sidebar-accent/30">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/80">
          <FolderOpen className="h-4 w-4" />
          Explorer
        </div>
        <Button variant="ghost" size="icon" onClick={onOpenCreateDialog} className="h-6 w-6 hover:bg-sidebar-accent hover:text-sidebar-foreground text-sidebar-foreground/60 transition-colors">
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {project?.files.map((file) => {
          const isSelected = state.selectedFileId === file.id;
          return (
            <div
              key={file.id}
              className={`group flex items-center justify-between rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                isSelected 
                  ? 'bg-primary/10 text-primary font-medium' 
                  : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'
              }`}
              onClick={() => actions.onSelectFile(file)}
            >
              <div className="flex items-center gap-2.5 overflow-hidden">
                <FileCode className={`h-4 w-4 flex-shrink-0 ${isSelected ? 'text-primary' : 'text-sidebar-foreground/50'}`} />
                <span className="truncate tracking-tight">{file.path}</span>
              </div>
              <div className={`hidden group-hover:flex items-center gap-0.5 ${isSelected ? 'flex' : ''}`}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenRenameDialog(file);
                  }}
                >
                  <Edit2 className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-sidebar-foreground/50 hover:text-destructive hover:bg-destructive/10"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDeleteDialog(file);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
        {(!project?.files || project.files.length === 0) && (
          <div className="px-3 py-6 text-center text-xs text-sidebar-foreground/40 italic">
            No files in project
          </div>
        )}
      </div>
    </div>
  );
}
