#!/usr/bin/env node
// linkedin-runner.mjs — Approval Processor (local)
// All LinkedIn actions go through a persistent Chromium browser — no raw API calls.
// This prevents session invalidation caused by mismatched browser fingerprints.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dir, '.linkedin-runner.env');
const STATE_PATH = join(__dir, '.linkedin-runner-state.json');
const PROFILE_DIR = join(__dir, '.linkedin-browser-profile');
let BOARD_ID = '95dcb668-e2d9-4093-9a3e-3200901846fa'; // overridden by CC board at startup
let CC_BOARD_ID = process.env.CC_BOARD_ID || '2907a47b-b179-452e-b9de-042367012bf0';
const BRAINS_MCP = 'https://mcp.mybrains.ai/mcp';
const POLL_INTERVAL_MS = 30_000;

// ---------- Config ----------

function loadEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error(`\nMissing ${ENV_PATH}\nCopy .linkedin-runner.env.example and fill in your values.\n`);
    process.exit(1);
  }
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
  const cfg = {};
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!cfg.BRAINS_TOKEN) { console.error(`Missing BRAINS_TOKEN in ${ENV_PATH}`); process.exit(1); }
  if (!cfg.BOT_TOKEN) { console.warn(`Warning: BOT_TOKEN not set in ${ENV_PATH} — Telegram notifications disabled`); }
  if (cfg.CC_BOARD_ID) CC_BOARD_ID = cfg.CC_BOARD_ID;
  return cfg;
}

let cfg = loadEnv();

// ---------- State ----------

function loadState() {
  if (!existsSync(STATE_PATH)) return { lastUpdateId: 0, pendingEdits: {} };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (!s.pendingEdits) s.pendingEdits = {};
    return s;
  }
  catch { return { lastUpdateId: 0, pendingEdits: {} }; }
}
function saveState(s) { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

// ---------- Logging ----------

function log(msg) { console.log(`[${new Date().toISOString().slice(0, 19)}] ${msg}`); }

// ---------- Brains MCP ----------

async function brainsTool(name, args) {
  const res = await fetch(BRAINS_MCP, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.BRAINS_TOKEN}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1 })
  });
  const data = await res.json();
  if (data.error) throw new Error(`MCP ${name}: ${JSON.stringify(data.error)}`);
  const text = data.result?.content?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return text; }
}

async function getBoard(dataset) { return brainsTool('get_board', { board_id: BOARD_ID, dataset, limit: 1000 }); }
async function updateRow(rowId, dataset, patch) { return brainsTool('update_board_row', { board_id: BOARD_ID, row_id: rowId, dataset, patch }); }

async function loadCCConfig() {
  try {
    const ccBoard = await brainsTool('get_board', { board_id: CC_BOARD_ID, dataset: 'meta', limit: 10 });
    const rows = ccBoard?.data?.datasets?.meta?.rows ?? [];
    const setupRow = rows.find(r => r.key === 'cc_setup');
    if (setupRow) {
      const setup = JSON.parse(String(setupRow.value ?? '{}'));
      if (setup.prospector_id) BOARD_ID = setup.prospector_id;
      log(`CC config loaded (cc=${CC_BOARD_ID.slice(0,8)}) prospector=${BOARD_ID.slice(0,8)}`);
    } else {
      log(`CC config: cc_setup row not found — using hardcoded defaults`);
    }
  } catch (e) {
    log(`CC config load failed: ${e.message?.slice(0, 80)} — using hardcoded defaults`);
  }
}

// ---------- Heartbeat ----------

let _heartbeatRowId = null;

async function pingHeartbeat() {
  const value = JSON.stringify({ status: 'running', last_ping: new Date().toISOString() });
  try {
    if (!_heartbeatRowId) {
      const metaBoard = await brainsTool('get_board', { board_id: CC_BOARD_ID, dataset: 'meta', limit: 50 });
      const rows = metaBoard?.data?.datasets?.meta?.rows ?? [];
      const existing = rows.find(r => r.key === 'runner_linkedin_ping');
      if (existing?.row_id) {
        _heartbeatRowId = String(existing.row_id);
      } else {
        await brainsTool('append_board_rows', { board_id: CC_BOARD_ID, dataset: 'meta', rows: [{ key: 'runner_linkedin_ping', value }] });
        log('Heartbeat row created');
        return;
      }
    }
    await brainsTool('update_board_row', { board_id: CC_BOARD_ID, dataset: 'meta', row_id: _heartbeatRowId, patch: { value } });
    log('Heartbeat OK');
  } catch (e) {
    _heartbeatRowId = null;
    log(`Heartbeat error: ${e.message?.slice(0, 60)}`);
  }
}

// ---------- Delays ----------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(minSec, maxSec) {
  const ms = (minSec + Math.random() * (maxSec - minSec)) * 1000;
  log(`  [pause ${(ms / 1000).toFixed(1)}s]`);
  return sleep(ms);
}

// ---------- Persistent Chromium Context ----------
// One browser process stays alive for the lifetime of the runner.
// Reusing the same context means LinkedIn always sees the same browser fingerprint.

let _ctx = null;
let _chatId = null; // cached from meta board on startup
const _processedDraftIds = new Set(); // in-memory dedup for discardStaleDrafts; resets on restart

async function getCtx() {
  if (_ctx) return _ctx;
  log('Launching persistent Chromium...');
  _ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  log('Chromium ready.');
  return _ctx;
}

// Check if the saved session is still valid.
// Returns true if logged in, false if session expired (user needs to run login.mjs).
async function isLoggedIn() {
  const page = await newPage();
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const url = page.url();
    return !url.includes('/login') && !url.includes('/authwall') && !url.includes('/checkpoint');
  } catch {
    return false;
  } finally {
    await page.close();
  }
}

async function newPage() {
  let ctx;
  try {
    ctx = await getCtx();
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return page;
  } catch (e) {
    // Chromium context was closed (crash/OOM) — reset and re-launch
    if (String(e.message).includes('closed') || String(e.message).includes('Target page')) {
      log('Chromium context closed — relaunching...');
      _ctx = null;
      ctx = await getCtx();
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      return page;
    }
    throw e;
  }
}

// ---------- LinkedIn helpers ----------

function toSlug(urlOrSlug) {
  if (!urlOrSlug) return '';
  const s = String(urlOrSlug).trim().replace(/\/$/, '');
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? m[1] : s;
}

// ---------- LinkedIn — Connection Request ----------

