#!/usr/bin/env python3
"""
BD Suite invariant check.

Run this before publishing any agent change:

    python3 verify-suite.py

It asserts the defect classes that broke the suite for external users in
Aug 2026, on the LIVE automation sources (which are what gets published):

  1. No hardcoded board UUIDs. Every board id must come from cc_setup or the
     active campaign, never a literal.
  2. No {{secret}} in a non-URL string literal. Placeholders are substituted
     ONLY into http_fetch url / headers / query. A literal like
         const CC = "{{cc_board_id}}"
     reaches the runtime verbatim and fails with
         invalid input syntax for type uuid: "{{cc_board_id}}"
     This single defect made every agent silently fall back to the author's
     own boards -- working perfectly for the author, broken for everyone else.
  3. The CC board is read over REST, parsing rows from `.json.items`
     (NOT .rows, NOT .data.rows -- those fields do not exist on that response).
  4. Board-resolving agents honour the ACTIVE CAMPAIGN's prospector_board_id,
     so multi-campaign installs do not collide on one board.
  5. app.mybrains.ai is declared in http_fetch_hosts wherever the CC read runs.

Exit code 0 = clean, 1 = at least one violation.
"""
import json, os, re, sys, urllib.request

MCP = "https://mcp.mybrains.ai/mcp"
HOOK = os.path.expanduser("~/.claude/hooks/brains-inbox.sh")

# Board ids that must never appear in agent source again.
FORBIDDEN_UUIDS = [
    "2907a47b-b179-452e-b9de-042367012bf0",  # author's Agent Control Centre
    "95dcb668-e2d9-4093-9a3e-3200901846fa",  # author's Ethera Prospector
    "1de2a9f5-03cd-427e-9bb4-9198ed336f62",  # author's (dead) Ethera CRM
]

AGENTS = {
    "agent1-prospector":  "e535386e-50f7-4211-9528-c21c9769f9f4",
    "agent1.5-research":  "758ee276-324f-4285-9236-081c5e60eec2",
    "agent2a-draft":      "c17055be-4f42-4487-8acf-16f3be220bfe",
    "agent2b-approval":   "f363a88a-7c8c-4e74-bb66-229c53b2fd2c",
    "agent2c-reply":      "3966e90e-3ded-48c1-bea6-775597f00843",
    "agent3-meeting":     "ec09efd3-0529-4a79-ac22-f91edb14fb27",
    "agent4-crm":         "b6de2d3f-fa89-4f3c-87df-24b4c2219f91",
    "board-provisioner":  "878acd7c-2bb8-49de-86b8-b492d9807a55",
}

# Agents that resolve a prospector board and so must honour the active campaign.
BOARD_RESOLVERS = {
    "agent1-prospector", "agent1.5-research", "agent2a-draft",
    "agent2b-approval", "agent2c-reply", "agent3-meeting", "agent4-crm",
}

LOCAL_SCRIPTS = ["agent4-local.mjs", "linkedin-runner.mjs"]


def token():
    m = re.search(r'TOKEN=["\']?(brn_[A-Za-z0-9_\-]+)', open(HOOK).read())
    if not m:
        sys.exit(f"no brains token found in {HOOK}")
    return m.group(1)


