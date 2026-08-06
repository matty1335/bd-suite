# BD Automation Suite — Onboarding

This guide sets up the full BD outreach pipeline for a new user:
3 boards, 8 AI agents, the Control Centre dashboard, and local runners.

Open this guide in Claude Code. Your admin shared this link -- do not redistribute.

> **Note:** You do not need to join any shared org or team account. Everything installs into your own Claude Code and brains account. You keep full control of your own boards, automations, and data.

---

## What gets installed

| Component | What it does |
|-----------|-------------|
| Control Centre Board + Dashboard | Campaign config, agent state, runner heartbeats, Campaign Wizard UI |
| Prospector Board | Leads, outreach queue, research, transcripts |
| CRM Board | Companies, contacts, meetings |
| Agent 1: Prospector | Nightly lead discovery from news + Apollo |
| Agent 1.5: Research Analyst | Deep research per company every 6 hours |
| Agent 2A: Draft Generator | Personalized cold email + LinkedIn drafts |
| Agent 2B: Approval Relay | Telegram previews + send/discard/skip/edit commands |
| Agent 2C: Reply Drafter | On-demand reply drafts when prospects respond |
| Agent 3: Meeting Intel | Pre-call brief 30 min before each meeting |
| Agent 4: CRM Updater | Processes meeting transcripts into CRM records |
| Board Provisioner | Auto-provisions a prospector board for each new campaign (runs every 5 min) |
| Local runners | LinkedIn approval (persistent) + transcript extractor -- Granola + Google Meet (cron) |

---

## Before you start

- A brains account at app.mybrains.ai
- Gmail connected at `app.mybrains.ai/integrations` (needed for Agents 2A and 2B -- do this now if not done)
- Telegram installed on your phone

Claude handles the rest automatically.

---

## Step 1: Install the three boards

Claude calls `mcp__brains__whoami` to get your `brain_id` and `user_token`, then installs all three board recipes in parallel:

```
install_recipe(slug="bd-cc-board",         brain_id=<brain_id>)
install_recipe(slug="bd-prospector-board", brain_id=<brain_id>)
install_recipe(slug="bd-crm-board",        brain_id=<brain_id>)
```

Board IDs are captured automatically:
- `CC_BOARD_ID` -- from bd-cc-board result
- `PROSPECTOR_BOARD_ID` -- from bd-prospector-board result
- `CRM_BOARD_ID` -- from bd-crm-board result

**Important -- apply the CC dashboard explicitly after install:**

After `install_recipe(slug="bd-cc-board")` returns, Claude must call `set_dashboard` on the returned `CC_BOARD_ID` using the dashboard HTML fetched from:

```
https://raw.githubusercontent.com/matty1335/bd-suite/main/cc-dashboard.html
```

Do NOT assume the recipe auto-applied it -- always set it explicitly. If a user already had a CC board in their brain, `install_recipe` may return the existing one; the explicit `set_dashboard` call overwrites any stale or personal dashboard on it.

Open after dashboard is applied: `https://app.mybrains.ai/d/<CC_BOARD_ID>`

---

## Step 2: Wire the CC board

The CC board ships with a blank `cc_setup` row. Claude finds the row ID and fills it in automatically using the board IDs from Step 1:

| Field | Value |
|-------|-------|
| `prospector_id` | Prospector board ID |
| `crm_id` | CRM board ID |
| `sender_email` | Your sender email address (cold emails go from this address) |
| `test_email` | Your test email address (drafts go here while test mode is on -- usually the same as sender) |
| `owner_id` | Your brains user ID (from `whoami`) |
| `agent2c_id` | Patched automatically after Step 3 |

Claude will ask for your sender email address, test email address, and reads your `owner_id` from `whoami` automatically.

`test_mode: true` is set by default so nothing goes to real prospects until you flip it in Step 9.

---

## Step 3: Install the seven automations

Claude installs all 7 automation recipes using the same `brain_id`:

```
install_recipe(slug="bd-agent1-prospector",  brain_id=<brain_id>)
install_recipe(slug="bd-agent1-5-research",  brain_id=<brain_id>)
install_recipe(slug="bd-agent2a-draft",      brain_id=<brain_id>)
install_recipe(slug="bd-agent2b-approval",   brain_id=<brain_id>)
install_recipe(slug="bd-agent2c-reply",      brain_id=<brain_id>)
install_recipe(slug="bd-agent3-meeting",     brain_id=<brain_id>)
install_recipe(slug="bd-agent4-crm",         brain_id=<brain_id>)
install_recipe(slug="bd-board-provisioner",  brain_id=<brain_id>)
```

Automation IDs are captured automatically. After Agent 2C installs, Claude patches `agent2c_id` into the cc_setup row without any extra steps from you.

---

## Step 4: Configure secrets

Each automation reads API keys from its own secret store. Claude sets them via `mcp__brains__automation_secret_set`. It will ask you for each key and set them on the correct automation automatically.

`cc_board_id` is set automatically on every agent -- you do not need to provide it.

### Agent 1 -- Prospector

**Minimum required (get Agent 1 running with these 3):**

| Secret | Where to get it |
|--------|----------------|
| `apollo_api_key` | apollo.io |
| `newsapi_key` | newsapi.org |
| `serper_api_key` | serper.dev (free, 2500/month) |

**Optional (add later to expand coverage):**

| Secret | Where to get it |
|--------|----------------|
| `hunter_api_key` | hunter.io |
| `findymail_api_key` | findymail.com |
| `datagma_api_key` | datagma.com |
| `prospeo_api_key` | prospeo.io |
| `snov_client_id` | snov.io OAuth app |
| `snov_client_secret` | snov.io OAuth app |
| `firecrawl_api_key` | firecrawl.dev |

