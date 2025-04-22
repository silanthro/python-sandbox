"""
Python sandbox adapted from
https://til.simonwillison.net/deno/pyodide-sandbox
"""

import json
import selectors
import subprocess
import threading

# Persistent global handle to the Deno subprocess
deno_process = None
selector = selectors.DefaultSelector()
lock = threading.Lock()  # To guard concurrent writes/reads


def start_deno_process():
    global deno_process
    deno_process = subprocess.Popen(
        [
            "deno",
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-net",
            "runner.js",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,  # line buffered
    )
    selector.register(deno_process.stdout, selectors.EVENT_READ)
    selector.register(deno_process.stderr, selectors.EVENT_READ)


def run_code(code_string: str, packages=None):
    global deno_process
    with lock:
        if deno_process is None or deno_process.poll() is not None:
            start_deno_process()

        payload = {
            "code": code_string,
        }
        if packages:
            payload["packages"] = packages

        # Send payload to Deno subprocess
        deno_process.stdin.write(json.dumps(payload) + "\n")
        deno_process.stdin.flush()

        result_line = None

        while True:
            for key, _ in selector.select(timeout=5):
                line = key.fileobj.readline()
                if not line:
                    continue

                if key.fileobj == deno_process.stderr:
                    if line.startswith("[log]"):
                        print("[python log]", line[5:].strip())
                    else:
                        print("[deno log]", line.strip())

                elif key.fileobj == deno_process.stdout:
                    if line.startswith("@@RESULT@@"):
                        result_line = line.removeprefix("@@RESULT@@").strip()
                    elif line.startswith("@@DONE@@"):
                        if result_line:
                            return json.loads(result_line)
                        else:
                            return {"error": "Execution ended with DONE but no RESULT"}
                    elif line.startswith("[py]"):
                        print("[python]", line[4:].strip())
                    else:
                        print("[stdout]", line.strip())
