# BD Automation Suite — Technical Reference & Remediation Record

**Date:** 15–16 August 2026
**Scope:** 8 automations, 2 board recipes, 2 local runners, 2 CRM skills, the Control Centre dashboard, ONBOARDING.md, install.sh
**Status:** all defects below fixed, smoke-tested against live data, and published

---

## 1. Executive summary

The BD Automation Suite worked correctly for exactly one person — its author — and failed for
every external installer. Alex's onboarding was the trigger, but the failure was systemic.

One platform rule explains most of it:

> `{{secret}}` placeholders are substituted **only** into `http_fetch` `url`, `headers` and
> `query`. Never into JavaScript string literals, never into MCP tool arguments, and never
> into an `http_fetch` request body.

Every agent was written as:

```ts
const _ccSecret   = "{{cc_board_id}}";
const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "<author's board uuid>" : _ccSecret;
```

Substitution never happens in a literal, so `startsWith("{{")` was **always true**. The dynamic
branch was dead in every agent and each install silently fell back to the author's own board
UUIDs. Those UUIDs are correct for the author, so everything appeared to work. For anyone else
the agents read boards they had no access to, got nothing back, and continued on hardcoded
defaults.

**Every failure mode was silent.** Nothing errored, nothing alerted, and the agents' own run
status reported "succeeded" throughout.

---

## 2. Verified platform behaviours

Each proven by direct experiment, not read from documentation.

| Behaviour | Evidence |
|---|---|
| `{{secret}}` is NOT substituted in a JS string literal | Provisioner produced `invalid input syntax for type uuid: "{{cc_board_id}}"` |
| `{{secret}}` IS substituted in `http_fetch` url / headers / query | Seven agents now read the CC board this way and resolve correctly |
| `{{secret}}` is NOT substituted in an `http_fetch` body | Echo service received the literal 18-character string `{{apollo_api_key}}` |
| `{{secret}}` cannot reach an MCP tool argument | `act_on_integration` received the literal and returned `invalid input syntax for type uuid` |
| `http_fetch` returns `.body` as raw **text**, `.json` as the parsed object | NewsAPI: `typeof body = string`, `typeof json = object`; `json.articles` length 3, `body.articles` undefined |
| Board rows over REST come back under `.items` | `GET /api/v1/boards/<id>/rows?dataset=meta` returns `{items, page}` |
| `/api/v1/boards/<id>/rows` requires the `dataset` param | Without it: HTTP 400 |
| `install_recipe` is idempotent per `(slug, brain_id)` | Two campaigns received the identical board id |
| `install_recipe` dedup is not keyed on slug alone | A **different** slug still resolved to the existing Control Centre board |
| `install_recipe` returns the entity at `target.id` | Not `board_id`, not `id`, not `result.board_id` |
| `install_recipe` applies the recipe's dashboard to the matched board | An install replaced the live CC dashboard with the recipe's copy |
| `act_on_integration` requires an explicit `install_id` | Omitted and `""` both fail: *"codex path requires install_id + action_name + input together"*. No default-install fallback |
| `create_board` accepts datasets as `data.datasets[name] = {schema:{columns}, rows:[]}` | `schema:{datasets:[…]}` silently produces a bare `default` dataset |
| `run_agent_once` with `verify_mode: true` blocks `act_on_integration` | All probes returned `noop` until the flag was removed — this masks integration results |
| Automation run status is NOT a health signal | The broken provisioner reported `succeeded` on all ~294 runs/day while provisioning nothing |

---

## 3. Defects found and fixed