### Agent 1.5 -- Research Analyst

| Secret | Where to get it |
|--------|----------------|
| `serper_api_key` | serper.dev -- same key as Agent 1 |

### Agent 2A -- Draft Generator

| Secret | Where to get it |
|--------|----------------|
| `gmail_install_id` | Claude calls `list_my_integrations` and finds this automatically from your connected Gmail |
| `telegram_bot_id` | Numeric bot ID from @BotFather (same bot as Step 5) |
| `telegram_bot_secret` | Bot token from @BotFather (same token as Step 5) |
| `newsapi_key` | newsapi.org -- same key from Agent 1 |

### Agent 2B -- Approval Relay

| Secret | Where to get it |
|--------|----------------|
| `gmail_install_id` | Same Gmail install ID |

### Agent 2C -- Reply Drafter

| Secret | Where to get it |
|--------|----------------|
| `telegram_bot_id` | Same bot ID as Agent 2A |
| `telegram_bot_secret` | Same bot token as Agent 2A |

### Agent 3 -- Meeting Intel

| Secret | Where to get it |
|--------|----------------|
| `serper_api_key` | serper.dev -- same key |

### Agent 4 -- CRM Updater

| Secret | Where to get it |
|--------|----------------|
| `gmail_install_id` | Claude calls `list_my_integrations` and finds this automatically from your connected Gmail |
| `brains_user_token` | Your brains API token -- Claude reads this from `whoami` automatically |

### Board Provisioner

| Secret | Where to get it |
|--------|----------------|
| `brains_user_token` | Your brains API token -- Claude reads this from `whoami` automatically |
| `brain_id` | Your brain ID -- Claude reads this from `whoami` automatically |

---

## Step 5: Set up Telegram

**Required before proceeding.** Two things to set up -- takes about 5 minutes total.

### 1. Connect BrainChat

All agent notifications (outreach drafts, research alerts, meeting briefs, CRM updates) arrive via your BrainChat Telegram bot.

1. Go to `app.mybrains.ai/integrations/telegram`
2. Follow the steps to link your Telegram account
3. Use the test message button to confirm a message arrives in Telegram

### 2. Create your outreach bot

The LinkedIn runner sends you inline approval buttons (Approve / Skip / Edit) via a personal outreach bot. Each team member has their own.

1. Open Telegram and message `@BotFather`
2. Send `/newbot`
3. Give it any name and username (e.g. name: "My BD Bot", username: "my_bd_outreach_bot")
4. Copy the HTTP API token BotFather gives you

Paste the token to Claude when prompted -- it becomes `BOT_TOKEN` for the installer.

Confirm when both are done before moving to Step 6.

---

## Step 6: Install local runners

Once you confirm Telegram is set up and paste your `BOT_TOKEN`, Claude runs the installer automatically with all tokens pre-filled:

```bash
BRAINS_TOKEN=<user_token> \
CC_BOARD_ID=<CC_BOARD_ID> \
BOT_TOKEN=<BOT_TOKEN> \
bash <(curl -fsSL https://raw.githubusercontent.com/matty1335/bd-suite/main/install.sh)
```

If you want the two Claude Code skills installed into your project, tell Claude your project directory path and `CRM_REPO_DIR` is added automatically.

The installer:
1. Checks Node >= 18 and installs PM2 if missing
2. Downloads runners to `~/.bd-suite/`
3. Writes `~/.bd-suite/.linkedin-runner.env` with all tokens
4. Starts both runners via PM2 and saves the process list
5. Installs Claude Code skills into your project (if `CRM_REPO_DIR` set)

### Authenticate LinkedIn

After the runners install, run the LinkedIn login script once in your terminal:

```bash
node ~/.bd-suite/login.mjs
```

This opens a browser, navigates to LinkedIn, and saves your session cookies locally. The LinkedIn runner uses these to interact with LinkedIn on your behalf without prompting you to log in again. Complete any MFA steps if LinkedIn asks.

---

## Step 7: Verify

Open the CC dashboard: `https://app.mybrains.ai/d/<CC_BOARD_ID>`

Go to the **Setup** tab. Within 5 minutes you should see:
- LinkedIn Runner: **ONLINE**
- Meeting Intel Runner: **ONLINE**

If either shows OFFLINE, run `pm2 list` and `pm2 logs linkedin-runner` in your terminal and share the output with Claude.

---

## Step 8: Create your first campaign

Open the CC dashboard and click **+ New Campaign**.

The Campaign Wizard walks through:
1. **Product** -- use "Fill from Brain" to auto-populate from your brains pages
2. **Signals** -- buying signals that qualify prospects (use "Suggest with AI")
3. **Identity** -- your name, title, and sender email
4. **Tone** -- email style, CTA, scheduling link
5. **Review** -- confirm all settings and save

The active campaign drives what all 7 agents search for, research, and write.

Each new campaign automatically gets its own dedicated prospector board (leads + outreach queue). All agents and local runners switch to that board when the campaign becomes active -- no manual board IDs needed.

---

## Step 9: Go live

When you are ready to send real outreach:

1. In the CC dashboard Setup tab, flip **Test Mode** off
2. Confirm with your admin that Agent 2A is authorized for production

Until then, all outreach goes only to your own email.

---

## Claude Code skills

Two skills install into your project via `install.sh` (requires `CRM_REPO_DIR`):

- `/crm:import-from-prospector` -- Moves approved leads from Prospector board into your CRM
- `/crm:queue-for-research` -- Queues CRM leads for Agent 1.5 to research

Run these in Claude Code from your project directory.

---

## Need help?

Ask your admin, or open Claude Code and describe what you need.