async function sendConnectionRequest(slug, note, chatId) {
  slug = toSlug(slug);
  const page = await newPage();
  try {
    if (chatId) await tgSend(chatId, `[1/3] Opening ${slug}'s profile...`);
    await randomDelay(1, 2);

    await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2000 + Math.random() * 1500);

    const pageUrl = page.url();
    if (pageUrl.includes('/login') || pageUrl.includes('/checkpoint')) {
      return { status: 401, body: 'Session expired — run: node login.mjs' };
    }

    // ── Detect connection state from the profile page ──────────────────────
    // Reliable signal: LinkedIn shows a "1st" degree badge next to the name
    // when you're connected. Buttons alone are not reliable:
    //   - "Message" can appear for non-connections (open profiles, InMail)
    //   - "Follow" appears for influencers — NOT a connection indicator
    //   - "Connect" missing could mean Follow-only profile, not connected
    // So we check the degree badge first, then fall back to button state.

    const is1st = await page.locator('span:has-text("1st"), .dist-value:has-text("1st")').first().isVisible({ timeout: 3000 }).catch(() => false);
    const hasPending = await page.locator('button:has-text("Pending")').first().isVisible({ timeout: 2000 }).catch(() => false);
    const hasConnect = await page.locator('.pvs-profile-actions button[aria-label*="Invite"], .pvs-profile-actions button:has-text("Connect")').first().isVisible({ timeout: 2000 }).catch(() => false);

    if (is1st) {
      log(`  ${slug}: already 1st degree — triggering DM draft`);
      return { status: 422, body: 'Already connected' };
    }
    if (hasPending) {
      log(`  ${slug}: connection request already pending`);
      return { status: 409, body: 'Pending' };
    }
    if (!hasConnect) {
      // Check More dropdown before giving up
      let foundInMore = false;
      const moreBtn = page.locator('.pvs-profile-actions button[aria-label*="More"]').first();
      if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await moreBtn.click();
        await sleep(600);
        foundInMore = await page.locator('[role="menuitem"]:has-text("Connect")').first().isVisible({ timeout: 2000 }).catch(() => false);
        if (!foundInMore) await page.keyboard.press('Escape');
      }
      if (!foundInMore) {
        log(`  ${slug}: no Connect button — Follow-only or restricted profile`);
        return { status: 400, body: 'No Connect option — profile may be Follow-only or restricted' };
      }
    }

    // ── Click Connect (direct button or already-open More dropdown) ────────
    if (chatId) await tgSend(chatId, `[2/3] Clicking Connect...`);

    let clicked = false;

    if (hasConnect) {
      const directBtn = page.locator('.pvs-profile-actions button[aria-label*="Invite"], .pvs-profile-actions button:has-text("Connect")').first();
      await directBtn.click();
      clicked = true;
    } else {
      // More dropdown was already opened above — click the Connect item in it
      const dropConnect = page.locator('[role="menuitem"]:has-text("Connect")').first();
      if (await dropConnect.isVisible({ timeout: 3000 }).catch(() => false)) {
        await dropConnect.click();
        clicked = true;
      }
    }

    if (!clicked) {
      return { status: 400, body: 'Could not click Connect' };
    }

    await sleep(1000 + Math.random() * 500);

    // ── Handle the "Add a note" modal ─────────────────────────────────────
    const addNoteBtn = page.locator('button[aria-label="Add a note"]').first();
    if (await addNoteBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await addNoteBtn.click();
      await sleep(500 + Math.random() * 300);
    }

    if (note) {
      const noteArea = page.locator('textarea[name="message"], .send-invite__custom-message').first();
      if (await noteArea.isVisible({ timeout: 4000 }).catch(() => false)) {
        await noteArea.click();
        await sleep(300);
        await page.keyboard.type(note, { delay: 35 + Math.random() * 45 });
        await sleep(400);
      }
    }

    if (chatId) await tgSend(chatId, `[3/3] Sending...`);

    const sendBtn = page.locator('button[aria-label="Send invitation"], button[aria-label="Send now"], button:has-text("Send now")').first();
    await sendBtn.waitFor({ timeout: 5000 });
    await sendBtn.click();
    await sleep(2000);

    log(`  [browser] connection request sent to ${slug}`);
    return { status: 200, body: 'ok' };

  } catch (e) {
    log(`  [browser] connect err: ${e.message?.slice(0, 120)}`);
    return { status: 0, body: e.message?.slice(0, 120) };
  } finally {
    await page.close();
  }
}

// ---------- LinkedIn — Send DM ----------

async function sendDm(slug, text, chatId) {
  slug = toSlug(slug);
  const page = await newPage();
  try {
    if (chatId) await tgSend(chatId, `[1/4] Opening ${slug}'s profile...`);
    await randomDelay(1, 2);

    await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2000 + Math.random() * 1500);

    if (page.url().includes('/login') || page.url().includes('/checkpoint')) {
      return { ok: false, error: 'Session expired — run: node login.mjs' };
    }

    if (chatId) await tgSend(chatId, `[2/4] Finding messaging thread...`);

    // The Message button on a profile is an <a> anchor (not a button) scoped to <main>.
    // Its href already contains the compose URL with the recipient URN embedded —
    // extracting it avoids the need to separately look up the URN.
    const composeHref = await page.evaluate(() => {
      const anchor = Array.from(document.querySelectorAll('main a[href*="/messaging/compose/"]'))
        .find(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      return anchor ? (anchor.getAttribute('href') || anchor.href) : null;
    });
    log(`  [DM] compose href: ${composeHref?.slice(0, 100)}`);

    if (!composeHref) return { ok: false, error: 'No Message button found — not connected or profile restricted' };

    // Navigate directly to compose URL — full messaging page, no overlay, compose box in main frame
    const composeUrl = new URL(composeHref, 'https://www.linkedin.com').toString();
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500 + Math.random() * 1000);
    log(`  [DM] compose page: ${page.url().slice(0, 80)}`);

    if (page.url().includes('/login')) return { ok: false, error: 'Session expired — run: node login.mjs' };

    // Find the compose box with role=textbox selectors (more specific than contenteditable alone)
    const composeSelectors = [
      'div[role="textbox"][contenteditable="true"][aria-label*="Write a message"]',
      'div[role="textbox"][contenteditable="true"][aria-label*="message"]',
      'main div[role="textbox"][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      '.msg-form__contenteditable',
    ];
    let composeBoxSel = null;
    for (const sel of composeSelectors) {
      if (await page.locator(sel).count() > 0) { composeBoxSel = sel; break; }
    }
    if (!composeBoxSel) return { ok: false, error: 'Compose box not found on messaging page' };
    log(`  [DM] compose box: ${composeBoxSel}`);

    // Wait for it to be visible and interactive
    await page.locator(composeBoxSel).waitFor({ state: 'visible', timeout: 15000 });

    if (chatId) await tgSend(chatId, `[3/4] Typing message (${text.length} chars)...`);

    // Focus via page.evaluate — bypasses Playwright's actionability checks on React contenteditable.
    // Then type via page.keyboard (page-level, not locator-level) — fires real keydown/input/keyup
    // events that React's event system needs to update internal state.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.focus();
    }, composeBoxSel);
    await sleep(150);
    await page.keyboard.type(text, { delay: 15 });
    log(`  [DM] typed (${text.length} chars)`);
    await sleep(1200); // React needs ~1s to enable the Send button after typing

    if (chatId) await tgSend(chatId, `[4/4] Hitting send...`);

    // Click Send via JS — bypasses Playwright actionability checks on the disabled→enabled button
    const sent = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll(
        'button[type="submit"], button[aria-label*="Send"], button[data-control-name="send"]'
      )).find(b => !b.disabled && (b.offsetWidth || b.offsetHeight || b.getClientRects().length));
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!sent) {
      await page.keyboard.press('Enter');
      log('  [DM] sent via Enter fallback');
    } else {
      log('  [DM] send button clicked');
    }

    await sleep(2000);
    log(`  [browser] DM sent to ${slug}`);
    return { ok: true };

  } catch (e) {
    log(`  [browser] DM err: ${e.message?.slice(0, 120)}`);
    return { ok: false, error: e.message?.slice(0, 120) };
  } finally {
    await page.close();
  }
}