| # | Component | Defect | Impact | Status |
|---|---|---|---|---|
| 1 | All 8 agents | `{{cc_board_id}}` in a JS literal; dead `cc_setup` branch; hardcoded fallback | Every external install silently operated on the author's boards | Fixed — CC board read over REST |
| 2 | 2B, 2C, 3, 4 | Never read the active campaign's `prospector_board_id` | Agents 1/1.5/2A wrote to the active campaign board while 2B/2C/3/4 read the old one — the pipeline ran split in half for 10 days | Fixed |
| 3 | Board Provisioner | `{{cc_board_id}}` / `{{brain_id}}` literals | Died on its first statement on **every** run since installation; no campaign was ever provisioned | Fixed |
| 4 | Board Provisioner | Read `install_recipe` result from the wrong field | Reported failure after a successful create, leaking a fresh orphan board every 5 minutes | Fixed |
| 5 | Board Provisioner | Used `install_recipe` per campaign | Every campaign received the **same** board — per-campaign isolation collapsed | Fixed — uses `create_board` |
| 6 | `bd-prospector-board` | Template had no datasets or columns | A new user's first board had no `leads` or `outreach_queue` | Fixed — ships real schemas |
| 7 | Agent 1 | Apollo API key in the `http_fetch` **body**, at **both** call sites | Apollo received the literal placeholder and returned 401 on every call | Fixed — moved to `X-Api-Key` header |
| 8 | 2A, 2B, 4 | `{{gmail_install_id}}` literal → always empty | Gmail non-functional: 2B's Sent-scan failed into `catch { return []; }` and reported nothing found, forever | Fixed — resolved at runtime |
| 9 | Agent 2A | NewsAPI parsed from `.body` (raw text) instead of `.json` | News context was never attached to any outreach draft | Fixed |
| 10 | 2C, 2A, 2B, 3, 4 | Unguarded dataset reads | Hard crash on a fresh board lacking a dataset (`unknown dataset: transcript_queue`) | Fixed — first-run guards |
| 11 | 2C, 2B | Wall-clock limits of 60s / 120s | Timeouts on real runs | Raised to 300s |
| 12 | Local runners | Hardcoded board UUID fallbacks; `"using hardcoded defaults"` on error | A new user's runner silently targeted the author's boards | Fixed — abort loudly |
| 13 | Campaign boards | `meta` never seeded | No `telegram_chat_id` → no notifications | Fixed — provisioner seeds it |
| 14 | `leads` schema | `product_use_cases` column undeclared | Written on every run but invisible to projections and dashboards | Fixed — column added |
| 15 | `install.sh` + 2 CRM skills | Author's Prospector **and** CRM board ids embedded; installer patched only one, via an undocumented env var | A new user's skills pointed at the author's boards, one of them deleted | Fixed — skills resolve from the CC board |
| 16 | All 7 agents + both skills | On a newly activated campaign, fell through to `cc_setup.prospector_id` until the provisioner ran | Up to 5 minutes of new-campaign work written into the **previous** campaign's board | Fixed — skip and report |
| 17 | `cc-dashboard.html` | Author's CC board id in the "Create new board" helper prompts | A new user clicking it would write their board ids into the **author's** CC board | Fixed — resolves `window._ccBoardId` at runtime |
| 18 | Board Provisioner | Failure was silent | Ran broken for 10 days reporting "succeeded" | Fixed — Telegram alert, deduped per campaign |

---

## 4. Published inventory

| Recipe slug | Version | Component |
|---|---|---|
| `bd-agent1-prospector` | 14 | Agent 1 — Prospector |
| `bd-agent1-5-research` | 11 | Agent 1.5 — Research Analyst |
| `bd-agent2a-draft` | 11 | Agent 2A — Draft Generator |
| `bd-agent2b-approval` | 10 | Agent 2B — Approval Relay |
| `bd-agent2c-reply` | 9 | Agent 2C — Reply Drafter |
| `bd-agent3-meeting` | 9 | Agent 3 — Meeting Intel |
| `bd-agent4-crm` | 9 | Agent 4 — CRM Updater |
| `bd-board-provisioner` | 10 | Board Provisioner |
| `bd-prospector-board` | 5 | Prospector board template |
| `bd-cc-board` | 22 | Control Centre board + dashboard + 4 skills |

