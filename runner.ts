import pyodideModule from "npm:pyodide/pyodide.js";
import { readLines } from "https://deno.land/std@0.186.0/io/mod.ts";
import { join } from "https://deno.land/std@0.186.0/path/mod.ts";

import FileSystemHelper from "./filesystem.ts";

const VERBOSE = Deno.env.get("VERBOSE") === "True";
const SHARED_DIR = join(Deno.env.get("SHARED_DIR") as string);
const VFS_DIR = "/shared";
const ALLOW_WRITE =
  (await Deno.permissions.query({ name: "write" })).state === "granted";
const pyodide = await pyodideModule.loadPyodide();

// Log only internal runner state to stderr
function log(...args: string[]) {
  console.error("[runner]", ...args);
}

// FileSystemHelper for syncing
const fsHelper = new FileSystemHelper(
  pyodide,
  SHARED_DIR,
  VFS_DIR,
  log,
  VERBOSE
);

// log("✅ Pyodide loaded");

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
if (sharedFolderExists && SHARED_DIR) {
  pyodide.FS.mkdirTree(VFS_DIR);
  log("🔃 Syncing host files into VFS...");
  await fsHelper.syncIn(SHARED_DIR);
}

// Bootstrap: inject logging setup + print prefix
const PY_SETUP = `
import logging
import builtins
import warnings

# Enable default warning display
warnings.simplefilter("default")
logging.captureWarnings(True)

# Setup basic logging
logging.basicConfig(
    level=logging.INFO,
    format="[log] %(levelname)s: %(message)s"
)

# Override print to prefix and flatten output to one line
def print(*args, **kwargs):
    kwargs.setdefault("flush", True)
    text = " ".join(str(a) for a in args).replace("\\n", "\\\\n")
    builtins.print("[py]", text, **kwargs)
`;

for await (const line of readLines(Deno.stdin)) {
  // log("📩 Received code input");
  let input;
  try {
    input = JSON.parse(line);
    log(`🔍 Parsed input code: ${JSON.stringify(input.code)}`);
  } catch (error) {
    let message;
    if (error instanceof Error) message = error.message;
    else message = String(error);
    console.error("❌ Invalid JSON input:", message);
  }

  if (input.shutdown) {
    log("👋 Shutdown requested");
    break;
  }

  try {
    if (Array.isArray(input.packages) && input.packages.length > 0) {
      // Load micropip silently
      // log("🔧 Installing micropip...");
      const originalConsoleLog = console.log;
      console.log = () => {};
      await pyodide.loadPackage("micropip");
      console.log = originalConsoleLog;
      // log("✅ Micropip ready");

      // log("📦 Installing packages:", input.packages);
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
      // log("✅ Packages installed");
    }

    const fullCode = [PY_SETUP, input.code || ""].join("\n");

    log("Running user code...");
    // log(`🧾 Full code to execute: ${JSON.stringify(fullCode)}`);

    const result = await pyodide.runPythonAsync(fullCode);

    console.log("@@RESULT@@" + JSON.stringify({ output: result }));
    log("✅ Code executed successfully");
  } catch (error) {
    let message;
    if (error instanceof Error) message = error.stack || error.message;
    else message = "Unknown error";
    console.log("@@RESULT@@" + JSON.stringify({ error: message }));
    log("❌ Execution error:", message);
  }

  if (sharedFolderExists && ALLOW_WRITE && SHARED_DIR) {
    log("🔃 Syncing VFS → host...");
    await fsHelper.syncOut(VFS_DIR);
  } else if (!ALLOW_WRITE) {
    log("⚠️ Skipping VFS → host sync because --allow-write was not enabled");
  } else {
    log("⚠️ Skipping VFS → host sync because shared folder is missing");
  }

  console.log("@@DONE@@");
}