// ---------- LinkedIn — Check for Reply ----------
// Navigates to the conversation before sending a FU DM.
// If the prospect already replied, we skip the send.

async function checkLinkedInForReply(slug) {
  slug = toSlug(slug);
  const page = await newPage();
  try {
    await page.goto(`https://www.linkedin.com/in/${encodeURIComponent(slug)}/`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2000 + Math.random() * 1000);

    if (page.url().includes('/login') || page.url().includes('/authwall')) return { replied: false };

    const composeHref = await page.evaluate(() => {
      const anchor = Array.from(document.querySelectorAll('main a[href*="/messaging/compose/"]'))
        .find(el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      return anchor ? (anchor.getAttribute('href') || anchor.href) : null;
    });
    if (!composeHref) return { replied: false }; // not connected or no thread yet

    const composeUrl = new URL(composeHref, 'https://www.linkedin.com').toString();
    await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000 + Math.random() * 1000);

    const { replied, lastMessage, lastMessageDatetime } = await page.evaluate(() => {
      // Sequence-based reply detection: only flag a reply if there's an incoming message
      // that comes AFTER our last outgoing message. This is more reliable than timestamp
      // comparison — LinkedIn DOM timestamps don't tell us which messages came before/after
      // the specific DM we sent.
      const allEls = Array.from(document.querySelectorAll('.msg-s-event-listitem'));
      if (allEls.length === 0) return { replied: false, lastMessage: '', lastMessageDatetime: null };

      // Find the index of our last outgoing message (any non-other listitem)
      let lastOwnIdx = -1;
      for (let i = 0; i < allEls.length; i++) {
        if (!allEls[i].classList.contains('msg-s-event-listitem--other')) lastOwnIdx = i;
      }

      // No own message found means we haven't sent anything yet — can't determine sequence
      if (lastOwnIdx === -1) return { replied: false, lastMessage: '', lastMessageDatetime: null };

      // Check if any "other" message comes AFTER our last own message
      const otherAfterOwn = allEls.slice(lastOwnIdx + 1).filter(el =>
        el.classList.contains('msg-s-event-listitem--other')
      );
      if (otherAfterOwn.length === 0) return { replied: false, lastMessage: '', lastMessageDatetime: null };

      // Extract content of the last reply
      const lastOtherEl = otherAfterOwn[otherAfterOwn.length - 1];
      const bodyEl = lastOtherEl.querySelector('.msg-s-event-listitem__body');
      const lastMessage = bodyEl ? (bodyEl.textContent ?? '').trim().slice(0, 400) : '';

      // Grab timestamp for logging (not used for filtering — sequence handles that)
      const msgContainer = allEls[0]?.closest('ul, [class*="msg-s-message-list"]') ?? null;
      const searchScope = msgContainer ?? document;
      const timeEls = Array.from(searchScope.querySelectorAll('time[datetime]'));
      const lastMessageDatetime = timeEls.length > 0 ? timeEls[timeEls.length - 1].getAttribute('datetime') : null;
      return { replied: true, lastMessage, lastMessageDatetime };
    });

    log(`  [li-reply] ${slug}: replied=${replied}${lastMessageDatetime ? ` at ${lastMessageDatetime}` : ''}`);
    return { replied, lastMessage, lastMessageDatetime };
  } catch (e) {
    log(`  [li-reply] err ${slug}: ${e.message?.slice(0, 80)}`);
    return { replied: false };
  } finally {
    await page.close();
  }
}

// ---------- Telegram ----------

function tgBase() { return `https://api.telegram.org/bot${cfg.BOT_TOKEN}`; }

async function tgSend(chatId, text) {
  try {
    await fetch(`${tgBase()}/sendMessage?chat_id=${encodeURIComponent(String(chatId))}&text=${encodeURIComponent(text)}`);
  } catch (e) {
    log(`  tgSend error: ${e.message}`);
  }
}

async function tgAnswerCallback(callbackQueryId) {
  try {
    await fetch(`${tgBase()}/answerCallbackQuery?callback_query_id=${encodeURIComponent(String(callbackQueryId))}`);
  } catch {}
}

// ---------- Reply Drafting ----------

const REPLY_DRAFTER_ID = '3966e90e-3ded-48c1-bea6-775597f00843';

async function draftReply(chatId, lead, channel, replyContent, linkedinSlug = null) {
  const name     = String(lead.name ?? '');
  const position = String(lead.position ?? '');
  const company  = String(lead.company ?? '');
  const snippet  = (replyContent ?? '').trim().slice(0, 400);
  const lead_id  = String(lead.id ?? '');

  // Write request to meta, then trigger the reply-drafter brains automation.
  // The automation handles LLM drafting, OQ row creation, and Telegram notification.
  const reqKey = `reply_req_${lead_id}`;
  const reqValue = JSON.stringify({
    status: 'pending',
    lead_id,
    lead_row_id: String(lead.row_id ?? ''),
    name, company, position, channel,
    snippet, slug: linkedinSlug ?? '',
    created_at: new Date().toISOString(),
  });

  try {
    // Upsert: try update first (row may already exist from a prior request)
    const metaBoard = await getBoard('meta');
    const metaRows  = metaBoard?.data?.datasets?.meta?.rows ?? [];
    const existing  = metaRows.find(r => String(r.key) === reqKey);
    if (existing?.row_id) {
      await updateRow(String(existing.row_id), 'meta', { value: reqValue, updated_at: new Date().toISOString() });
    } else {
      await brainsTool('append_board_rows', { board_id: BOARD_ID, dataset: 'meta', rows: [{ key: reqKey, value: reqValue, updated_at: new Date().toISOString() }] });
    }
    log(`Reply request written for ${name} (${channel}), triggering reply drafter...`);
  } catch (e) {
    log(`draftReply meta write error: ${e.message?.slice(0, 80)}`);
    return;
  }

  // Fire the reply-drafter automation (non-blocking — don't await result)
  brainsTool('run_automation_once', { automation_id: REPLY_DRAFTER_ID, dry_run: false })
    .then(() => log(`Reply drafter completed for ${name}`))
    .catch(e => log(`Reply drafter trigger error: ${e.message?.slice(0, 80)}`));
}

// ---------- Command Handlers ----------

