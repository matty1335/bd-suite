---
name: crm-import-from-prospector
description: "Import selected leads from the Ethera Prospector board into the CRM board. Use when someone says 'import from prospector', 'push to CRM', 'move to CRM', 'graduate to CRM', or 'promote from prospector'."
---

# /crm:import-from-prospector

Interactively select leads from the Prospector board and import them into the CRM board.

**Prospector board ID:** `95dcb668-e2d9-4093-9a3e-3200901846fa`
**CRM board ID:** `1de2a9f5-03cd-427e-9bb4-9198ed336f62`

## Workflow

### Step 1 — Fetch leads from the Prospector board

Call `mcp__brains__get_board` with:
- `board_id`: `95dcb668-e2d9-4093-9a3e-3200901846fa`
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
Call `mcp__brains__get_board` on the CRM board (`1de2a9f5-03cd-427e-9bb4-9198ed336f62`, dataset `leads`, limit 1000).
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
  "ethera_use_cases": "<ethera_use_cases from prospector if present>"
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
- Also copy `da_research` and `ethera_use_cases` if present on the Prospector row — no need to re-research after import.
- No git operations — CRM data lives in the brains board, not in files.
