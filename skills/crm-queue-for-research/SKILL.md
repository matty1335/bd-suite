---
name: crm-queue-for-research
description: "Queue CRM board leads for research by syncing them to the Prospector board. Use when someone says 'queue for research', 'sync to prospector', 'send to research', 'add to research queue', or 'research CRM leads'."
---

# /crm:queue-for-research

Find leads in the CRM board that are not yet on the Prospector board and add them so Agent 1.5 (Research Analyst) can enrich them with da_research and ethera_use_cases.

**Control Centre board ID:** `__CC_BOARD_ID__`

## Step 0 -- Resolve the boards (do this first)

Never hardcode a board id. Board ids differ per user and per campaign, so read
them from the Control Centre board every time:

1. `mcp__brains__get_board` -> board `__CC_BOARD_ID__`, dataset `meta`, limit 50
2. From the `cc_setup` row (JSON in `value`): take `prospector_id` and `crm_id`
3. From the `agent_config` row: find the campaign whose `id` equals
   `active_campaign_id`. If it has a non-empty `prospector_board_id`, that
   **overrides** `prospector_id`
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

### Step 1 — Load both boards in parallel

Simultaneously fetch:
- CRM board leads: `mcp__brains__get_board` → the CRM board, dataset `leads`, limit 1000
- Prospector board leads: `mcp__brains__get_board` → the Prospector board, dataset `leads`, limit 1000

### Step 2 — Find CRM leads not on the Prospector board

Build a set of existing Prospector keys: `name.toLowerCase().trim() + "|" + company.toLowerCase().trim()`

Filter CRM leads to those where:
- Not deleted (`_deleted_at` is null/empty)
- Their `name|company` key is NOT in the Prospector set
- Have a non-empty `name` and `company`

### Step 3 — Display the candidates

If none found: "All CRM leads are already on the Prospector board. Nothing to queue."

Otherwise present a numbered table:

```
CRM leads not yet queued for research:

 #  Name                    Company              Position                   Added by
──  ──────────────────────  ───────────────────  ─────────────────────────  ──────────
 1  Ali AlBalaghi           Worldpay             Head of Digital Assets     matthias
 2  Ian Place               Block                Business Development        matthias
 3  Giovane Avila           Itau Ventures        Partner                    omer
...

Queue for research:
  • Numbers: 1, 3
  • All: all
  • By company: "all Worldpay"
```

### Step 4 — Confirm selection

Echo back the names + companies and ask: "Queue these N leads for research?"

Wait for confirmation before writing anything.

### Step 5 — Append to Prospector board

For each confirmed lead, call `mcp__brains__append_board_rows` on the Prospector board leads dataset:

```json
{
  "name": "<name from CRM>",
  "company": "<company from CRM>",
  "position": "<position from CRM>",
  "email": "<email from CRM, or 'pending' if empty>",
  "linkedIn": "",
  "outreach_status": "crm_lead",
  "discovery_source": "crm_board",
  "signal": "Queued from CRM board for research",
  "confidence": "High",
  "notes": "<notes from CRM if any>",
  "owner": "<assigned_to from CRM>",
  "createdAt": "<now ISO 8601>",
  "updatedAt": "<now ISO 8601>"
}
```

### Step 6 — Summary

Report:
- N leads added to Prospector board (list names + companies)
- Agent 1.5 (Research Analyst) runs every 6 hours and will enrich them with da_research and ethera_use_cases
- Once enriched, use `/crm:import-from-prospector` to bring the enriched data back to the CRM board

## Notes

- This is a one-way push — it does NOT write back to the CRM board.
- After Agent 1.5 enriches the lead on the Prospector board, use `/crm:import-from-prospector` to commit the enriched data (da_research, email, ethera_use_cases) back to CRM.
- `outreach_status: "crm_lead"` flags these as CRM-originated so they are distinguishable from auto-discovered Prospector leads.
- Run this skill whenever you or a teammate adds new leads to the CRM board and you want them researched.
