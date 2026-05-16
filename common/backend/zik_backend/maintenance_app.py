"""Maintenance-mode web application (C.32).

Served on port 7071 when the device is booted into the maintenance partition
(systemd.unit=zik-maintenance.target).  Plain HTML — no Lit/Vite needed here.

Three operations:
  POST /fsck        — run e2fsck (root) and f2fsck (data) and stream results.
  POST /reinstall   — call zik-privhelp reinstall.
  POST /reset-pw    — verify recovery phrase, set new admin password via privhelp.
"""

import asyncio
import html
from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Route

from .recovery_phrase import load_stored_hash, verify_phrase

PRIVHELP_BIN = Path("/usr/libexec/zik/zik-privhelp")

# Partition labels as written by build-image.sh.
_ROOT_LABEL = "zik-root"
_DATA_LABEL = "zik-data"

_PAGE = """\
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zik — Maintenance</title>
<style>
  body {{ font-family: sans-serif; max-width: 640px; margin: 3rem auto; color:#222; }}
  h1   {{ color:#b00; }}
  h2   {{ margin-top:2rem; border-bottom:1px solid #ddd; padding-bottom:.4rem; }}
  .warn  {{ background:#fff3cd; border:1px solid #ffc107; padding:.75rem 1rem; border-radius:4px; }}
  .btn   {{ padding:.5rem 1.2rem; border:none; border-radius:4px; cursor:pointer; font-size:1rem; }}
  .btn-danger  {{ background:#dc3545; color:#fff; }}
  .btn-primary {{ background:#0057b8; color:#fff; }}
  input[type=password], input[type=text] {{
    width:100%; padding:.4rem .6rem; border:1px solid #aaa;
    border-radius:4px; font-size:1rem; box-sizing:border-box; margin:.25rem 0;
  }}
  #output {{ background:#111; color:#eee; padding:1rem; border-radius:4px;
             min-height:4rem; font-family:monospace; font-size:.85rem;
             white-space:pre-wrap; margin-top:.75rem; display:none; }}
  .err {{ color:#f55; margin-top:.5rem; min-height:1.2em; font-size:.9rem; }}
</style>
</head>
<body>
<h1>⚠ Zik Maintenance</h1>
<div class="warn">
  You are in maintenance mode. Normal users cannot log in.
  All operations below require physical access to this device.
</div>

<h2>1 — Filesystem check</h2>
<p>Checks and repairs the root (<code>{root}</code>) and data
   (<code>{data}</code>) partitions.</p>
<button class="btn btn-danger" onclick="runAction('/fsck','fsck-out')">
  Run fsck
</button>
<pre id="fsck-out"></pre>

<h2>2 — Reinstall app</h2>
<p>Reinstalls the app from the copy saved in the current release directory
   and restarts the backend.  Use when the app files are corrupt.</p>
<button class="btn btn-primary" onclick="runAction('/reinstall','reinstall-out')">
  Reinstall
</button>
<pre id="reinstall-out"></pre>

<h2>3 — Reset admin password</h2>
<p>Verify your 12-word recovery phrase, then set a new admin password.</p>
<label>Recovery phrase<br>
  <input type="text" id="phrase" placeholder="word1 word2 … word12">
</label><br>
<label>New password (min 8 characters)<br>
  <input type="password" id="pw1">
</label><br>
<label>Confirm new password<br>
  <input type="password" id="pw2">
</label>
<div class="err" id="pw-err"></div>
<button class="btn btn-primary" style="margin-top:.5rem" onclick="resetPw()">
  Reset password
</button>
<pre id="pw-out"></pre>

<script>
async function runAction(url, outId) {{
  const el = document.getElementById(outId);
  el.style.display = 'block';
  el.textContent = 'Running…';
  try {{
    const r = await fetch(url, {{ method:'POST' }});
    const d = await r.json();
    el.textContent = d.output ?? d.error ?? JSON.stringify(d);
  }} catch(e) {{
    el.textContent = 'Network error: ' + e;
  }}
}}

async function resetPw() {{
  const phrase = document.getElementById('phrase').value.trim();
  const pw1 = document.getElementById('pw1').value;
  const pw2 = document.getElementById('pw2').value;
  const err = document.getElementById('pw-err');
  const out = document.getElementById('pw-out');
  err.textContent = '';
  out.style.display = 'none';
  if (!phrase) {{ err.textContent = 'Enter your recovery phrase.'; return; }}
  if (pw1.length < 8) {{ err.textContent = 'Password must be at least 8 characters.'; return; }}
  if (pw1 !== pw2) {{ err.textContent = 'Passwords do not match.'; return; }}
  try {{
    const r = await fetch('/reset-pw', {{
      method: 'POST',
      headers: {{'content-type':'application/json'}},
      body: JSON.stringify({{ phrase, password: pw1 }}),
    }});
    const d = await r.json();
    if (d.ok) {{
      out.style.display = 'block';
      out.textContent = 'Password reset successfully. You may now reboot normally.';
    }} else {{
      err.textContent = d.error ?? 'Unknown error.';
    }}
  }} catch(e) {{
    err.textContent = 'Network error: ' + e;
  }}
}}
</script>
</body>
</html>
"""


