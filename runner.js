import pyodideModule from "npm:pyodide/pyodide.js";
import { readLines } from "https://deno.land/std@0.186.0/io/mod.ts";
import { join } from "https://deno.land/std@0.186.0/path/mod.ts";

const SHARED_DIR = Deno.env.get("SHARED_DIR");
const VFS_DIR = "/shared";
const ALLOW_WRITE =
  (await Deno.permissions.query({ name: "write" })).state === "granted";
const pyodide = await pyodideModule.loadPyodide();

// Log only internal runner state to stderr
function log(...args) {
  console.error("[runner]", ...args);
}

log("✅ Pyodide loaded");

let sharedFolderExists = false;
if (SHARED_DIR) {
  try {
    const stat = await Deno.stat(SHARED_DIR);
    sharedFolderExists = stat.isDirectory;
  } catch {
    log(`⚠️ Shared folder "${SHARED_DIR}" not found — skipping sync.`);
  }
} else {
  log("⚠️ No shared folder provided — skipping sync.");
}

// Only sync files if folder exists
if (sharedFolderExists) {
  pyodide.FS.mkdirTree(VFS_DIR);
  log("🔃 Syncing host files into VFS...");

  for await (const entry of Deno.readDir(SHARED_DIR)) {
    if (entry.isFile) {
      const path = join(SHARED_DIR, entry.name);
      const data = await Deno.readFile(path);
      pyodide.FS.writeFile(`${VFS_DIR}/${entry.name}`, data);
      // log("📥 Preloaded:", entry.name);
    }
  }
}

// Bootstrap: inject logging setup + print prefix
const PY_SETUP = `
import logging
import builtins
import warnings

warnings.simplefilter("default")
logging.captureWarnings(True)

logging.basicConfig(
    level=logging.INFO,
    format="[log] %(levelname)s: %(message)s"
)

def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    builtins.print("[py]", *args, **kwargs)
`;

for await (const line of readLines(Deno.stdin)) {
  log("📩 Received code input");
  let input;
  try {
    input = JSON.parse(line);
    log(`🔍 Parsed input: ${JSON.stringify(input)}`);
  } catch (error) {
    console.error("❌ Invalid JSON input:", error.message);
    continue;
  }

  if (input.shutdown) {
    log("👋 Shutdown requested");
    break;
  }

  try {
    if (Array.isArray(input.packages) && input.packages.length > 0) {
      // Load micropip silently
      log("🔧 Installing micropip...");
      const originalConsoleLog = console.log;
      console.log = () => {};
      await pyodide.loadPackage("micropip");
      console.log = originalConsoleLog;
      log("✅ Micropip ready");

      log("📦 Installing packages:", input.packages);
      const installCode = `
import micropip
async def _():
    try:
        await micropip.install(${JSON.stringify(input.packages)})
    except Exception as e:
        import sys
        sys.stderr.write("micropip failed: " + str(e) + "\\n")
        raise
await _()
`;
      await pyodide.runPythonAsync(installCode);
      log("✅ Packages installed");
    }

    const fullCode = [PY_SETUP, input.code || ""].join("\n");

    log("🚀 Running user code...");
    // log(`🧾 Full code to execute: ${JSON.stringify(fullCode)}`);

    const result = await pyodide.runPythonAsync(fullCode);

    console.log("@@RESULT@@" + JSON.stringify({ output: result }));
    log("✅ Code executed successfully");
  } catch (error) {
    const trimmed = error.stack || error.message || "Unknown error";
    console.log("@@RESULT@@" + JSON.stringify({ error: trimmed }));
    log("❌ Execution error:", trimmed);
  }

  if (ALLOW_WRITE && sharedFolderExists) {
    log("🔃 Syncing VFS → host...");
    const files = pyodide.FS.readdir(VFS_DIR);

    for (const name of files) {
      if (name === "." || name === "..") continue;

      const vfsPath = `${VFS_DIR}/${name}`;
      const hostPath = join(SHARED_DIR, name);

      try {
        const stat = pyodide.FS.stat(vfsPath);
        if (pyodide.FS.isFile(stat.mode)) {
          const data = pyodide.FS.readFile(vfsPath);
          await Deno.writeFile(hostPath, data);
          // log("📤 Synced to host:", name);
        } else {
          // log("⚠️ Skipped non-file:", name);
        }
      } catch (err) {
        // console.error(`❌ Failed to sync ${name}:`, err.message);
      }
    }
  } else if (!ALLOW_WRITE) {
    log("⚠️ Skipping VFS → host sync because --allow-write was not enabled");
  } else {
    log("⚠️ Skipping VFS → host sync because shared folder is missing");
  }

  console.log("@@DONE@@");
}
