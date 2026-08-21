export interface ProjectFile {
  id: string | number;
  path: string;
  language: string;
  content: string;
}

export interface Project {
  id: string | number;
  name: string;
  language: string;
  description?: string;
  files: ProjectFile[];
}

export interface TerminalLine {
  id: string | number;
  type: 'stdout' | 'stderr' | 'system' | 'input';
  text: string;
}

export type PreviewMode = 'code' | 'preview' | 'split';

export interface WorkspaceState {
  selectedFileId: string | number | null;
  editorContent: string;
  isSaving: boolean;
  isRunning: boolean;
  isServing: boolean;
  isServeStarting: boolean;
  serveUrl: string | null;
  serveError: string | null;
  previewMode: PreviewMode;
  isLeftPanelOpen: boolean;
  isBottomPanelOpen: boolean;
}

export interface WorkspaceActions {
  onSelectFile: (file: ProjectFile) => void;
  onEditorChange: (content: string) => void;
  onSave: () => void;
  onRun: () => void;
  onStopRun: () => void;
  onServe: () => void;
  onStopServe: () => void;
  onDeploy: () => void;
  onGitHub: () => void;
  onCreateFile: (path: string) => void;
  onRenameFile: (id: string | number, newPath: string) => void;
  onDeleteFile: (id: string | number) => void;
  onTogglePreviewMode: (mode: PreviewMode) => void;
  onToggleLeftPanel: () => void;
  onToggleBottomPanel: () => void;
}