async function handleSend(chatId, qid, queueRows, leadRows) {
  const qRow = queueRows.find(r => String(r.id) === qid);
  if (!qRow) { await tgSend(chatId, `${qid}: Not found.`); return; }
  if (['linkedin_sent', 'sent'].includes(String(qRow.status))) { await tgSend(chatId, `${qid} already sent.`); return; }

  const channel  = String(qRow.channel ?? 'linkedin');
  const fuNum    = parseInt(String(qRow.follow_up_number ?? '0'), 10);
  const leadName = String(qRow.lead_name ?? '');
  const leadRow  = leadRows.find(r => String(r.id) === String(qRow.lead_id));

  // ── Reply drafts (follow_up_number: -1) ──────────────────────────────────
  if (fuNum === -1) {
    const body = String(qRow.body ?? '');
    if (!body) { await tgSend(chatId, `${qid}: No draft body.`); return; }

    if (channel === 'email') {
      const leadEmail = String(leadRow?.email ?? '').trim();
      if (!leadEmail) { await tgSend(chatId, `${qid}: No email address for ${leadName}.`); return; }
      const rawSubject = String(qRow.subject ?? 'Ethera');
      const subject    = rawSubject.toLowerCase().startsWith('re:') ? rawSubject : `Re: ${rawSubject}`;
      await tgSend(chatId, `Sending email reply to ${leadName}...`);
      try {
        const draftResult = await brainsTool('act_on_integration', {
          source: 'gmail',
          request: `Send email to ${leadEmail} with subject "${subject}" and body:\n${body}`,
        });
        if (draftResult?.kind === 'draft' && draftResult.draft_id) {
          await brainsTool('confirm_action', { draft_id: draftResult.draft_id });
        }
        await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'sent', approval_outcome: 'reply_approved' });
        await tgSend(chatId, `Reply sent to ${leadName}. ${qid} marked sent.`);
      } catch (e) {
        await tgSend(chatId, `${qid}: Send failed — ${e.message?.slice(0, 100)}`);
      }
      return;
    }

    if (channel === 'linkedin') {
      const slug = String(qRow.lead_linkedin_id ?? '');
      if (!slug) { await tgSend(chatId, `${qid}: No LinkedIn slug.`); return; }
      await tgSend(chatId, `Sending LinkedIn reply to ${leadName}...`);
      const dmResult = await sendDm(slug, body, chatId);
      if (dmResult.ok) {
        await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'linkedin_sent', approval_outcome: 'reply_approved' });
        await tgSend(chatId, `Reply sent to ${leadName} on LinkedIn. ${qid} marked sent.`);
      } else {
        await tgSend(chatId, `${qid}: LinkedIn reply failed — ${dmResult.error}`);
      }
      return;
    }

    await tgSend(chatId, `${qid}: Unknown channel for reply: ${channel}`);
    return;
  }

  // ── LinkedIn-only paths ───────────────────────────────────────────────────
  if (channel !== 'linkedin') { await tgSend(chatId, `${qid}: Channel ${channel} not handled by send.`); return; }

  const slug = String(qRow.lead_linkedin_id ?? '');
  const note = String(qRow.body ?? '');
  if (!slug) { await tgSend(chatId, `${qid}: No LinkedIn slug.`); return; }

  // FU rows: already connected — check for reply first, then send DM
  if (fuNum > 0) {
    const dm = String(qRow.body ?? '');
    if (!dm) { await tgSend(chatId, `${qid}: No DM content.`); return; }

    await tgSend(chatId, `Checking ${leadName}'s inbox for replies...`);
    const replyCheck = await checkLinkedInForReply(slug);
    if (replyCheck.replied) {
      // Temporal filter: skip if the detected reply predates when we sent our cold DM.
      const sentColdRow = queueRows.find(r =>
        String(r.lead_id) === String(qRow.lead_id) &&
        r.channel === 'linkedin' &&
        r.status === 'linkedin_sent' &&
        parseInt(String(r.follow_up_number ?? '0'), 10) === 0
      );
      const dmSentAt = sentColdRow?.updated_at ? new Date(String(sentColdRow.updated_at)).getTime() : null;
      if (dmSentAt && replyCheck.lastMessageDatetime) {
        const replyTs = new Date(replyCheck.lastMessageDatetime).getTime();
        if (!isNaN(replyTs) && replyTs < dmSentAt) {
          log(`  handleSend: reply for ${leadName} predates our DM — treating as no reply`);
          await tgSend(chatId, `Reply detected is older than our outreach — treating as no reply, proceeding with FU.`);
          // Fall through to send the DM below
        } else {
          await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'skipped', approval_outcome: 'prospect_replied_li' });
          if (leadRow?.row_id) await updateRow(String(leadRow.row_id), 'leads', { outreach_status: 'Responded', response_channel: 'linkedin' });
          await tgSend(chatId, `${leadName} replied on LinkedIn — FU${fuNum} skipped. Drafting your reply...`);
          await draftReply(chatId, leadRow ?? { id: qRow.lead_id, name: leadName }, 'linkedin', replyCheck.lastMessage, slug);
          return;
        }
      } else {
        // No timestamp to compare — trust the reply detection
        await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'skipped', approval_outcome: 'prospect_replied_li' });
        if (leadRow?.row_id) await updateRow(String(leadRow.row_id), 'leads', { outreach_status: 'Responded', response_channel: 'linkedin' });
        await tgSend(chatId, `${leadName} replied on LinkedIn — FU${fuNum} skipped. Drafting your reply...`);
        await draftReply(chatId, leadRow ?? { id: qRow.lead_id, name: leadName }, 'linkedin', replyCheck.lastMessage, slug);
        return;
      }
    }

    await tgSend(chatId, `Sending DM to ${leadName} (FU${fuNum})...`);
    const dmResult = await sendDm(slug, dm, chatId);
    if (dmResult.ok) {
      await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'linkedin_sent', approval_outcome: 'approved_dm' });
      if (leadRow?.row_id) await updateRow(String(leadRow.row_id), 'leads', { linkedin_status: 'dm_sent' });
      await tgSend(chatId, `DM sent to ${leadName}. ${qid} marked as sent.`);
    } else {
      await tgSend(chatId, `${qid}: DM failed — ${dmResult.error}`);
    }
    return;
  }

  await tgSend(chatId, `Sending connection request to ${leadName}...`);
  const r = await sendConnectionRequest(slug, note, chatId);

  if (r.status === 200 || r.status === 201) {
    await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'linkedin_sent', approval_outcome: 'approved' });
    if (leadRow?.row_id) await updateRow(String(leadRow.row_id), 'leads', { linkedin_status: 'connection_sent' });
    await tgSend(chatId, `Connection request sent to ${leadName}. ${qid} marked as sent.`);

  } else if (r.status === 422) {
    // Already connected — trigger DM draft generation via Brains automation
    await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'needs_dm_draft' });
    await tgSend(chatId, `Already connected with ${leadName}. Generating DM draft (up to 1 min)...\nYou'll get a preview here when ready.`);

  } else if (r.status === 409) {
    await tgSend(chatId, `${qid}: Connection request to ${leadName} is already pending.`);

  } else if (r.status === 401) {
    await tgSend(chatId, `${qid}: Session expired. Run: node login.mjs — then pm2 restart linkedin-runner`);

  } else {
    await tgSend(chatId, `${qid}: Failed — ${r.body?.slice(0, 120)}`);
  }
}

