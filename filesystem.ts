import pyodideModule from "npm:pyodide/pyodide.js";
import { join } from "https://deno.land/std@0.186.0/path/mod.ts";

export default class FileSystemHelper {
  pyodide: pyodideModule.PyodideInterface;
  SHARED_DIR: string;
  VFS_DIR: string;
  log: (...args: string[]) => void;
  before: { [k: string]: "dir" | Uint8Array } = {};
  after: { [k: string]: "dir" | Uint8Array } = {};
  verbose: boolean;

  constructor(
    pyodide: pyodideModule.PyodideInterface,
    SHARED_DIR: string,
    VFS_DIR: string,
    log: (...args: string[]) => void,
    verbose: boolean = false
  ) {
    this.pyodide = pyodide;
    this.SHARED_DIR = SHARED_DIR;
    this.VFS_DIR = VFS_DIR;
    this.log = log;
    this.verbose = verbose;
  }

  snapshotVFS() {
    if (this.verbose) this.log("Taking snapshot");
    const contents = {} as { [k: string]: "dir" | Uint8Array };

    const listDirRecursive = (path: string) => {
      try {
        const entries = this.pyodide.FS.readdir(path);
        for (const entry of entries) {
          if ([".", ".."].includes(entry)) continue;
          const fullPath = join(path, entry);
          const stats = this.pyodide.FS.stat(fullPath);
          if (this.pyodide.FS.isDir(stats.mode)) {
            contents[fullPath] = "dir";
            listDirRecursive(fullPath);
          } else {
            contents[fullPath] = this.pyodide.FS.readFile(fullPath);
          }
        }
      } catch (e) {
        console.warn(`Error reading ${path}:`, e);
      }
    };

    listDirRecursive(this.VFS_DIR);
    return contents;
  }

  _areEqualBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  diffVFS() {
    const changes = {
      added: [] as string[],
      modified: [] as string[],
      deleted: [] as string[],
    };
    const allKeys = new Set([
      ...Object.keys(this.before),
      ...Object.keys(this.after),
    ]);
    for (const key of allKeys) {
      if (!(key in this.before)) changes.added.push(key);
      else if (!(key in this.after)) changes.deleted.push(key);
      else if (
        this.before[key] !== "dir" &&
        this.after[key] !== "dir" &&
        !this._areEqualBytes(this.before[key], this.after[key])
      )
        changes.modified.push(key);
    }
    return changes;
  }

  async syncIn(localFolder: string) {
    if (this.verbose) this.log(`Syncing in folder: ${localFolder}`);
    for await (const entry of Deno.readDir(localFolder)) {
      const path = join(localFolder, entry.name);
      if ([".", ".."].includes(entry.name)) {
        continue;
      } else if (entry.isFile) {
        const data = await Deno.readFile(path);
        if (this.verbose)
          this.log(
            `Syncing in file: ${path.replace(this.SHARED_DIR, this.VFS_DIR)}`
          );
        this.pyodide.FS.writeFile(
          path.replace(this.SHARED_DIR, this.VFS_DIR),
          data
        );
      } else {
        this.pyodide.FS.mkdirTree(path);
        await this.syncIn(path);
      }
    }
    // Take a snapshot for diffing later
    this.before = this.snapshotVFS();
  }

  async syncOutHelper(mountedFolder: string, toSync: string[]) {
    if (this.verbose) this.log(`Syncing out folder: ${mountedFolder}`);
    const paths = this.pyodide.FS.readdir(mountedFolder);
    for (const name of paths) {
      if ([".", ".."].includes(name)) continue;

      const vfsPath = join(mountedFolder, name);
      const hostPath = vfsPath.replace(this.VFS_DIR, this.SHARED_DIR);

      try {
        const stat = this.pyodide.FS.stat(vfsPath);
        if (this.pyodide.FS.isFile(stat.mode)) {
          if (!toSync.includes(vfsPath)) continue;
          const data = this.pyodide.FS.readFile(vfsPath);
          if (this.verbose) this.log(`Syncing out file: ${hostPath}`);
          await Deno.writeFile(hostPath, data);
        } else {
          if (toSync.includes(vfsPath)) {
            await Deno.mkdir(hostPath);
          }
          await this.syncOutHelper(vfsPath, toSync);
        }
      } catch (error) {
        let message;
        if (error instanceof Error) message = error.message;
        else message = String(error);
        console.error(`❌ Failed to sync ${name}:`, message);
      }
    }
  }

  async syncOut(mountedFolder: string) {
    this.after = this.snapshotVFS();
    const diff = this.diffVFS();
    this.log(`Sync diff: ${JSON.stringify(diff)}`);

    const toSync = diff.added.concat(diff.modified);

    await this.syncOutHelper(mountedFolder, toSync);

    for (let i = 0; i < diff.deleted.length; i++) {
      const path = diff.deleted[i];
      await Deno.remove(path.replace(this.VFS_DIR, this.SHARED_DIR));
    }
  }
}
