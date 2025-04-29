# python-sandbox (WIP)

Basic Python sandbox based on Deno + Pyodide adapted from https://til.simonwillison.net/deno/pyodide-sandbox

This requires the `deno` executable to be available. 

The following environment variables are optional:

- `DENO_PATH`: Path to the deno executable. If not supplied, defaults to "deno".
- `SANDBOX_SHARED_DIR`: Optional path to a local directory that will allow read access from within the sandbox. This directory will be mounted as "/shared" from within the sandbox. If `SANDBOX_ALLOW_WRITE` is set to "True", also allows write access to the shared directory (see next)
- `SANDBOX_ALLOW_WRITE`: If set to "True", allows write access to the shared directory in `SANDBOX_SHARED_DIR`
- `SANDBOX_PACKAGES`: A JSON-encoded list of strings representing any required packages e.g. '["pillow"]' - only supports packages available on [micropip](https://pyodide.org/en/stable/usage/loading-packages.html#micropip)
