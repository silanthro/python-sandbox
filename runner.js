import pyodideModule from "npm:pyodide/pyodide.js";
import { readLines } from "https://deno.land/std@0.186.0/io/mod.ts";
import { join } from "https://deno.land/std@0.186.0/path/mod.ts";

const SHARED_DIR = "./shared";
const VFS_DIR = "/shared";
const pyodide = await pyodideModule.loadPyodide();

function log(...args) {
  console.error("[runner]", ...args); // Log to stderr
}
function output(...args) {
  console.log(...args);
}

log("✅ Pyodide loaded");

const REDIRECT_STDOUT_CODE = `
import sys
import builtins

class RedirectStdout:
    def write(self, s):
        if s.strip():
            builtins.print(s, file=sys.__stderr__)
    def flush(self):
        pass

sys.stdout = RedirectStdout()
`;

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

log("🔧 Installing micropip...");
const originalLog = console.log;
console.log = () => {};
await pyodide.loadPackage("micropip");
console.log = originalLog;
log("✅ Micropip ready");

for await (const line of readLines(Deno.stdin)) {
  log("📩 Received code input");
  let input;
  try {
    input = JSON.parse(line);
    log("🔍 Parsed input:", input);
  } catch (error) {
    log("❌ Invalid JSON input:", error.message);
    continue;
  }

  if (input.shutdown) {
    log("👋 Shutdown requested");
    break;
  }

  try {
    const preamble = REDIRECT_STDOUT_CODE;

    if (Array.isArray(input.packages) && input.packages.length > 0) {
      log("📦 Installing packages:", input.packages);
      const installCode = `
import micropip
await micropip.install(${JSON.stringify(input.packages)})
`;
      await pyodide.runPythonAsync(preamble + installCode);
      log("✅ Packages installed");
    }

    log("🚀 Running user code...");
    const fullCode = preamble + "\n" + (input.code || "");
    log("🧾 Full code to execute:", fullCode);
    const result = await pyodide.runPythonAsync(fullCode);
    output("@@RESULT@@" + JSON.stringify({ output: result }));
    log("✅ Code executed successfully");
  } catch (error) {
    output(
      "@@RESULT@@" +
        JSON.stringify({
          error: error.stack || error.message || "Unknown error",
        })
    );
    log("❌ Execution error stack:", error.stack || error.message);
    output("@@DONE@@");
  }

  // Sync back all new/updated files
  log("🔃 Syncing VFS → host...");
  const filesInShared = pyodide.FS.readdir(VFS_DIR);
  log("📁 VFS contents before sync:", JSON.stringify(filesInShared));

  for (const name of filesInShared) {
    if (name === "." || name === "..") continue;

    const vfsPath = `${VFS_DIR}/${name}`;
    const hostPath = join(SHARED_DIR, name);

    try {
      const stat = pyodide.FS.stat(vfsPath);
      log(`🔍 Checking ${name}: mode=${stat.mode}`);
      if (pyodide.FS.isFile(stat.mode)) {
        const data = pyodide.FS.readFile(vfsPath);
        await Deno.writeFile(hostPath, data);
        log("📤 Synced to host:", name);
      } else {
        log("⚠️ Not a file, skipping:", name);
      }
    } catch (err) {
      log(`❌ Failed to sync ${name}:`, err.message);
    }
  }
  output("@@DONE@@");
}
