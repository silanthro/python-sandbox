import pyodideModule from "npm:pyodide/pyodide.js";
import {
  dirname,
  join,
  relative,
  resolve,
  isAbsolute,
} from "https://deno.land/std@0.186.0/path/mod.ts";

function assertWithin(base: string, target: string, label: string): void {
  const baseResolved = resolve(base);
  const targetResolved = resolve(join(baseResolved, target));
  // const rel = relative(baseResolved, targetResolved);

  const isInside =
    targetResolved === baseResolved ||
    targetResolved.startsWith(baseResolved + "/") ||
    targetResolved.startsWith(baseResolved + "\\");

  if (!isInside) {
    throw new Error(`❌ Invalid ${label}: "${target}" is outside of "${base}"`);
  }
}

export default class FileSystemHelper {
  pyodide: pyodideModule.PyodideInterface;
  SHARED_DIR: string;
  VFS_DIR: string;
  log: (...args: string[]) => void;
  before: { [k: string]: "dir" | Uint8Array } = {};
  after: { [k: string]: "dir" | Uint8Array } = {};
  verbose: boolean;
  syncInPaths: string[] | undefined;
  syncOutPaths: string[] | undefined;

  constructor(
    pyodide: pyodideModule.PyodideInterface,
    SHARED_DIR: string,
    VFS_DIR: string,
    log: (...args: string[]) => void,
    verbose: boolean = false,
    syncInPaths: string[],
    syncOutPaths: string[]
  ) {
    this.pyodide = pyodide;
    this.SHARED_DIR = SHARED_DIR;
    this.VFS_DIR = VFS_DIR;
    this.log = log;
    this.verbose = verbose;
    // 🔐 Normalize and validate syncInPaths
    if (syncInPaths) {
      this.syncInPaths = syncInPaths.map((p) => {
        const rel = isAbsolute(p) ? relative(SHARED_DIR, p) : p;
        console.log(isAbsolute(p));
        console.log(rel);
        assertWithin(SHARED_DIR, rel, "syncInPath");
        return rel;
      });
    }
    // 🔐 Normalize and validate syncOutPaths
    if (syncOutPaths) {
      this.syncOutPaths = syncOutPaths.map((p) => {
        const rel = p.startsWith(VFS_DIR) ? relative(VFS_DIR, p) : p;
        assertWithin(VFS_DIR, rel, "syncOutPath");
        return rel;
      });
    }
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

  async syncInHelper(localFolder?: string) {
    if (!localFolder) {
      if (this.verbose) this.log("Syncing specific files");

      for (const relativePath of this.syncInPaths || []) {
        const localPath = join(this.SHARED_DIR, relativePath);
        const vfsPath = join(this.VFS_DIR, relativePath);

        try {
          const stat = await Deno.stat(localPath);
          if (stat.isFile) {
            const data = await Deno.readFile(localPath);
            this.pyodide.FS.mkdirTree(dirname(vfsPath)); // Ensure parent dirs exist
            this.pyodide.FS.writeFile(vfsPath, data);
            if (this.verbose) this.log(`✅ Synced file: ${relativePath}`);
          } else if (stat.isDirectory) {
            this.pyodide.FS.mkdirTree(vfsPath);
            if (this.verbose) this.log(`📁 Created dir: ${relativePath}`);
            await this.syncInHelper(localPath); // Recursively sync folder contents
          }
        } catch (err) {
          this.log(
            `❌ Failed to sync ${relativePath}: ${(err as Error).message}`
          );
        }
      }
    } else {
      if (this.verbose) this.log(`Syncing entire folder: ${localFolder}`);
      for await (const entry of Deno.readDir(localFolder)) {
        const localPath = join(localFolder, entry.name);
        const vfsPath = localPath.replace(this.SHARED_DIR, this.VFS_DIR);

        if ([".", ".."].includes(entry.name)) continue;

        if (entry.isFile) {
          const data = await Deno.readFile(localPath);
          this.pyodide.FS.mkdirTree(dirname(vfsPath));
          this.pyodide.FS.writeFile(vfsPath, data);
          if (this.verbose) this.log(`✅ Synced file: ${entry.name}`);
        } else if (entry.isDirectory) {
          this.pyodide.FS.mkdirTree(vfsPath);
          await this.syncInHelper(localPath); // recurse
        }
      }
    }
  }

  async syncIn() {
    if (this.syncInPaths) {
      await this.syncInHelper();
    } else {
      await this.syncInHelper(this.SHARED_DIR);
    }
    // Take a snapshot for diffing later
    this.before = this.snapshotVFS();
  }

  private expandVfsFoldersToFiles(paths: string[]): string[] {
    const expanded: string[] = [];

    for (const path of paths) {
      const fullPath = isAbsolute(path) ? path : join(this.VFS_DIR, path);

      try {
        const stat = this.pyodide.FS.stat(fullPath);
        if (this.pyodide.FS.isFile(stat.mode)) {
          expanded.push(relative(this.VFS_DIR, fullPath));
        } else if (this.pyodide.FS.isDir(stat.mode)) {
          const entries = this.pyodide.FS.readdir(fullPath);
          for (const name of entries) {
            if ([".", ".."].includes(name)) continue;
            const sub = join(fullPath, name);
            const subRel = relative(this.VFS_DIR, sub);
            expanded.push(...this.expandVfsFoldersToFiles([subRel]));
          }
        }
      } catch (e) {
        if (this.verbose)
          this.log(`⚠️ Skipping ${path}: ${(e as Error).message}`);
      }
    }

    return expanded;
  }

  async syncOutHelper(currentVfsDir: string, toSync: string[]) {
    if (this.verbose) this.log(`🔃 Syncing out from: ${currentVfsDir}`);

    const entries = this.pyodide.FS.readdir(currentVfsDir);
    for (const name of entries) {
      if ([".", ".."].includes(name)) continue;

      const vfsPath = join(currentVfsDir, name);
      const relativePath = relative(this.VFS_DIR, vfsPath);
      const hostPath = join(this.SHARED_DIR, relativePath);

      try {
        const stat = this.pyodide.FS.stat(vfsPath);

        if (this.pyodide.FS.isFile(stat.mode)) {
          if (!toSync.includes(relativePath)) continue;

          const data = this.pyodide.FS.readFile(vfsPath);
          await Deno.mkdir(dirname(hostPath), { recursive: true });
          await Deno.writeFile(hostPath, data);

          if (this.verbose) this.log(`✅ Synced file: ${relativePath}`);
        } else if (this.pyodide.FS.isDir(stat.mode)) {
          // Only recurse if at least one toSync path is inside this folder
          const hasChildren = toSync.some((p) =>
            p.startsWith(relativePath + "/")
          );
          if (hasChildren) {
            await this.syncOutHelper(vfsPath, toSync);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ Failed to sync ${relativePath}:`, message);
      }
    }
  }

  async syncOut(mountedFolder: string) {
    this.after = this.snapshotVFS();
    const diff = this.diffVFS();
    this.log(`Sync diff: ${JSON.stringify(diff)}`);

    // Combine added + modified
    const changed = diff.added
      .concat(diff.modified)
      .map((p) => (isAbsolute(p) ? relative(this.VFS_DIR, p) : p));

    let toSync: string[];

    if (this.syncOutPaths) {
      const normalized = this.syncOutPaths.map((p) =>
        isAbsolute(p) ? relative(this.VFS_DIR, p) : p
      );

      const expanded = this.expandVfsFoldersToFiles(normalized);
      toSync = changed.filter((p) => expanded.includes(p));
    } else {
      toSync = changed;
    }

    await this.syncOutHelper(mountedFolder, toSync);

    // Handle deletions
    for (const deletedPath of diff.deleted) {
      const rel = isAbsolute(deletedPath)
        ? relative(this.VFS_DIR, deletedPath)
        : deletedPath;

      if (this.syncOutPaths) {
        const normalized = this.syncOutPaths.map((p) =>
          isAbsolute(p) ? relative(this.VFS_DIR, p) : p
        );
        const expanded = this.expandVfsFoldersToFiles(normalized);
        if (!expanded.includes(rel)) continue;
      }

      const hostPath = join(this.SHARED_DIR, rel);
      try {
        await Deno.remove(hostPath);
        if (this.verbose) this.log(`🗑️ Deleted: ${rel}`);
      } catch (e) {
        this.log(`⚠️ Failed to delete ${hostPath}: ${(e as Error).message}`);
      }
    }
  }
}
