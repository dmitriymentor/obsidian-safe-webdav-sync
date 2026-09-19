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
  syncDeletions: boolean;
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
  nameRepairs?: NameRepair[];
  lastReport?: SyncReport;
  lastErrorReport?: SyncReport;
  automaticSyncBlocked?: boolean;
  deletionState?: DeletionState;
  settings: PluginSettings;
  state: Record<string, FileState>;
}

export interface NameRepair {
  from: string;
  to: string;
  backupPath: string;
  at: string;
  completed: boolean;
}

export interface SyncReport {
  startedAt: number;
  finishedAt: number;
  reason: string;
  dryRun: boolean;
  report: string;
  errors: string[];
}

export interface DeleteIntent {
  id: string;
  path: string;
  baseHash: string;
  createdAt: string;
  deviceId: string;
  renameTo?: string;
}

export interface DeletionState {
  deviceId: string;
  pending: DeleteIntent[];
  knownIds: string[];
  baselineReady: boolean;
}

export interface DeletionHooks {
  data: DeletionState;
  mutations: Set<string>;
  confirmMass?: (paths: string[]) => Promise<boolean>;
  resolveConflict?: (path: string) => Promise<"keep" | "delete" | "later">;
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
  renamed?: number;
  repaired: number;
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