GitHub `matty1335/bd-suite` **main** — runners, CRM skills, `install.sh`, ONBOARDING.md, `verify-suite.py`.

### Two delivery channels — both required

A fix is not live for new users until it reaches the right channel:

| Channel | Carries | Reaches users via |
|---|---|---|
| brains recipes | the 8 agents, `bd-cc-board`, `bd-prospector-board` (incl. the dashboard) | `publish_recipe`; ONBOARDING installs by slug |
| GitHub `main` | local runners, CRM skills, `install.sh` | `REPO_RAW = raw.githubusercontent.com/matty1335/bd-suite/main` |

Publishing a recipe does **not** update existing installs — they stay pinned to the version
they installed.

---

## 5. Architecture

### Board model

| Board | Role |
|---|---|
| Agent Control Centre (CC) | Single source of truth. `meta` holds `cc_setup` (board ids, sender identity, `test_mode`) and `agent_config` (campaigns + `active_campaign_id`) |
| Prospector board | One per campaign. Datasets: `leads`, `outreach_queue`, `meta`, `transcript_queue`, `crm_draft`, `enriched` |
| CRM board | Companies, contacts, meetings |

### Resolution order — identical in all 7 agents, both runners, both skills

1. `{{cc_board_id}}` secret → used **only** inside an `http_fetch` URL
2. `GET /api/v1/boards/{{cc_board_id}}/rows?dataset=meta&limit=50` → rows from `.json.items`
3. `cc_setup.prospector_id` → baseline
4. Active campaign's `prospector_board_id` → **overrides** the baseline
5. Active campaign exists but has **no** board → **stop and report**; never fall back
6. Nothing resolves → log `FATAL` and abort; never fall back to a literal

### Pipeline

```
Agent 1   (nightly)    news + Apollo        -> leads
Agent 1.5 (6-hourly)   Serper research      -> da_research, product_use_cases
Agent 2A  (30 min)     LLM drafts + Gmail   -> outreach_queue (pending_approval)
Agent 2B  (1 min)      Telegram preview,    -> sent / discarded / skipped
                       Gmail Sent scan
Agent 2C  (on demand)  reply drafts         -> outreach_queue
Agent 3   (5 min)      pre-call brief       -> Telegram
Agent 4   (5 min)      transcripts          -> CRM, follow-up chain FU11/12/13
Provisioner (5 min)    new campaign         -> new board + seeded meta + id written back
```

### New-campaign lifecycle

1. Campaign Wizard creates the campaign and reports "prospector board provisioning in ~5 min".
   It does **not** create the board.
2. Agents **pause**, logging why, rather than writing into the previous campaign's board.
3. Provisioner creates the board (schemas cloned from the current prospector board), seeds
   `meta`, writes `prospector_board_id` back into `agent_config`.
4. Every agent and both skills pick it up on their next run. No reinstall.
5. If provisioning fails, one Telegram alert per campaign; the marker clears on success.

### Gmail — hard requirement

Gmail must be connected before installation proceeds; ONBOARDING now gates on it. Agents 2A, 2B
and 4 depend on it and will install cleanly then fail silently without it. The install id is
**not** a secret — each agent resolves it per run via `list_my_integrations`, which is
inherently per-user.

---

## 6. Verification harness

`bd-suite/verify-suite.py` — run before every publish:

```
cd ~/Projects/bd-suite && python3 verify-suite.py     # exit 0 = clean
```

13 targets: 8 agents, 2 local runners, `install.sh`, 2 CRM skills, `cc-dashboard.html`.

1. no hardcoded board UUIDs
2. no `{{secret}}` in a non-URL literal
3. no `{{secret}}` inside an `http_fetch` body
4. no `.body` used as parsed JSON
5. CC board read over REST, rows from `.json.items`
6. active-campaign `prospector_board_id` honoured
7. `app.mybrains.ai` declared in `http_fetch_hosts`