async function handleSendDm(chatId, qid, queueRows, leadRows) {
  const qRow = queueRows.find(r => String(r.id) === qid);
  if (!qRow) { await tgSend(chatId, `${qid}: Not found.`); return; }

  const dm = String(qRow.dm_body ?? '');
  const slug = String(qRow.lead_linkedin_id ?? '');
  const leadName = String(qRow.lead_name ?? '');
  const leadRow = leadRows.find(r => String(r.id) === String(qRow.lead_id));

  if (!dm) { await tgSend(chatId, `${qid}: No DM draft yet. Wait for Brains to generate it (up to 1 min).`); return; }
  if (!slug) { await tgSend(chatId, `${qid}: No LinkedIn slug.`); return; }

  await tgSend(chatId, `Sending DM to ${leadName}...`);
  const r = await sendDm(slug, dm, chatId);

  if (r.ok) {
    await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'linkedin_sent', approval_outcome: 'approved_dm' });
    if (leadRow?.row_id) await updateRow(String(leadRow.row_id), 'leads', { linkedin_status: 'dm_sent' });
    await tgSend(chatId, `DM sent to ${leadName}. ${qid} marked as sent.`);
  } else {
    await tgSend(chatId, `${qid}: DM failed — ${r.error}`);
  }
}

// ---------- Poll ----------

async function poll(state) {
  const offset = state.lastUpdateId > 0 ? state.lastUpdateId + 1 : 0;
  const res = await fetch(`${tgBase()}/getUpdates?offset=${offset}&limit=20&timeout=0`);
  if (!res.ok) { log(`getUpdates HTTP ${res.status}`); return; }

  const data = await res.json();
  const updates = data.result ?? [];
  if (updates.length === 0) return;
  log(`${updates.length} update(s)`);

  const queueBoard = await getBoard('outreach_queue');
  const queueRows = queueBoard?.data?.datasets?.outreach_queue?.rows ?? [];
  const leadsBoard = await getBoard('leads');
  const leadRows = leadsBoard?.data?.datasets?.leads?.rows ?? [];

  for (const update of updates) {
    const uid = Number(update.update_id ?? 0);
    if (uid > state.lastUpdateId) state.lastUpdateId = uid;

    // ── Inline button callback queries ────────────────────────────────────
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbChatId = String(cb.message?.chat?.id ?? '');
      const cbData = (cb.data ?? '').trim();
      await tgAnswerCallback(cb.id);
      log(`Callback [${cbChatId}]: "${cbData.slice(0, 80)}"`);

      const cbSendMatch       = cbData.match(/^send\s+(OQ-\d+)$/i);
      const cbSendAllLiMatch  = cbData.match(/^send\s+all\s+li\s+(OQ-\d+(?:\s+OQ-\d+)*)/i);
      const cbSkipMatch       = cbData.match(/^skip\s+(OQ-\d+)$/i);
      const cbEditMatch       = cbData.match(/^edit\s+(OQ-\d+)$/i);
      const cbDiscardMatch    = cbData.match(/^discard\s+(OQ-\d+)$/i);

      if (cbSendAllLiMatch) {
        const qids = cbSendAllLiMatch[1].trim().toUpperCase().split(/\s+/);
        await tgSend(cbChatId, `Sending ${qids.length} LinkedIn FU message(s): ${qids.join(', ')}`);
        for (let i = 0; i < qids.length; i++) {
          await handleSend(cbChatId, qids[i], queueRows, leadRows);
          if (i < qids.length - 1) await randomDelay(3, 6);
        }
        await tgSend(cbChatId, `Send all done (${qids.length} message(s) attempted).`);
      } else if (cbSendMatch) {
        await handleSend(cbChatId, cbSendMatch[1].toUpperCase(), queueRows, leadRows);
      } else if (cbSkipMatch) {
        const qid = cbSkipMatch[1].toUpperCase();
        const qRow = queueRows.find(r => String(r.id) === qid);
        if (!qRow) { await tgSend(cbChatId, `${qid}: Not found.`); }
        else {
          await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'skipped', approval_outcome: 'skipped' });
          await tgSend(cbChatId, `${qid} skipped.`);
        }
      } else if (cbDiscardMatch) {
        const qid = cbDiscardMatch[1].toUpperCase();
        const qRow = queueRows.find(r => String(r.id) === qid);
        if (!qRow) { await tgSend(cbChatId, `${qid}: Not found.`); }
        else {
          await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'discarded', approval_outcome: 'discarded' });
          await tgSend(cbChatId, `${qid} discarded.`);
        }
      } else if (cbEditMatch) {
        const qid = cbEditMatch[1].toUpperCase();
        state.pendingEdits[cbChatId] = qid;
        await tgSend(cbChatId, `✏️ ${qid}: Reply with your edit instructions for this draft.`);
      }
      continue;
    }

    // ── Regular text messages ─────────────────────────────────────────────
    const text = update.message?.text?.trim() ?? '';
    const chatId = String(update.message?.chat?.id ?? '');
    if (!text || !chatId) continue;
    log(`Cmd [${chatId}]: "${text.slice(0, 80)}"`);

    // Check if this is a reply to a pending edit prompt
    const pendingEditQid = state.pendingEdits[chatId];
    const sendMatch       = text.match(/^send\s+(OQ-\d+)$/i);
    const sendAllLiMatch  = text.match(/^send\s+all\s+li\s+(OQ-\d+(?:\s+OQ-\d+)*)/i);
    const senddmMatch     = text.match(/^senddm\s+(OQ-\d+)$/i);
    const skipMatch       = text.match(/^skip\s+(OQ-\d+)$/i);
    const discardMatch    = text.match(/^discard\s+(OQ-\d+)$/i);
    const editMatch       = text.match(/^edit\s+(OQ-\d+):\s*(.+)/i);

    if (pendingEditQid && !sendMatch && !sendAllLiMatch && !senddmMatch && !skipMatch && !discardMatch && !editMatch) {
      // Free-text reply after tapping Edit button — treat as edit instructions
      const qRow = queueRows.find(r => String(r.id) === pendingEditQid);
      delete state.pendingEdits[chatId];
      if (!qRow) { await tgSend(chatId, `${pendingEditQid}: Not found.`); }
      else {
        await updateRow(String(qRow.row_id), 'outreach_queue', { edit_instruction: text, status: 'edit_requested' });
        await tgSend(chatId, `${pendingEditQid}: Edit saved. Will regenerate in next draft cycle.`);
      }
    } else if (sendAllLiMatch) {
      const qids = sendAllLiMatch[1].trim().toUpperCase().split(/\s+/);
      await tgSend(chatId, `Sending ${qids.length} LinkedIn FU message(s): ${qids.join(', ')}`);
      for (let i = 0; i < qids.length; i++) {
        await handleSend(chatId, qids[i], queueRows, leadRows);
        if (i < qids.length - 1) await randomDelay(3, 6);
      }
      await tgSend(chatId, `Send all done (${qids.length} message(s) attempted).`);
    } else if (sendMatch) {
      await handleSend(chatId, sendMatch[1].toUpperCase(), queueRows, leadRows);
    } else if (senddmMatch) {
      await handleSendDm(chatId, senddmMatch[1].toUpperCase(), queueRows, leadRows);
    } else if (skipMatch) {
      const qid = skipMatch[1].toUpperCase();
      const qRow = queueRows.find(r => String(r.id) === qid);
      if (!qRow) { await tgSend(chatId, `${qid}: Not found.`); continue; }
      await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'skipped', approval_outcome: 'skipped' });
      await tgSend(chatId, `${qid} skipped.`);
    } else if (discardMatch) {
      const qid = discardMatch[1].toUpperCase();
      const qRow = queueRows.find(r => String(r.id) === qid);
      if (!qRow) { await tgSend(chatId, `${qid}: Not found.`); continue; }
      await updateRow(String(qRow.row_id), 'outreach_queue', { status: 'discarded', approval_outcome: 'discarded' });
      await tgSend(chatId, `${qid} discarded.`);
    } else if (editMatch) {
      const qid = editMatch[1].toUpperCase();
      const qRow = queueRows.find(r => String(r.id) === qid);
      if (!qRow) { await tgSend(chatId, `${qid}: Not found.`); continue; }
      await updateRow(String(qRow.row_id), 'outreach_queue', { edit_instruction: editMatch[2].trim(), status: 'edit_requested' });
      await tgSend(chatId, `${qid}: Edit saved. Will regenerate in next draft cycle.`);
    }
  }

  saveState(state);
}

