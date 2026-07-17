#!/bin/sh
# Tildone — live agent presence.
#
# Installed by Tildone (Settings → Agent access → Connect Claude Code) and removed by
# Disconnect. Safe to delete by hand; the board simply falls back to showing the age
# of your last write.
#
# Reports this session's state to Tildone so its board can show, truthfully, whether
# an agent is working on a task right now. Called by Claude Code hooks:
#
#   PreToolUse       -> working    (fires on every tool call: the actual pulse)
#   PermissionRequest-> blocked    (waiting on the human)
#   Stop             -> idle       (turn ended)
#   SessionEnd       -> idle       (prompt decay; never trusted on its own)
#
# THIS SCRIPT MUST NEVER BLOCK AND MUST ALWAYS EXIT 0.
# It runs before every single tool call. A hook that hangs or fails stalls Claude's
# agentic loop, and no presence dot is worth that. Every failure path below is
# deliberately silent.
#
# Nothing here is trusted as a death signal. SessionEnd does not fire on a crash, a
# kill -9, or a closed terminal — and background sessions outlive their terminal
# anyway. Tildone decides liveness by checking whether the process is still there.

set -u

action="${1:-}"
case "$action" in
  working|idle|blocked) ;;
  *) exit 0 ;;
esac

# The port is a contract: 11502 belongs to the INSTALLED Tildone. A dev build binds a
# random port and deliberately never receives these beats.
port="${TILDONE_AGENT_PORT:-11502}"

# Claude Code delivers the hook payload as JSON on stdin.
payload="$(cat 2>/dev/null || true)"
[ -n "$payload" ] || exit 0

# python3 parses the payload, and that is worth its ~30ms over a sed/curl version.
#
# The payload embeds `tool_input`, so a grep/sed for "session_id" can match a NESTED
# one and report the wrong session. This is not hypothetical: Tildone's own
# update_task takes a session_id param, so every time an agent claims a task the
# payload contains an unescaped "session_id" inside tool_input, and a greedy pattern
# picks THAT one. Measured: a sed version reports the tool argument instead of the
# real session — corrupting presence in exactly the case this feature exists to serve.
# A real JSON parse reads the top-level key and cannot be fooled.
#
# If python3 is missing, report nothing. Presence degrades to the age of the last
# board write, which is what it was before this existed.
command -v python3 >/dev/null 2>&1 || exit 0

TILDONE_ACTION="$action" TILDONE_PORT="$port" TILDONE_PAYLOAD="$payload" \
TILDONE_PPID="$PPID" python3 - <<'PY' 2>/dev/null || true
import json
import os
import urllib.request

try:
    payload = json.loads(os.environ.get("TILDONE_PAYLOAD") or "{}")
except Exception:
    raise SystemExit(0)

session_id = payload.get("session_id")
if not isinstance(session_id, str) or not session_id.strip():
    raise SystemExit(0)

action = os.environ.get("TILDONE_ACTION", "")

# $PPID is the claude session process itself — Claude Code spawns hook commands
# directly, with no intervening wrapper. Do NOT walk further up the process tree: the
# grandparent is the background-job daemon SHARED by every session on the machine, and
# keying liveness on it would make every card look alive whenever any one session did.
try:
    pid = int(os.environ.get("TILDONE_PPID") or 0) or None
except ValueError:
    pid = None

body = {
    "session_id": session_id.strip(),
    "state": action,
    "pid": pid,
    # Present only for a subagent's tool call. Tildone uses it to ignore a subagent's
    # `idle`: a subagent finishing is not the parent finishing.
    "agent_id": payload.get("agent_id"),
}

req = urllib.request.Request(
    f"http://127.0.0.1:{os.environ.get('TILDONE_PORT')}/heartbeat",
    data=json.dumps(body).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    # Short timeout, result ignored. Tildone may be closed, mid-restart, or not
    # listening — all normal, none of them this script's problem.
    urllib.request.urlopen(req, timeout=0.5).close()
except Exception:
    pass
PY

exit 0
