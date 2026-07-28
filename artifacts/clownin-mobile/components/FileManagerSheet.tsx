/**
 * FileManagerSheet — bottom-sheet overlay for add / rename / delete files
 * inside the project editor.
 *
 * Props:
 *   projectId    – current project's numeric id
 *   files        – current file list (ProjectFile[])
 *   activeFileId – id of the currently-open file
 *   onClose      – close the sheet
 *   onFileSelect – switch to a different file after creation
 *   onRefresh    – re-fetch the project so the new file list is reflected
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  useCreateFile,
  useUpdateFile,
  useDeleteFile,
} from '@workspace/api-client-react';
import type { ProjectFile } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

// ─── Language helpers ────────────────────────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  md: 'plaintext',
  txt: 'plaintext',
  json: 'plaintext',
  css: 'plaintext',
  html: 'plaintext',
};

function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? 'plaintext';
}

const LANG_ICON: Record<string, string> = {
  javascript: 'language-javascript',
  typescript: 'language-typescript',
  python: 'language-python',
  bash: 'bash',
  plaintext: 'file-outline',
};

// ─── Sub-component: one file row ─────────────────────────────────────────────

interface FileRowProps {
  file: ProjectFile;
  isActive: boolean;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function FileRow({ file, isActive, onSelect, onRename, onDelete }: FileRowProps) {
  const colors = useColors();
  const icon = (LANG_ICON[file.language] ?? 'file-outline') as any;

  return (
    <Pressable
      style={[
        styles.fileRow,
        { borderColor: colors.border },
        isActive && { backgroundColor: colors.primary + '18' },
      ]}
      onPress={onSelect}
    >
      <MaterialCommunityIcons
        name={icon}
        size={18}
        color={isActive ? colors.primary : colors.mutedForeground}
        style={styles.fileIcon}
      />
      <Text
        style={[
          styles.fileName,
          { color: isActive ? colors.primary : colors.foreground },
        ]}
        numberOfLines={1}
      >
        {file.path}
      </Text>
      <View style={styles.fileActions}>
        <Pressable onPress={onRename} hitSlop={8} style={styles.fileActionBtn}>
          <Ionicons name="pencil-outline" size={15} color={colors.mutedForeground} />
        </Pressable>
        <Pressable onPress={onDelete} hitSlop={8} style={styles.fileActionBtn}>
          <Ionicons name="trash-outline" size={15} color={colors.destructive} />
        </Pressable>
      </View>
    </Pressable>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  projectId: number;
  files: ProjectFile[];
  activeFileId: number;
  onClose: () => void;
  onFileSelect: (file: ProjectFile) => void;
  onRefresh: () => void;
}

type Mode = 'list' | 'add' | 'rename';

export function FileManagerSheet({
  projectId,
  files,
  activeFileId,
  onClose,
  onFileSelect,
  onRefresh,
}: Props) {
  const colors = useColors();
  const createMutation = useCreateFile();
  const updateMutation = useUpdateFile();
  const deleteMutation = useDeleteFile();

  const [mode, setMode] = useState<Mode>('list');
  const [newPath, setNewPath] = useState('');
  const [renameTarget, setRenameTarget] = useState<ProjectFile | null>(null);
  const [renamePath, setRenamePath] = useState('');

  // ── Add file ───────────────────────────────────────────────────────────────

  const handleAdd = async () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    try {
      const file = await createMutation.mutateAsync({
        id: projectId,
        data: { path: trimmed, language: langFromPath(trimmed), content: '' },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setNewPath('');
      setMode('list');
      onRefresh();
      onFileSelect(file);
    } catch {
      Alert.alert('Error', 'Failed to create file');
    }
  };

  // ── Rename file ────────────────────────────────────────────────────────────

  const startRename = (file: ProjectFile) => {
    setRenameTarget(file);
    setRenamePath(file.path);
    setMode('rename');
  };

  const handleRename = async () => {
    if (!renameTarget || !renamePath.trim()) return;
    try {
      await updateMutation.mutateAsync({
        id: projectId,
        fileId: renameTarget.id,
        data: { path: renamePath.trim(), language: langFromPath(renamePath.trim()) },
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMode('list');
      onRefresh();
    } catch {
      Alert.alert('Error', 'Failed to rename file');
    }
  };

  // ── Delete file ────────────────────────────────────────────────────────────

  const handleDelete = (file: ProjectFile) => {
    if (files.length <= 1) {
      Alert.alert('Cannot delete', 'A project must have at least one file.');
      return;
    }
    Alert.alert('Delete File', `Delete "${file.path}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteMutation.mutateAsync({ id: projectId, fileId: file.id });
            await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            onRefresh();
            // If active file was deleted, jump to first remaining file
            if (file.id === activeFileId) {
              const next = files.find((f) => f.id !== file.id);
              if (next) onFileSelect(next);
            }
          } catch {
            Alert.alert('Error', 'Failed to delete file');
          }
        },
      },
    ]);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const isBusy = createMutation.isPending || updateMutation.isPending;

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {/* Header */}
        <View style={[styles.sheetHeader, { borderBottomColor: colors.border }]}>
          {mode !== 'list' ? (
            <Pressable onPress={() => setMode('list')} hitSlop={8}>
              <Ionicons name="arrow-back" size={20} color={colors.foreground} />
            </Pressable>
          ) : (
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Files</Text>
          )}
          {mode === 'list' && (
            <Pressable
              onPress={() => { setNewPath(''); setMode('add'); }}
              style={[styles.addBtn, { backgroundColor: colors.primary }]}
            >
              <Ionicons name="add" size={18} color={colors.primaryForeground} />
              <Text style={[styles.addBtnText, { color: colors.primaryForeground }]}>New file</Text>
            </Pressable>
          )}
          {mode !== 'list' && (
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
              {mode === 'add' ? 'New File' : 'Rename File'}
            </Text>
          )}
          <Pressable onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={20} color={colors.mutedForeground} />
          </Pressable>
        </View>

        {/* List mode */}
        {mode === 'list' && (
          <ScrollView style={styles.fileList} contentContainerStyle={{ gap: 6, padding: 12 }}>
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                isActive={file.id === activeFileId}
                onSelect={() => { onFileSelect(file); onClose(); }}
                onRename={() => startRename(file)}
                onDelete={() => handleDelete(file)}
              />
            ))}
          </ScrollView>
        )}

        {/* Add / Rename mode — shared input form */}
        {(mode === 'add' || mode === 'rename') && (
          <View style={styles.inputForm}>
            <Text style={[styles.inputLabel, { color: colors.mutedForeground }]}>
              {mode === 'add' ? 'File name (e.g. utils.js, lib.py)' : 'New file name'}
            </Text>
            <TextInput
              style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.input }]}
              placeholder={mode === 'add' ? 'index.ts' : renameTarget?.path}
              placeholderTextColor={colors.mutedForeground}
              value={mode === 'add' ? newPath : renamePath}
              onChangeText={mode === 'add' ? setNewPath : setRenamePath}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={mode === 'add' ? handleAdd : handleRename}
            />
            <View style={styles.formActions}>
              <Pressable
                style={[styles.formBtn, { borderColor: colors.border }]}
                onPress={() => setMode('list')}
              >
                <Text style={[styles.formBtnText, { color: colors.foreground }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.formBtn, styles.formBtnPrimary, { backgroundColor: colors.primary }]}
                onPress={mode === 'add' ? handleAdd : handleRename}
                disabled={isBusy}
              >
                {isBusy ? (
                  <ActivityIndicator size="small" color={colors.primaryForeground} />
                ) : (
                  <Text style={[styles.formBtnText, { color: colors.primaryForeground }]}>
                    {mode === 'add' ? 'Create' : 'Rename'}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: '65%',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  sheetTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  addBtnText: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  fileList: { flex: 1 },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  fileIcon: { marginRight: 10 },
  fileName: { flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular' },
  fileActions: { flexDirection: 'row', gap: 4 },
  fileActionBtn: { padding: 4 },
  inputForm: { padding: 16, gap: 10 },
  inputLabel: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
  },
  formActions: { flexDirection: 'row', gap: 10 },
  formBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
  },
  formBtnPrimary: { borderWidth: 0 },
  formBtnText: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
});
