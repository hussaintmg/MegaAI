/**
 * The queue in a file on your own disk.
 *
 * This exists so the laptop agent is useful the first evening, before any
 * Atlas cluster, connection string or account exists: queue a few tasks, close
 * the lid, come back to work that was done. It is the same queue with the same
 * leases — only the storage is different, so nothing has to be rewritten when
 * the shared database arrives.
 *
 * What it does not do is coordinate two machines. One writer, one file. The
 * moment a second node needs the same queue, that is what `MongoMeshStore` is
 * for, and this store says as much rather than corrupting quietly.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MemoryMeshStore, type MeshTask, type NodeRecord, type TaskFilter } from './index.js';

export interface FileMeshStoreOptions {
  /** Injected for tests. */
  read?: (file: string) => Promise<string>;
  write?: (file: string, contents: string) => Promise<void>;
  move?: (from: string, to: string) => Promise<void>;
  ensureDir?: (dir: string) => Promise<void>;
  onError?: (message: string) => void;
}

interface Snapshot {
  nodes: NodeRecord[];
  tasks: MeshTask[];
}

export class FileMeshStore extends MemoryMeshStore {
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly read: (file: string) => Promise<string>;
  private readonly write: (file: string, contents: string) => Promise<void>;
  private readonly move: (from: string, to: string) => Promise<void>;
  private readonly ensureDir: (dir: string) => Promise<void>;
  private readonly onError: (message: string) => void;

  constructor(readonly file: string, options: FileMeshStoreOptions = {}) {
    super();
    this.read = options.read ?? ((target) => readFile(target, 'utf8'));
    this.write = options.write ?? ((target, contents) => writeFile(target, contents, 'utf8'));
    this.move = options.move ?? ((from, to) => rename(from, to));
    this.ensureDir = options.ensureDir ?? (async (dir) => void (await mkdir(dir, { recursive: true })));
    this.onError = options.onError ?? (() => {});
  }

  /** Read what is on disk. Safe to call more than once. */
  async open(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await this.read(this.file));
      const snapshot = parsed as Partial<Snapshot>;
      for (const node of snapshot.nodes ?? []) await super.putNode(node);
      for (const task of snapshot.tasks ?? []) await super.putTask(task);
    } catch (error) {
      const message = (error as NodeJS.ErrnoException).code === 'ENOENT' ? '' : (error as Error).message;
      // A queue file that will not parse must not stop the agent starting —
      // but losing the queue silently would be worse, so it is said out loud.
      if (message) this.onError(`the saved queue could not be read (${message}) — starting from an empty one`);
    }
  }

  override async putNode(node: NodeRecord): Promise<void> {
    await super.putNode(node);
    this.persist();
  }

  override async putTask(task: MeshTask): Promise<void> {
    await super.putTask(task);
    this.persist();
  }

  override async claim(taskId: string, expectRev: number, next: MeshTask): Promise<boolean> {
    const won = await super.claim(taskId, expectRev, next);
    if (won) this.persist();
    return won;
  }

  override async listTasks(filter: TaskFilter = {}): Promise<MeshTask[]> {
    return super.listTasks(filter);
  }

  /** Wait for the disk to catch up — used before the process exits. */
  async flush(): Promise<void> {
    await this.writing;
  }

  /**
   * Writes are chained rather than fired in parallel: two overlapping saves
   * can land in either order, and the older one winning would quietly undo
   * the newer state.
   */
  private persist(): void {
    this.writing = this.writing
      .then(async () => {
        const snapshot: Snapshot = { nodes: await super.listNodes(), tasks: await super.listTasks() };
        await this.ensureDir(path.dirname(this.file));
        const temporary = `${this.file}.tmp`;
        await this.write(temporary, JSON.stringify(snapshot, null, 2));
        await this.move(temporary, this.file);
      })
      .catch((error: unknown) => {
        this.onError(`could not save the queue: ${(error as Error).message}`);
      });
  }
}
