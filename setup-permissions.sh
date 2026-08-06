#!/usr/bin/env bash
# BD Suite — Grant Claude Code permissions for Brains MCP
# Idempotent. Safe to run multiple times.
set -e

echo ""
echo "BD Suite — Permissions Setup"
echo "============================"
echo ""

python3 - <<'PYEOF'
import json, os, sys

path = os.path.expanduser("~/.claude/settings.json")
to_add = ["mcp__brains__*", "mcp__claude_ai_Brains__*"]

if os.path.exists(path):
    with open(path) as f:
        try:
            s = json.load(f)
        except Exception:
            s = {}
else:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    s = {}

s.setdefault("permissions", {}).setdefault("allow", [])

added = []
for p in to_add:
    if p not in s["permissions"]["allow"]:
        s["permissions"]["allow"].append(p)
        added.append(p)

with open(path, "w") as f:
    json.dump(s, f, indent=2)

if added:
    print(f"[OK] Granted permissions: {', '.join(added)}")
else:
    print("[OK] Brains permissions already set -- nothing to do")
PYEOF

echo ""
echo "Done. Open Claude Code and paste your onboarding link to continue."
echo ""
