"""
Python sandbox based on Deno+Pyodide
adapted from
https://til.simonwillison.net/deno/pyodide-sandbox
"""

import json
import queue
import subprocess
import threading
import time


def _read_lines(stream, output_queue):
    for line in iter(stream.readline, ""):
        output_queue.put(line)
    output_queue.put(None)  # Sentinel to signal EOF


def run_code(code_string: str, packages=None, timeout=5):
    payload = {"code": code_string}
    if packages:
        payload["packages"] = packages

    process = subprocess.Popen(
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
        stderr=subprocess.STDOUT,  # Unified stream for live ordered output
        text=True,
        bufsize=1,
    )

    process.stdin.write(json.dumps(payload) + "\n")
    process.stdin.flush()

    output_queue = queue.Queue()
    threading.Thread(
        target=_read_lines, args=(process.stdout, output_queue), daemon=True
    ).start()

    result_line = None
    start = time.time()

    while True:
        try:
            line = output_queue.get(timeout=0.1)

            if line is None:  # EOF sentinel
                break

            if line.startswith("@@RESULT@@"):
                result_line = line.removeprefix("@@RESULT@@").strip()
            elif line.startswith("@@DONE@@"):
                break
            elif line.startswith("[py]"):
                print("[python]", line[4:].strip())
            elif line.startswith("[runner]"):
                print("[deno log]", line[8:].strip())
            elif line.startswith("[log]"):
                print("[python log]", line[5:].strip())
            else:
                print("[stdout]", line.strip())

        except queue.Empty:
            pass

        elapsed = time.time() - start
        if elapsed > timeout:
            process.kill()
            return {"error": "Timeout waiting for code to finish"}

    process.terminate()

    if result_line:
        return json.loads(result_line)
    return {"error": "Execution ended with DONE but no RESULT"}
