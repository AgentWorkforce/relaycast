/**
 * The one place a file store is chosen (`RELAYCAST_FILE_STORE`). Object
 * stores plug in here behind {@link FileStore} without touching the handler.
 */
import type { FileStoreKind } from '../config.js';
import { LocalFileStore } from './local.js';
import type { FileStore } from './store.js';

export type { FileObject, FilePutOptions, FileStore } from './store.js';
export { InvalidStorageKeyError } from './store.js';
export { LocalFileStore } from './local.js';

export interface FileStoreOptions {
  kind: FileStoreKind;
  /** `local`: the directory file bytes live in. */
  fileDir: string;
}

export function createFileStore(options: FileStoreOptions): FileStore {
  switch (options.kind) {
    case 'local':
      return new LocalFileStore(options.fileDir);
    case 'gcs':
    case 's3':
      throw new Error(`RELAYCAST_FILE_STORE=${options.kind} is not implemented yet`);
  }
}