def call(tok, name, args, timeout=120):
    rpc = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
           "params": {"name": name, "arguments": args}}
    req = urllib.request.Request(
        MCP, data=json.dumps(rpc).encode(),
        headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"}, method="POST")
    raw = urllib.request.urlopen(req, timeout=timeout).read().decode()
    if raw.lstrip().startswith(("event:", "data:")):
        raw = "\n".join(l[6:] for l in raw.splitlines() if l.startswith("data: "))
    d = json.loads(raw)
    if "error" in d:
        raise RuntimeError(d["error"])
    return json.loads(d["result"]["content"][0]["text"])


def secret_in_body_lines(src):
    """{{secret}} inside an http_fetch body is silently NOT substituted -- the request
    goes out carrying the literal placeholder. Verified against an echo service: the
    body arrives containing the raw 18-char string. This is how Apollo received
    "{{apollo_api_key}}" as its API key and returned 401 on every call for months.
    Keys belong in headers or the query string."""
    out = []
    body_arg = re.compile(r"\bbody(?:_json|_text)?\s*:")
    for i, line in enumerate(src.split("\n"), 1):
        if "{{" not in line:
            continue
        if line.lstrip().startswith(("//", "*", "/*")):
            continue
        m = body_arg.search(line)
        if not m:
            continue
        # only a placeholder appearing AFTER the body: argument is in the body
        if "{{" not in line[m.end():]:
            continue
        out.append((i, line.strip()[:110]))
    return out


def body_as_json_lines(src):
    """http_fetch returns `body` as raw TEXT and `json` as the parsed object.
    Casting `.body` to an object and reading a field yields undefined silently --
    no error, just an empty result forever. Agent 2A read newsapi via `nr.body`
    and its news enrichment never once populated. Always parse from `.json`."""
    pat = re.compile(r"\b\w+\.body\s+as\b|\b\w+\.body\?\.\w+")
    return [(i, l.strip()[:110]) for i, l in enumerate(src.split("\n"), 1)
            if pat.search(l) and not l.lstrip().startswith(("//", "*", "/*"))]


def bad_placeholder_lines(src):
    """{{secret}} is fine inside a URL (substituted at fetch time) and in
    Authorization headers. Anywhere else it is a latent uuid-literal bug."""
    out = []
    for i, line in enumerate(src.split("\n"), 1):
        if "{{" not in line:
            continue
        if "http" in line or "Authorization" in line or "headers" in line:
            continue
        if line.lstrip().startswith(("//", "*", "/*")):
            continue
        out.append((i, line.strip()[:110]))
    return out


def main():
    tok = token()
    here = os.path.dirname(os.path.abspath(__file__))
    failures = []

    for name, aid in AGENTS.items():
        try:
            d = call(tok, "get_automation", {"automation_id": aid})
        except Exception as e:
            failures.append(f"{name}: could not read source -- {str(e)[:100]}")
            continue
        src, hosts = d["source"], d.get("http_fetch_hosts", [])
        problems = []

        for u in FORBIDDEN_UUIDS:
            if u in src:
                problems.append(f"hardcoded board uuid {u[:8]}")

        for ln, text in bad_placeholder_lines(src):
            problems.append(f"{{{{secret}}}} in non-URL literal at line {ln}: {text}")

        for ln, text in body_as_json_lines(src):
            problems.append(f"http_fetch .body used as parsed JSON at line {ln} "
                            f"(body is raw text -- use .json): {text}")

        for ln, text in secret_in_body_lines(src):
            problems.append(f"{{{{secret}}}} in an http_fetch BODY at line {ln} "
                            f"(never substituted -- move it to a header): {text}")

        if "boards/{{cc_board_id}}/rows" not in src:
            problems.append("CC board is not read over REST /boards/{{cc_board_id}}/rows")
        if "json?.items" not in src and "json.items" not in src:
            problems.append("CC rows not parsed from .json.items")
        if "app.mybrains.ai" not in hosts:
            problems.append("app.mybrains.ai missing from http_fetch_hosts")
        if name in BOARD_RESOLVERS and "prospector_board_id" not in src:
            problems.append("does not honour active campaign prospector_board_id")

        status = "PASS" if not problems else "FAIL"
        print(f"[{status}] {name} (v{d['version']['number']})")
        for p in problems:
            print(f"         - {p}")
            failures.append(f"{name}: {p}")

    for fn in LOCAL_SCRIPTS:
        path = os.path.join(here, fn)
        if not os.path.exists(path):
            print(f"[SKIP] {fn} (not found)")
            continue
        src = open(path).read()
        problems = [f"hardcoded board uuid {u[:8]}" for u in FORBIDDEN_UUIDS if u in src]
        if "using hardcoded defaults" in src:
            problems.append("falls back to hardcoded defaults instead of aborting")
        print(f"[{'PASS' if not problems else 'FAIL'}] {fn}")
        for p in problems:
            print(f"         - {p}")
            failures.append(f"{fn}: {p}")

    print()
    if failures:
        print(f"{len(failures)} violation(s) -- DO NOT PUBLISH")
        return 1
    print("All invariants hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