// ---------- LinkedIn URL Discovery ----------
// Runs on startup and every 30 min. Finds leads with outreach_status="linkedin_pending",
// searches Google via Playwright (real browser — not blocked like server IPs),
// writes the URL back, then flips status to "New" so the draft generator can pick them up.

// Validate that a LinkedIn slug plausibly belongs to the searched person.
// Strips trailing ID suffixes (e.g. "joe-j-157b3894" → "joe-j") then checks
// that at least one name word appears in the slug.
function slugMatchesName(slug, fullName) {
  const clean = slug.toLowerCase()
    .replace(/-[a-f0-9]{6,}$/i, '')  // hex suffix: -157b3894
    .replace(/-\d{3,}$/, '');        // numeric suffix: -1234
  const slugWords = clean.split('-').filter(w => w.length > 1);
  const nameWords = fullName.toLowerCase().split(/\s+/).filter(w => w.length > 1);
  return nameWords.some(nw => slugWords.some(sw => sw === nw || sw.startsWith(nw) || nw.startsWith(sw)));
}

function extractSlug(href) {
  const m = href.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]{2,79})/i)
           || href.match(/\/in\/([a-zA-Z0-9\-_%]{2,79})/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).split(/[?#]/)[0].replace(/\/$/, '');
}

// Search via LinkedIn people search (uses the persistent logged-in browser).
// Tries up to 5 results and returns the first whose slug matches the name.
async function searchLinkedInViaBrowser(name, company) {
  const page = await newPage();
  try {
    const q = encodeURIComponent(`${name} ${company}`);
    await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${q}`, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await sleep(2500 + Math.random() * 1000);

    if (page.url().includes('/login') || page.url().includes('/authwall')) {
      log(`[search li] session expired`);
      return null;
    }

    // Collect up to 5 candidate profile links from the results page
    const hrefs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href*="/in/"]'))
        .filter(a => {
          const h = a.getAttribute('href') || '';
          return /\/in\/[a-zA-Z0-9\-_%]{2,}/.test(h) && !h.includes('/in/undefined');
        })
        .map(a => a.getAttribute('href') || a.href)
        .slice(0, 5);
    });

    for (const href of hrefs) {
      const slug = extractSlug(href);
      if (!slug) continue;
      if (slugMatchesName(slug, name)) {
        log(`[search li] matched slug "${slug}" for "${name}"`);
        return `https://www.linkedin.com/in/${slug}/`;
      }
      log(`[search li] slug "${slug}" doesn't match "${name}" — skipping`);
    }
    return null;
  } catch (e) {
    log(`[search li] browser err: ${e.message?.slice(0, 80)}`);
    return null;
  } finally {
    await page.close();
  }
}

async function searchLinkedIn(name, company) {
  const DDG_URL = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${name} ${company} linkedin`)}`;
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  try {
    // Try DuckDuckGo first (fast)
    const resp = await fetch(DDG_URL, { headers: HEADERS });
    const html = await resp.text();
    log(`[search ddg] status=${resp.status} bytes=${html.length}`);

    if (resp.status === 200 && html.length >= 20000) {
      // Check all LinkedIn /in/ matches in the page, pick first that matches the name
      const allMatches = [...html.matchAll(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]{2,79})/gi)];
      for (const m of allMatches) {
        const slug = decodeURIComponent(m[1]).split(/[?#]/)[0].replace(/\/$/, '');
        if (slugMatchesName(slug, name)) {
          const url = `https://www.linkedin.com/in/${slug}/`;
          log(`LinkedIn found (ddg): ${name} → ${url}`);
          return url;
        }
        log(`[search ddg] slug "${slug}" doesn't match "${name}" — skipping`);
      }
      log(`[search ddg] no name-matching slug found in ${allMatches.length} candidate(s)`);
    }

    // DuckDuckGo rate-limited or no validated result — fall back to LinkedIn browser search
    log(`[search ddg] falling back to LinkedIn browser search...`);
    const url = await searchLinkedInViaBrowser(name, company);
    if (url) {
      log(`LinkedIn found (browser): ${name} → ${url}`);
      return url;
    }

    log(`LinkedIn not found: ${name} @ ${company}`);
    return null;
  } catch (e) {
    log(`LinkedIn search err (${name}): ${e.message?.slice(0, 80)}`);
    return null;
  }
}

async function linkedInBackfill() {
  try {
    const leadsBoard = await getBoard('leads');
    const rows = leadsBoard?.data?.datasets?.leads?.rows ?? [];
    const todo = rows.filter(r => !r._deleted_at && r.outreach_status === 'linkedin_pending').slice(0, 10);
    if (todo.length === 0) return; // Fast exit — nothing to do
    log(`LinkedIn backfill: ${todo.length} linkedin_pending leads found`);
    if (_chatId) await tgSend(_chatId, `🔍 LinkedIn backfill: picked up ${todo.length} lead(s) to search`);

    let found = 0;
    const results = [];
    for (const lead of todo) {
      const name = String(lead.name ?? '').trim();
      const company = String(lead.company ?? '').trim();
      if (!name || !company) {
        if (lead.row_id) await updateRow(String(lead.row_id), 'leads', { outreach_status: 'New' });
        results.push(`${name || '?'}: skipped (no name/company)`);
        continue;
      }
      await randomDelay(3, 7);
      const url = await searchLinkedIn(name, company);
      if (lead.row_id) {
        const patch = { outreach_status: 'New' };
        if (url) { patch.linkedIn = url; found++; }
        await updateRow(String(lead.row_id), 'leads', patch);
      }
      results.push(url ? `${name}: ${url}` : `${name}: not found`);
    }
    log(`LinkedIn backfill done: ${found}/${todo.length} URLs found, all flipped to New`);
    if (_chatId) {
      const summary = results.join('\n');
      await tgSend(_chatId, `LinkedIn backfill done: ${found}/${todo.length} found\n\n${summary}`);
    }
  } catch (e) {
    log(`LinkedIn backfill error: ${e.message?.slice(0, 100)}`);
  }
}

