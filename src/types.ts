export interface ImportedConfig {
  address: string;
  username: string;
  webdavPassword: string;
  authType: "basic" | "digest";
  remoteBaseDir: string;
  encryptionPassword: string;
  encryptionMethod: string;
  autoRunEveryMilliseconds: number;
  syncOnSaveAfterMilliseconds: number;
}

export interface PluginSettings {
  autoSync: boolean;
  syncOnSave: boolean;
  intervalMs: number;
  sourcePluginId: string;
}

export interface FileState {
  baseHash: string;
  baseText?: string;
  localHash?: string;
  remoteFingerprint?: string;
  existsLocal: boolean;
  existsRemote: boolean;
  lastSync: number;
}

export interface PersistedData {
  settings: PluginSettings;
  state: Record<string, FileState>;
}

export interface RemoteEntry {
  path: string;
  encryptedPath: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  etag: string;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  merged: number;
  conflicts: number;
  deleted: number;
  unchanged: number;
  errors: string[];
}

export interface SyncProgress {
  phase: "local" | "remote" | "files" | "saving";
  label: string;
  completed: number;
  total: number;
  path?: string;
}