def _label_to_dev(label: str) -> str | None:
    """Resolve a filesystem label to a block device path via /dev/disk/by-label/."""
    p = Path(f"/dev/disk/by-label/{label}")
    return str(p.resolve()) if p.exists() else None


async def _run_fsck(dev: str, fs_type: str) -> str:
    """Run the appropriate fsck tool on dev and return combined stdout+stderr."""
    cmd = ["fsck.f2fs", "-a", dev] if fs_type == "f2fs" else ["e2fsck", "-fy", dev]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        return out.decode(errors="replace")
    except FileNotFoundError:
        return f"[fsck tool not found for {fs_type}]"


async def homepage(request: Request) -> HTMLResponse:
    """GET / — serve the maintenance HTML page."""
    root_dev = _label_to_dev(_ROOT_LABEL) or f"LABEL={_ROOT_LABEL}"
    data_dev = _label_to_dev(_DATA_LABEL) or f"LABEL={_DATA_LABEL}"
    body = _PAGE.format(root=html.escape(root_dev), data=html.escape(data_dev))
    return HTMLResponse(body)


async def run_fsck(request: Request) -> JSONResponse:
    """POST /fsck — check and repair root and data partitions."""
    output_lines: list[str] = []

    for label, fs_type in [(_ROOT_LABEL, "ext4"), (_DATA_LABEL, "f2fs")]:
        dev = _label_to_dev(label)
        if dev is None:
            output_lines.append(f"[warning] {label} not found, skipping")
            continue
        output_lines.append(f"--- fsck {dev} ({fs_type}) ---")
        result = await _run_fsck(dev, fs_type)
        output_lines.append(result)

    return JSONResponse({"ok": True, "output": "\n".join(output_lines)})


async def run_reinstall(request: Request) -> JSONResponse:
    """POST /reinstall — reinstall app from current release via privhelp."""
    if not PRIVHELP_BIN.exists():
        return JSONResponse({"error": "privhelp not found"}, status_code=500)
    proc = await asyncio.create_subprocess_exec(
        str(PRIVHELP_BIN), "reinstall",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    output = (stdout + stderr).decode(errors="replace")
    if proc.returncode != 0:
        return JSONResponse({"error": f"reinstall failed:\n{output}"}, status_code=500)
    return JSONResponse({"ok": True, "output": output or "Reinstalled successfully."})


async def reset_password(request: Request) -> JSONResponse:
    """POST /reset-pw — verify recovery phrase and set a new admin password."""
    body = await request.json()
    phrase   = body.get("phrase", "")
    password = body.get("password", "")

    if len(password) < 8:
        return JSONResponse({"error": "Password must be at least 8 characters."}, status_code=422)

    stored_hash = load_stored_hash()
    if stored_hash is None:
        return JSONResponse({"error": "No recovery phrase is set on this device."}, status_code=409)

    if not verify_phrase(phrase, stored_hash):
        return JSONResponse({"error": "Recovery phrase is incorrect."}, status_code=403)

    if not PRIVHELP_BIN.exists():
        return JSONResponse({"error": "privhelp not found"}, status_code=500)

    # Pass new password to privhelp via stdin to avoid cmdline exposure.
    proc = await asyncio.create_subprocess_exec(
        str(PRIVHELP_BIN), "set-admin-password",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate(input=password.encode())
    if proc.returncode != 0:
        return JSONResponse(
            {"error": f"password change failed: {stderr.decode().strip()}"},
            status_code=500,
        )
    return JSONResponse({"ok": True})


app = Starlette(routes=[
    Route("/",          homepage,       methods=["GET"]),
    Route("/fsck",      run_fsck,       methods=["POST"]),
    Route("/reinstall", run_reinstall,  methods=["POST"]),
    Route("/reset-pw",  reset_password, methods=["POST"]),
])