const LINKEDIN_BACKFILL_INTERVAL_MS = 30 * 60 * 1000; // 30 min

// ---------- Proactive LinkedIn Reply Check ----------
// Runs every 30 min. Checks LinkedIn inbox for leads where we sent a DM
// and haven't heard back yet. Fires draftReply if a reply is detected.

const LI_REPLY_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 min
let _lastLiReplyCheck = 0;
const LI_REPLY_CHECK_BATCH = 8; // max profiles to visit per run

function getLinkedInSlug(lead) {
  const id = String(lead.linkedin_profile_id ?? '').trim();
  if (id && !id.startsWith('http')) return id;
  const url = String(lead.linkedIn ?? '').trim();
  return url.replace(/.*linkedin\.com\/in\//i, '').replace(/\/$/, '').trim();
}

async function proactiveLinkedInReplyCheck() {
  const now = Date.now();
  if (now - _lastLiReplyCheck < LI_REPLY_CHECK_INTERVAL_MS) return;
  _lastLiReplyCheck = now;

  const leadsBoard = await getBoard('leads');
  const allLeads = leadsBoard?.data?.datasets?.leads?.rows ?? [];
  const queueBoard = await getBoard('outreach_queue');
  const queueRows = queueBoard?.data?.datasets?.outreach_queue?.rows ?? [];

  // Only leads where we sent a DM, still waiting for a LinkedIn reply.
  // Include leads who already responded via email — they may have also replied on LinkedIn.
  const candidates = allLeads.filter(l => {
    if (l._deleted_at) return false;
    if (l.outreach_status === 'Responded' && l.response_channel === 'linkedin') return false;
    if (l.linkedin_status !== 'dm_sent') return false;
    const slug = getLinkedInSlug(l);
    if (!slug) return false;
    // Skip if a reply draft is already pending/sent (don't generate duplicates).
    // No cooldown on discarded/skipped — sequence-based detection handles false positives.
    const hasReplyDraft = queueRows.some(r =>
      !r._deleted_at &&
      String(r.lead_id) === String(l.id) &&
      r.channel === 'linkedin' &&
      String(r.follow_up_number ?? '0') === '-1' &&
      (r.status === 'pending_approval' || r.status === 'sent')
    );
    return !hasReplyDraft;
  }).slice(0, LI_REPLY_CHECK_BATCH);

  if (candidates.length === 0) return;
  log(`LinkedIn reply check: ${candidates.length} dm_sent lead(s)`);

  let found = 0;
  for (const lead of candidates) {
    const slug = getLinkedInSlug(lead);
    const name = String(lead.name ?? '');

    // Find when we last sent a LI message to this lead — the reply must postdate this.
    const sentDmRow = queueRows
      .filter(r =>
        String(r.lead_id) === String(lead.id) &&
        r.channel === 'linkedin' &&
        r.status === 'linkedin_sent'
      )
      .sort((a, b) => new Date(String(b.updated_at ?? 0)).getTime() - new Date(String(a.updated_at ?? 0)).getTime())[0];
    const dmSentAt = sentDmRow?.updated_at ? new Date(String(sentDmRow.updated_at)).getTime() : null;

    await randomDelay(3, 6);
    const replyCheck = await checkLinkedInForReply(slug);
    if (!replyCheck.replied) continue;

    // Temporal filter: skip replies that predate our outreach DM.
    // Prevents old LinkedIn messages (before Ethera outreach) from triggering false reply drafts.
    if (dmSentAt) {
      if (!replyCheck.lastMessageDatetime) {
        // No timestamp extractable from DOM — conservative skip when dmSentAt is known.
        // Real replies have timestamps; missing timestamp means sidebar/profile element mismatch.
        log(`  Reply for ${name}: no timestamp in LinkedIn DOM — skipping (dmSentAt known, treating as pre-DM)`);
        continue;
      }
      const replyTs = new Date(replyCheck.lastMessageDatetime).getTime();
      if (!isNaN(replyTs) && replyTs < dmSentAt) {
        log(`  Reply for ${name} predates our DM (reply: ${replyCheck.lastMessageDatetime}, sent: ${new Date(dmSentAt).toISOString()}) — skipping old reply`);
        continue;
      }
    }

    found++;
    log(`  Reply detected: ${name} (${slug})`);

    // Mark Responded
    if (lead.row_id) {
      await updateRow(String(lead.row_id), 'leads', { outreach_status: 'Responded', response_channel: 'linkedin' }).catch(() => {});
    }

    // Discard pending LI FU drafts for this lead
    const pendingFUs = queueRows.filter(r =>
      String(r.lead_id) === String(lead.id) &&
      r.channel === 'linkedin' &&
      r.status === 'pending_approval' &&
      String(r.follow_up_number ?? '0') !== '-1'
    );
    for (const row of pendingFUs) {
      await updateRow(String(row.row_id), 'outreach_queue', { status: 'discarded', approval_outcome: 'prospect_replied_li' }).catch(() => {});
    }

    await draftReply(_chatId, lead, 'linkedin', replyCheck.lastMessage, slug);
  }
  if (candidates.length > 0) log(`LinkedIn reply check done: ${found}/${candidates.length} replied`);
}

// ---------- Start ----------

const state = loadState();
log('LinkedIn Runner started. Ctrl+C to stop.');

async function sendStartupPing() {
  try {
    const metaBoard = await getBoard('meta');
    const metaRows = metaBoard?.data?.datasets?.meta?.rows ?? [];
    const chatIdRow = metaRows.find(r => r.key === 'etherabot_chat_id');
    const chatId = chatIdRow?.value;
    if (chatId) {
      _chatId = chatId;
      await tgSend(chatId, `LinkedIn Runner online (Playwright mode).\nDraft previews have [Send] [Skip] [Edit] buttons.\nOr type: send OQ-XXXX | skip OQ-XXXX | edit OQ-XXXX: [instructions]\nBatch: send all li OQ-XXXX OQ-YYYY...`);
      log(`Startup ping sent to chat ${chatId}`);
    }
  } catch (e) {
    log(`Startup ping failed: ${e.message}`);
  }
}

// ---------- Discard Stale Brains Drafts ----------
// The automation can't call discard_action (blocked in sandbox).
// It marks rows status="discarded" and stores the draft_id.
// This loop runs every 30 min and cleans them up from outside the sandbox.

// Mirror the automation's stale thresholds so the runner discards within the 1h brains TTL
const TEST_STALE_EMAIL_MS = 8 * 60 * 60 * 1000;   // 8h for testing
const PROD_STALE_EMAIL_MS = 20 * 60 * 60 * 1000; // 20h
const STALE_LI_MS = 24 * 60 * 60 * 1000;         // 24h — same as automation
const TEST_STALE_LI_MS = 8 * 60 * 60 * 1000;     // 8h for TEST leads
function isTestLead(id) { return String(id).toUpperCase().startsWith('TEST-'); }

async function discardStaleDrafts() {
  try {
    const now = Date.now();
    const queueBoard = await getBoard('outreach_queue');
    const rows = queueBoard?.data?.datasets?.outreach_queue?.rows ?? [];

    // Proactively find pending_approval email rows past stale threshold (draft still live in brains)
    const proactive = rows.filter(r => {
      if (r._deleted_at || r.channel !== 'email' || r.status !== 'pending_approval') return false;
      const draftId = String(r.draft_id ?? '').trim();
      if (!draftId || _processedDraftIds.has(draftId)) return false;
      const ageMs = r.created_at ? now - new Date(String(r.created_at)).getTime() : 0;
      const threshold = isTestLead(String(r.lead_id ?? '')) ? TEST_STALE_EMAIL_MS : PROD_STALE_EMAIL_MS;
      return ageMs > threshold;
    });

    // Already-discarded rows with leftover draft_id (automation marked them; runner cleans up)
    // Only try rows created within the last 2h — brains drafts expire after 1h, older ones are gone.
    const alreadyDiscarded = rows.filter(r => {
      if (r._deleted_at || r.status !== 'discarded') return false;
      if (String(r.draft_id ?? '').trim().length === 0) return false;
      if (_processedDraftIds.has(String(r.draft_id).trim())) return false;
      const ageMs = r.created_at ? now - new Date(String(r.created_at)).getTime() : Infinity;
      return ageMs < 2 * 60 * 60 * 1000; // skip anything older than 2h — draft already expired
    });

    // Stale pending LinkedIn notes (no brains draft — just mark discarded on board)
    const staleLinkedIn = rows.filter(r => {
      if (r._deleted_at || r.channel !== 'linkedin' || r.status !== 'pending_approval') return false;
      if (_processedDraftIds.has(String(r.row_id))) return false;
      const ageMs = r.created_at ? now - new Date(String(r.created_at)).getTime() : 0;
      const liThreshold = isTestLead(String(r.lead_id ?? '')) ? TEST_STALE_LI_MS : STALE_LI_MS;
      return ageMs > liThreshold;
    });

    if (proactive.length === 0 && alreadyDiscarded.length === 0 && staleLinkedIn.length === 0) return;
    if (proactive.length > 0) log(`Proactive stale discard: ${proactive.length} pending email draft(s)`);
    if (staleLinkedIn.length > 0) log(`Stale LinkedIn cleanup: ${staleLinkedIn.length} pending note(s)`);
    if (alreadyDiscarded.length > 0) log(`Draft cleanup: ${alreadyDiscarded.length} already-discarded row(s)`);

    // Need leads for smart status reset
    const leadsBoard = await getBoard('leads');
    const leadRows = leadsBoard?.data?.datasets?.leads?.rows ?? [];

    for (const row of proactive) {
      const draftId = String(row.draft_id).trim();
      _processedDraftIds.add(draftId);
      try {
        await brainsTool('discard_action', { draft_id: draftId });
        log(`  Discarded draft ${draftId} (${row.id})`);
      } catch (e) {
        log(`  discard_action err (${row.id}): ${e.message?.slice(0, 80)}`);
      }
      // Mark queue row discarded
      try {
        await updateRow(String(row.row_id), 'outreach_queue', { status: 'discarded', approval_outcome: 'auto_discarded_stale' });
      } catch (e) { log(`  queue update err (${row.id}): ${e.message?.slice(0, 60)}`); }
      // Reset lead status
      const leadId = String(row.lead_id ?? '');
      const fuNum = parseInt(String(row.follow_up_number ?? '0'), 10);
      const lead = leadRows.find(l => String(l.id) === leadId);
      if (lead?.row_id) {
        const patch = fuNum === 0
          ? { outreach_status: 'New' }
          : { outreach_status: 'Sent', follow_up_count: String(fuNum - 1), follow_up_due_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() };
        try {
          await updateRow(String(lead.row_id), 'leads', patch);
          log(`  Reset lead ${leadId}: ${JSON.stringify(patch)}`);
        } catch (e) { log(`  lead reset err (${leadId}): ${e.message?.slice(0, 60)}`); }
      }
    }

    for (const row of alreadyDiscarded) {
      const draftId = String(row.draft_id).trim();
      _processedDraftIds.add(draftId);
      try {
        await brainsTool('discard_action', { draft_id: draftId });
        log(`  Discarded draft ${draftId} (${row.id})`);
      } catch (e) {
        log(`  discard_action err (${row.id}): ${e.message?.slice(0, 80)}`);
      }
    }

    for (const row of staleLinkedIn) {
      _processedDraftIds.add(String(row.row_id)); // use row_id as dedup key (no draft_id for LI)
      try {
        await updateRow(String(row.row_id), 'outreach_queue', { status: 'discarded', approval_outcome: 'auto_discarded_stale' });
        log(`  Discarded stale LI note (${row.id}) for ${row.lead_name}`);
      } catch (e) {
        log(`  LI discard err (${row.id}): ${e.message?.slice(0, 60)}`);
      }
    }
  } catch (e) {
    log(`Draft cleanup error: ${e.message?.slice(0, 100)}`);
  }
}

async function loop() {
  try { await poll(state); } catch (e) { log(`Poll error: ${e.message?.slice(0, 100)}`); }
  try { await linkedInBackfill(); } catch (e) { log(`Backfill error: ${e.message?.slice(0, 100)}`); }
  try { await discardStaleDrafts(); } catch (e) { log(`Cleanup error: ${e.message?.slice(0, 100)}`); }
  try { await proactiveLinkedInReplyCheck(); } catch (e) { log(`LI reply check error: ${e.message?.slice(0, 100)}`); }
  const jitter = (Math.random() - 0.5) * 16_000;
  setTimeout(loop, POLL_INTERVAL_MS + jitter);
}

await loadCCConfig();
await sendStartupPing();
await pingHeartbeat();
setInterval(() => { pingHeartbeat().catch(() => {}); }, 5 * 60 * 1000);

// Verify session on startup
log('Checking LinkedIn session...');
const sessionOk = await isLoggedIn();
if (!sessionOk) {
  log('Session expired or not set up. Run: node login.mjs');
  const metaBoard = await getBoard('meta').catch(() => null);
  const metaRows = metaBoard?.data?.datasets?.meta?.rows ?? [];
  const chatIdRow = metaRows.find(r => r.key === 'etherabot_chat_id');
  if (chatIdRow?.value) {
    await tgSend(chatIdRow.value, 'LinkedIn session expired. Run:\n  node login.mjs\nthen:\n  pm2 restart linkedin-runner');
  }
} else {
  log('Session valid.');
}

await loop();