Every rule exists because it caught a real shipped bug. Rule 2 found 7 sites, rule 3 the Apollo
key at 2 sites, rule 4 Agent 2A's NewsAPI parse. **All were missed reading the code manually.**

The harness cannot catch bad credentials or wrong API shapes — those need an actual run.
Smoke-test with `run_agent_once` (`dry_run: true`); `verify_mode: true` blocks
`act_on_integration` and will mask integration results.

---

## 7. Publishing runbook

1. Read the live source with `get_automation`
2. Patch, asserting each replacement matched exactly once
3. `update_agent` — source, grants, `acknowledged_http_fetch_hosts`, caps
4. `run_agent_once` (`dry_run: true`) and read the log — do not skip
5. `python3 verify-suite.py` — must exit 0
6. `publish_recipe` from the live source, asserting no forbidden UUID is present
7. For runners / skills / `install.sh`: merge and push to **main**, then confirm over
   `raw.githubusercontent.com` that the served file is clean

---

## 8. Outstanding owner actions

| # | Item | Detail |
|---|---|---|
| 1 | Rotate `apollo_api_key` | Apollo returns `401 Invalid API key` with the key correctly in a header. Code is fixed; the credential or plan entitlement is not |
| 2 | Set `cc_setup.crm_id` | Currently `1de2a9f5…`, which returns *"board not found or no access"*. Agent 4's CRM writes have nowhere to land. Editable from the Agent Control Centre |
| 3 | Flip `test_mode` to `false` | While `true`, every agent processes only `TEST-` prefixed leads sent to `test_email` |

---

## 9. Test evidence

- Agent 2C: `BOARD_ID=2aa070ec…`, `PRODUCT=mybrains.ai`, exit 0 in 173 ms
- Agents 1, 1.5, 2A, 2B, 3, 4: all resolved the active campaign board, exit 0
- Provisioner: throwaway campaign → board created, `meta` seeded, id written back; `agent_config` restored byte-identical
- Dedup test: two campaigns → two **distinct** boards after the `create_board` fix
- Campaign-switch race: a boardless active campaign made Agent 2C refuse to run rather than use the stale board
- `bd-prospector-board` v5: `leads` 25 cols, `outreach_queue` 22, plus `meta`, `transcript_queue`, `crm_draft`, `enriched`
- Gmail: 2A / 2B / 4 each logged `gmail install: 5df3bf05…` resolved at runtime
- Apollo: `auth/health` 200 with `is_logged_in:false`; `search` 401 `Invalid API key` → credential, not code
- NewsAPI: `json.articles` length 3 vs `body.articles` undefined
- `cc-dashboard.html`: +96 chars, 2 hunks, 0 author UUIDs, `window._ccBoardId` present
- `verify-suite.py`: 13/13 targets pass
- GitHub main: `raw.githubusercontent.com` serves runners, skills and `install.sh` with 0 forbidden UUIDs

---

## 10. Lessons

1. **"Works on my machine" is structurally invisible here.** Every hardcoded fallback was the
   author's own correct value, so the suite passed every check the author could make.
2. **Silence was the real defect.** Swallowed exceptions, `catch { return []; }`, and a run
   status that reports success regardless meant nine months of accumulated breakage surfaced
   only when an outsider installed it.
3. **Reading code did not find these.** Seven `{{secret}}` literal sites, two Apollo body sites
   and the NewsAPI parse were all missed by eye and caught by the harness.
4. **Verify in the right context.** An `act_on_integration` probe run outside the sandbox gave
   the opposite answer to the same probe run inside one.
5. **Two delivery channels means two chances to ship nothing.** Fixes to the runners sat inert
   until they were pushed to `main`, because `install.sh` pulls from GitHub rather than the repo
   working copy.

---

*Remediation record for the 15–16 August 2026 multi-tenancy fix.*
