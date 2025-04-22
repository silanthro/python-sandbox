import pyodideModule from "npm:pyodide/pyodide.js";
import { readLines } from "https://deno.land/std@0.186.0/io/mod.ts";
import { join } from "https://deno.land/std@0.186.0/path/mod.ts";

const SHARED_DIR = "./shared";
const VFS_DIR = "/shared";
const pyodide = await pyodideModule.loadPyodide();

// Log only internal runner state to stderr
function log(...args) {
  console.error("[runner]", ...args);
}

log("✅ Pyodide loaded");

// Set up shared folder
pyodide.FS.mkdirTree(VFS_DIR);
log("🔃 Syncing host files into VFS...");

for await (const entry of Deno.readDir(SHARED_DIR)) {
  if (entry.isFile) {
    const path = join(SHARED_DIR, entry.name);
    const data = await Deno.readFile(path);
    pyodide.FS.writeFile(`${VFS_DIR}/${entry.name}`, data);
    log("📥 Preloaded:", entry.name);
  }
}

// Bootstrap: inject logging setup + print prefix
const PY_SETUP = `
import logging
import builtins

logging.basicConfig(
    level=logging.INFO,
    format="[log] %(levelname)s: %(message)s"
)

def print(*args, **kwargs):
    builtins.print("[py]", *args, **kwargs)
`;

for await (const line of readLines(Deno.stdin)) {
  log("📩 Received code input");
  let input;
  try {
    input = JSON.parse(line);
    log("🔍 Parsed input:", input);
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
    log("🧾 Full code to execute:\n" + fullCode);

    const result = await pyodide.runPythonAsync(fullCode);

    console.log("@@RESULT@@" + JSON.stringify({ output: result }));
    log("✅ Code executed successfully");
  } catch (error) {
    const trimmed = error.stack || error.message || "Unknown error";
    console.log("@@RESULT@@" + JSON.stringify({ error: trimmed }));
    log("❌ Execution error:", trimmed);
  }

  // Sync files from VFS → host
  log("🔃 Syncing VFS → host...");
  const files = pyodide.FS.readdir(VFS_DIR);
  log("📁 VFS contents before sync:", files);

  for (const name of files) {
    if (name === "." || name === "..") continue;

    const vfsPath = `${VFS_DIR}/${name}`;
    const hostPath = join(SHARED_DIR, name);

    try {
      const stat = pyodide.FS.stat(vfsPath);
      if (pyodide.FS.isFile(stat.mode)) {
        const data = pyodide.FS.readFile(vfsPath);
        await Deno.writeFile(hostPath, data);
        log("📤 Synced to host:", name);
      } else {
        log("⚠️ Skipped non-file:", name);
      }
    } catch (err) {
      console.error(`❌ Failed to sync ${name}:`, err.message);
    }
  }

  console.log("@@DONE@@");
}
