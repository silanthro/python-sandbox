"""
Python sandbox based on Deno+Pyodide
adapted from
https://til.simonwillison.net/deno/pyodide-sandbox
"""

import json
import os
import queue
import subprocess
import threading
import time


def _read_lines(stream, output_queue):
    for line in iter(stream.readline, ""):
        output_queue.put(line)
    output_queue.put(None)  # Sentinel to signal EOF


def run_code(
    code: str,
    timeout=5,
):
    """
    Runs Python in a sandbox implemented via Deno + Pyodide

    Args:
    - code (str): Python code to run
    - timeout (float): Timeout in seconds

    Returns:
        A generator yielding any logs and a final output {"output": <string representing result of code>}
        Note that this acts like a REPL i.e. the last variable in the code snippet will be returned
    """
    payload = {"code": code}
    shared_dir = os.getenv("SANDBOX_SHARED_DIR")
    packages = json.loads(os.getenv("SANDBOX_PACKAGES", "[]"))
    if packages:
        payload["packages"] = packages

    deno_path = os.getenv("DENO_PATH", "deno")

    command = [deno_path, "run", "--allow-read", "--allow-env"]
    if shared_dir and os.getenv("SANDBOX_ALLOW_WRITE") == "True":
        command.append("--allow-write")
    if packages:
        command.append("--allow-net")
    command.append("runner.js")
    print(command)

    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={"SHARED_DIR": shared_dir} if shared_dir else None,
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
                yield f"[python] {line[4:].strip()}"
            elif line.startswith("[runner]"):
                yield f"[deno log] {line[8:].strip()}"
            elif line.startswith("[log]"):
                yield f"[python log] {line[5:].strip()}"
            else:
                yield f"[stdout] {line.strip()}"

        except queue.Empty:
            pass

        elapsed = time.time() - start
        if elapsed > timeout:
            process.kill()
            yield {"error": "Timeout waiting for code to finish"}
            return

    process.terminate()

    if result_line:
        yield json.loads(result_line)
    else:
        yield {"error": "Execution ended with DONE but no RESULT"}
