/** Native updater snapshots are ordered so startup hydration cannot overwrite a newer event. */
export interface UpdateState {
  revision: number;
  currentVersion: string;
  status:
    | 'idle'
    | 'checking'
    | 'upToDate'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'installing'
    | 'error';
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
  autoCheck: boolean;
}
