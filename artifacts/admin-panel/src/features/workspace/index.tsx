import * as React from 'react';
import { Project, WorkspaceState, WorkspaceActions, TerminalLine, ProjectFile } from './types';
import { WorkspaceToolbar } from './workspace-toolbar';
import { FileExplorer } from './file-explorer';
import { EditorPane } from './editor-pane';
import { TerminalPane } from './terminal-pane';
import { PreviewPane } from './preview-pane';
import { FileDialogs } from './file-dialogs';
import { TerminalSquare, CircleDot } from 'lucide-react';

export interface WorkspaceContainerProps {
  project: Project | null;
  state: WorkspaceState;
  actions: WorkspaceActions;
  terminalLines: TerminalLine[];
}

export function WorkspaceContainer({
  project,
  state,
  actions,
  terminalLines,
}: WorkspaceContainerProps) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [dialogFile, setDialogFile] = React.useState<ProjectFile | null>(null);

  const handleOpenCreate = () => setCreateOpen(true);
  const handleOpenRename = (file: ProjectFile) => {
    setDialogFile(file);
    setRenameOpen(true);
  };
  const handleOpenDelete = (file: ProjectFile) => {
    setDialogFile(file);
    setDeleteOpen(true);
  };
  const closeDialogs = () => {
    setCreateOpen(false);
    setRenameOpen(false);
    setDeleteOpen(false);
    setDialogFile(null);
  };

  const selectedFile = project?.files.find((f) => f.id === state.selectedFileId) || null;

  return (
    <div className="flex h-[100dvh] w-full flex-col bg-background text-foreground overflow-hidden font-sans">
      <WorkspaceToolbar project={project} state={state} actions={actions} />
      
      <div className="relative flex flex-1 overflow-hidden">
        <FileExplorer 
          project={project}
          state={state}
          actions={actions}
          onOpenCreateDialog={handleOpenCreate}
          onOpenRenameDialog={handleOpenRename}
          onOpenDeleteDialog={handleOpenDelete}
        />
        {state.isLeftPanelOpen && (
          <button
            type="button"
            className="workspace-drawer-backdrop absolute inset-0 z-10 bg-black/50 backdrop-blur-[1px] lg:hidden"
            aria-label="Close file explorer"
            onClick={actions.onToggleLeftPanel}
          />
        )}
        
        <div className="relative z-0 flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 flex-row overflow-hidden relative">
            {/* Editor Area */}
            {(state.previewMode === 'code' || state.previewMode === 'split') && (
              <div className={`flex flex-col h-full ${state.previewMode === 'split' ? 'w-1/2 border-r' : 'w-full'}`}>
                {selectedFile ? (
                  <EditorPane
                    content={state.editorContent}
                    onChange={actions.onEditorChange}
                    language={selectedFile.language}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-muted-foreground bg-muted/10">
                    <div className="flex flex-col items-center gap-3">
                      <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center shadow-inner border border-border/50">
                        <CircleDot className="h-6 w-6 text-muted-foreground/50" />
                      </div>
                      <p className="text-sm font-medium text-muted-foreground/80">Select a file to start coding</p>
                    </div>
                  </div>
                )}
              </div>
            )}
            
            {/* Preview Area */}
            {(state.previewMode === 'preview' || state.previewMode === 'split') && (
              <div className={`flex flex-col h-full ${state.previewMode === 'split' ? 'w-1/2' : 'w-full'}`}>
                <PreviewPane serveUrl={state.serveUrl} />
              </div>
            )}
          </div>
          
          {/* Bottom Panel / Terminal */}
          <TerminalPane 
            lines={terminalLines} 
            isOpen={state.isBottomPanelOpen} 
            onClose={actions.onToggleBottomPanel} 
          />
        </div>
      </div>
      
      {/* Status Bar */}
      <footer className="flex h-7 items-center justify-between gap-2 border-t bg-sidebar px-2 text-[11px] text-muted-foreground font-mono select-none sm:px-4">
        <div className="flex min-w-0 items-center gap-3 sm:gap-5">
          <button 
            className={`flex items-center gap-1.5 transition-colors focus:outline-none ${state.isBottomPanelOpen ? 'text-primary font-semibold' : 'hover:text-foreground'}`}
            onClick={actions.onToggleBottomPanel}
          >
            <TerminalSquare className="h-3.5 w-3.5" />
            Terminal
          </button>
          <div className="h-3 w-[1px] bg-border"></div>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${state.isRunning || state.isServing ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground'}`}></span>
            <span className="truncate">{project?.name || 'Workspace'}</span>
          </span>
        </div>
        <div className="hidden items-center gap-4 sm:flex">
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground/50">Ln 1, Col 1</span>
          </span>
          <span className="text-muted-foreground/50">UTF-8</span>
          <span className="uppercase font-semibold tracking-wider text-muted-foreground/80">{selectedFile?.language || 'TEXT'}</span>
        </div>
      </footer>

      <FileDialogs
        createOpen={createOpen}
        renameOpen={renameOpen}
        deleteOpen={deleteOpen}
        selectedDialogFile={dialogFile}
        onClose={closeDialogs}
        onCreate={actions.onCreateFile}
        onRename={actions.onRenameFile}
        onDelete={actions.onDeleteFile}
      />
    </div>
  );
}

export * from './types';
