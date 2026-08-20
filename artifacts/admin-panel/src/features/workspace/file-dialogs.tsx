import * as React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ProjectFile } from './types';

interface FileDialogsProps {
  createOpen: boolean;
  renameOpen: boolean;
  deleteOpen: boolean;
  selectedDialogFile: ProjectFile | null;
  onClose: () => void;
  onCreate: (path: string) => void;
  onRename: (id: string | number, newPath: string) => void;
  onDelete: (id: string | number) => void;
}

export function FileDialogs({
  createOpen,
  renameOpen,
  deleteOpen,
  selectedDialogFile,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: FileDialogsProps) {
  const [inputValue, setInputValue] = React.useState('');

  React.useEffect(() => {
    if (renameOpen && selectedDialogFile) {
      setInputValue(selectedDialogFile.path);
    } else if (createOpen) {
      setInputValue('');
    }
  }, [renameOpen, createOpen, selectedDialogFile]);

  const handleCreate = () => {
    if (inputValue.trim()) {
      onCreate(inputValue.trim());
      onClose();
    }
  };

  const handleRename = () => {
    if (selectedDialogFile && inputValue.trim()) {
      onRename(selectedDialogFile.id, inputValue.trim());
      onClose();
    }
  };

  const handleDelete = () => {
    if (selectedDialogFile) {
      onDelete(selectedDialogFile.id);
      onClose();
    }
  };

  return (
    <>
      <Dialog open={createOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Create File</DialogTitle>
            <DialogDescription>Enter the path and name for the new file.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <input
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="e.g. src/main.ts"
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Rename File</DialogTitle>
            <DialogDescription>Update the path or filename.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <input
              autoFocus
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              onKeyDown={(e) => e.key === 'Enter' && handleRename()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleRename}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="text-destructive">Delete File</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <span className="font-semibold text-foreground">{selectedDialogFile?.path}</span>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete Permanently</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
