---
name: crm-import-from-prospector
description: "Import selected leads from the Ethera Prospector board into the CRM board. Use when someone says 'import from prospector', 'push to CRM', 'move to CRM', 'graduate to CRM', or 'promote from prospector'."
---

# /crm:import-from-prospector

Interactively select leads from the Prospector board and import them into the CRM board.

**Control Centre board ID:** `__CC_BOARD_ID__`

## Step 0 -- Resolve the boards (do this first)

Never hardcode a board id. Board ids differ per user and per campaign, so read
them from the Control Centre board every time:

1. `mcp__brains__get_board` -> board `__CC_BOARD_ID__`, dataset `meta`, limit 50
2. From the `cc_setup` row (JSON in `value`): take `prospector_id` and `crm_id`
3. From the `agent_config` row: find the campaign whose `id` equals
   `active_campaign_id`. If it has a non-empty `prospector_board_id`, that
   **overrides** `prospector_id`.

   If the active campaign exists but has **no** `prospector_board_id`, **stop**:

   > "Your active campaign '<name>' does not have a prospector board yet. The
   > board provisioner creates one within about 5 minutes of a campaign being
   > added. Wait a moment and run this again."

   Do **not** fall through to `cc_setup.prospector_id` here. That id belongs to
   the *previous* campaign, and using it would import this campaign's leads into
   the last campaign's board -- silently, with no error
4. **Verify both boards are reachable** -- call `mcp__brains__get_board` on each id
   (metadata only, no dataset). An id can be present in `cc_setup` and still be
   dead: deleted, or in a brain you no longer have access to
5. **Announce what you resolved, before touching any data** -- print this every
   time the skill runs, not just the first run of a session:

```
Active campaign : <campaign name>  (<active_campaign_id>)
Prospector board: <board name>     (<id>)   [from campaign | from cc_setup]
CRM board       : <board name>     (<id>)
```

Mark the Prospector line `[from campaign]` when the active campaign supplied
`prospector_board_id`, or `[from cc_setup]` when it fell back to the default.

Campaign switches are silent. Someone who started a new campaign yesterday gets a
different Prospector board today, and without that line they would not notice
until leads landed somewhere unexpected.

If the user says that is the wrong campaign, **stop**. They change
`active_campaign_id` in the Agent Control Centre and the skill picks it up on the
next run, no reinstall. Do not let them override a board id inline -- that
reintroduces exactly the hardcoding this design removes.

If either check in step 4 fails, stop and say which board and why:

- id missing from `cc_setup` -> "Your Control Centre board has no `crm_id` set.
  Open the Agent Control Centre and fill it in."
- id present but `get_board` fails -> "Your `cc_setup.crm_id` points at `<id>`,
  which returns 'board not found or no access'. That board no longer exists --
  update `crm_id` in the Agent Control Centre to your current CRM board."

Never fall back to a default or a remembered id. A wrong board silently writes one
user's leads into another user's CRM.

Everything below refers to the resolved boards as **the Prospector board** and
**the CRM board**.

## Workflow

### Step 1 — Fetch leads from the Prospector board

Call `mcp__brains__get_board` with:
- `board_id`: the Prospector board id from Step 0
- `dataset`: `leads`
- `limit`: 1000

Filter to leads where `outreach_status` is NOT `"Imported to CRM"` (skip already-imported ones).

### Step 2 — Display the selector

Present leads as a numbered table. Group by status for clarity. Example format:

```
Prospector leads available to import:

 #  Name                    Company         Position                        Status
──  ──────────────────────  ──────────────  ──────────────────────────────  ──────────────
 1  Zach Abrams             Open Standard   Founding CEO                    New
 2  Tom Adams               Adyen           CTO                             New
 3  Samara Cohen            BlackRock       Global Head of Market Dev       Enriched
 4  Michael Shaulov         Fireblocks      CEO                             Contacted
...

Select leads to import:
  • Numbers: 1, 3, 5
  • Range: 1-5
  • All: all
  • By company: "all BlackRock"
  • Or name specific ones
```

### Step 3 — Confirm selection

After the user selects, echo back the names + companies and ask: "Import these N leads to CRM?"

Wait for confirmation before writing anything.

### Step 4 — Import to CRM board

For each confirmed lead:

#### 4a — Check for duplicates
Call `mcp__brains__get_board` on the CRM board (dataset `leads`, limit 1000).
Match by name (case-insensitive). If a match exists, skip that lead and tell the user.

#### 4b — Resolve or create company
- Search CRM board companies dataset for a matching company name (case-insensitive).
- If found: use that company's `row_id` as `company_id`.
- If not found: create a new company via `mcp__brains__append_board_rows` on the CRM board companies dataset:
  - `name`: company name from prospector
  - `type`: infer from context (Bank, Crypto Institution, Fintech, VC, TradFi Infra, Issuer) — use the prospector lead's notes as a signal
  - `status`: "Viable lead"
  - `assigned_to`: logged-in user
  - `notes`: "Imported from Prospector board. Source: <article_url>"

#### 4c — Generate lead ID
Read CRM board leads dataset, find the highest existing `row_id` with pattern `LD-NNNN`, increment by 1.

#### 4d — Append lead to CRM board
Call `mcp__brains__append_board_rows` on the CRM board leads dataset:
```json
{
  "row_id": "LD-NNNN",
  "name": "<name from prospector>",
  "position": "<position from prospector>",
  "company": "<company from prospector>",
  "company_id": "<row_id of company from 4b>",
  "email": "<email from prospector, empty string if missing>",
  "linkedIn": "<linkedIn from prospector, empty string if missing>",
  "notes": "<notes from prospector>. Source: <article_url from prospector>",
  "assigned_to": "<logged-in user>",
  "last_contact": "",
  "da_research": "<da_research from prospector if present>",
  "product_use_cases": "<product_use_cases (or legacy ethera_use_cases) from prospector if present>",
  "ethera_use_cases": "<same value -- write both; whichever column the CRM board declares is the one that stays visible>"
}
```

#### 4e — Update the Prospector board row
After writing to CRM board, mark the Prospector row as imported:
- `outreach_status`: `"Imported to CRM"`

Use `mcp__brains__update_board_row` on the Prospector board leads dataset.

### Step 5 — Summary

Report what was imported:
- N leads added to CRM board (list names + IDs)
- M new companies created (list names)
- K leads skipped (duplicates — list names)
- Prospector board rows updated to "Imported to CRM"

## Notes

- Always check for duplicates before writing — the prospector may surface people already in the CRM.
- Never import a lead whose `outreach_status` is already "Imported to CRM".
- If the user says "import all" with no other qualification, still show the list first and ask for confirmation — don't silently bulk-import.
- Also copy `da_research` and `product_use_cases` if present on the Prospector row — no need to re-research after import.
- No git operations — CRM data lives in the brains board, not in files.
