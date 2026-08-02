#!/usr/bin/env node
// agent4-local.mjs — Agent 4 (local runner, simplified)
//
// Only job: detect completed external meetings, fetch Granola transcript,
// queue to Prospector board for the brains automation to process.
//
// All CRM writing, LLM processing, OQ rows, Telegram, and FU scheduling
// are handled by the brains automation (agent4-crm-automation in brains).
//
// pm2:
//   pm2 start agent4-local.mjs --name agent4-local --cron "*/5 * * * *" --no-autorestart
//
// Flags:
//   --test             Inject fake Worldpay meeting, run in TEST_MODE
//   AGENT4_TEST_MODE=true  pm2 safe mode: real calendar, queues with test_mode=true flag

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync, execSync } from 'child_process';

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH   = join(__dir, '.linkedin-runner.env');
const STATE_PATH = join(__dir, '.agent4-state.json');
let BOARD_ID   = '95dcb668-e2d9-4093-9a3e-3200901846fa'; // Prospector board (overridden by CC board at startup)
let CRM_BOARD  = '1de2a9f5-03cd-427e-9bb4-9198ed336f62'; // CRM board (overridden by CC board at startup)
let CC_BOARD_ID = process.env.CC_BOARD_ID || '2907a47b-b179-452e-b9de-042367012bf0';
const BRAINS_MCP = 'https://mcp.mybrains.ai/mcp';

const INJECT_TEST_MEETING = process.argv.includes('--test');
const TEST_MODE = INJECT_TEST_MEETING || process.env.AGENT4_TEST_MODE === 'true';

const ENDED_MIN_MS = 10 * 60 * 1000;
const ENDED_MAX_MS = 25 * 60 * 1000;

const NOISE_DOMAINS = new Set([
  'gmail.com','googlemail.com','yahoo.com','outlook.com','hotmail.com',
  'live.com','icloud.com','me.com','protonmail.com','pm.me',
  'zoom.us','teams.microsoft.com','webex.com','meet.google.com',
  'calendly.com','hubspot.com','linkedin.com','notion.so',
  'ssvlabs.io','ethera.io',
]);

const DOMAIN_MAP = {
  'hsbc.com':'HSBC','jpmorgan.com':'JPMorgan','jpmchase.com':'JPMorgan',
  'ms.com':'Morgan Stanley','goldmansachs.com':'Goldman Sachs','gs.com':'Goldman Sachs',
  'blackrock.com':'BlackRock','bnymellon.com':'BNY Mellon',
  'statestreet.com':'State Street','db.com':'Deutsche Bank',
  'deutschebank.com':'Deutsche Bank','ubs.com':'UBS','barclays.com':'Barclays',
  'bnpparibas.com':'BNP Paribas','societegenerale.com':'Societe Generale',
  'citi.com':'Citi','citibank.com':'Citi','citigroup.com':'Citi',
  'swift.com':'SWIFT','dtcc.com':'DTCC','euroclear.com':'Euroclear',
  'clearstream.com':'Clearstream','fireblocks.com':'Fireblocks',
  'coinbase.com':'Coinbase','circle.com':'Circle','paxos.com':'Paxos',
  'anchorage.com':'Anchorage','worldpay.com':'Worldpay','fis.com':'FIS',
  'mastercard.com':'Mastercard','visa.com':'Visa',
  'uob.com.sg':'UOB','dbs.com.sg':'DBS','ocbc.com.sg':'OCBC',
  'mas.gov.sg':'MAS','hkma.gov.hk':'HKMA',
  'a16z.com':'a16z','paradigm.xyz':'Paradigm',
  'block.xyz':'Block','squareup.com':'Block',
};

// ---------- Env ----------

function loadEnv() {
  if (!existsSync(ENV_PATH)) { console.error(`Missing ${ENV_PATH}`); process.exit(1); }
  const cfg = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!cfg.BRAINS_TOKEN) { console.error('Missing BRAINS_TOKEN'); process.exit(1); }
  if (cfg.CC_BOARD_ID) CC_BOARD_ID = cfg.CC_BOARD_ID;
  return cfg;
}

// ---------- State ----------

function loadState() {
  if (!existsSync(STATE_PATH)) return { processed: [] };
  try {
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (!s.processed) s.processed = [];
    return s;
  }
  catch { return { processed: [] }; }
}
function saveState(s) { writeFileSync(STATE_PATH, JSON.stringify(s, null, 2)); }

// ---------- Logging ----------

function log(msg) { console.log(`[${new Date().toISOString().slice(0, 19)}] ${msg}`); }

// ---------- Brains ----------

let _brainsToken = '';
async function brainsTool(name, args) {
  const res = await fetch(BRAINS_MCP, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${_brainsToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1 }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`MCP ${name}: ${JSON.stringify(data.error)}`);
  const text = data.result?.content?.[0]?.text ?? '{}';
  try { return JSON.parse(text); } catch { return text; }
}

// ---------- CC Board config ----------

async function loadCCConfig() {
  try {
    const ccBoard = await brainsTool('get_board', { board_id: CC_BOARD_ID, dataset: 'meta', limit: 10 });
    const rows = ccBoard?.data?.datasets?.meta?.rows ?? [];
    const setupRow = rows.find(r => r.key === 'cc_setup');
    if (setupRow) {
      const setup = JSON.parse(String(setupRow.value ?? '{}'));
      if (setup.prospector_id) BOARD_ID = setup.prospector_id;
      if (setup.crm_id) CRM_BOARD = setup.crm_id;
      log(`CC config loaded (cc=${CC_BOARD_ID.slice(0,8)}) prospector=${BOARD_ID.slice(0,8)} crm=${CRM_BOARD.slice(0,8)}`);
    } else {
      log(`CC config: cc_setup row not found — using hardcoded defaults`);
    }
  } catch (e) {
    log(`CC config load failed: ${e.message?.slice(0, 80)} — using hardcoded defaults`);
  }
}

// ---------- Helpers ----------

function extractCompanyFromTitle(title) {
  const xMatch = title.match(/(?:Ethera|ethera)\s*[x×]\s*(.+?)(?:\s*[-|({]|$)/i);
  if (xMatch) return xMatch[1].trim().replace(/\s+(intro|call|meeting|demo|sync)$/i, '').trim();
  const withMatch = title.match(/(?:call|intro|meeting|chat|sync|discussion|demo|catch-?up)\s+with\s+(.+?)(?:\s*[-|({]|$)/i);
  if (withMatch) return withMatch[1].trim();
  return '';
}

function extractCompanyFromDomain(domain) {
  if (DOMAIN_MAP[domain]) return DOMAIN_MAP[domain];
  const parts = domain.split('.');
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

function getExternalAttendees(event) {
  return (event.attendees ?? []).filter(a => {
    if (a.self) return false;
    return !NOISE_DOMAINS.has((a.email?.split('@')[1] ?? '').toLowerCase());
  });
}

// ---------- Granola fetch (Claude subprocess) ----------
// Fetches structured meeting notes from Granola.
// Granola is a Claude MCP tool — only accessible via subprocess.
// Google Drive Meet Recordings are fetched separately via brains directly (no subprocess needed).

function dateRange(sgtDate, deltaDays) {
  const d = new Date(sgtDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function fetchGranolaTranscript(event, companyName, sgtDate) {
  const external = getExternalAttendees(event);
  const attendeeNames  = external.map(a => a.displayName ?? a.email).join(', ');
  const attendeeEmails = external.map(a => a.email).join(', ');

  const rangeStart = dateRange(sgtDate, -3);
  const rangeEnd   = dateRange(sgtDate, +3);

  const prompt = `Find the Granola meeting notes for: "${event.title}".
Company: ${companyName}
Attendees: ${attendeeNames} (${attendeeEmails})
Meeting date: ${sgtDate} (search window: ${rangeStart} to ${rangeEnd} — notes may be logged 1-3 days before or after the meeting)

Use mcp__claude_ai_Granola__list_meetings or mcp__claude_ai_Granola__query_granola_meetings to search for this meeting by title. Check any matches within the date range ${rangeStart} to ${rangeEnd}.
If found, use mcp__claude_ai_Granola__get_meeting_transcript or the get-document-panels tool for the full structured notes/summary.

Return ONLY this JSON, no preamble or explanation:
{
  "found": true | false,
  "transcript": "Full meeting notes text including all key points, decisions, and signals. Empty string if not found."
}`;

  let claudeBin = 'claude';
  try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim() || 'claude'; } catch {}

  const granolaTools = [
    'mcp__claude_ai_Granola__list_meetings',
    'mcp__claude_ai_Granola__query_granola_meetings',
    'mcp__claude_ai_Granola__get_meeting_transcript',
    'mcp__claude_ai_Granola__get_meetings',
  ].join(',');

  const result = spawnSync(claudeBin, ['-p', prompt, '--allowedTools', granolaTools], {
    cwd: __dir,
    timeout: 2 * 60 * 1000,
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
    env: { ...process.env },
  });

  if (result.error || result.status !== 0) {
    log(`  Granola subprocess error: ${result.error?.message ?? (result.stderr ?? '').slice(0, 150)}`);
    return null;
  }

  const jsonMatch = (result.stdout ?? '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) { log(`  No JSON in Granola output`); return null; }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.found || !String(parsed.transcript ?? '').trim()) return null;
    return { notesSource: 'granola', transcript: String(parsed.transcript) };
  } catch (e) { log(`  Granola JSON parse: ${e.message}`); return null; }
}

// ---------- Drive transcript fetch (direct brains call) ----------
// Searches Google Drive Meet Recordings folder for a transcript of this meeting.
// Called directly from Node using the full BRAINS_TOKEN — no subprocess or permission prompt needed.

async function fetchDriveTranscript(event, companyName, sgtDate) {
  const titleKeywords = event.title.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  const rangeStart = dateRange(sgtDate, -3);
  const rangeEnd   = dateRange(sgtDate, +3);

  try {
    // Pull matching Drive files into brains pages
    await brainsTool('fetch_from_integration', {
      source: 'drive',
      request: `Meet Recordings transcript or notes for "${titleKeywords}" around ${sgtDate} (search ${rangeStart} to ${rangeEnd}). Look in the Meet Recordings folder for .txt or .vtt transcript files.`,
    });
  } catch (e) {
    log(`  Drive fetch_from_integration error: ${e.message}`);
    return null;
  }

  // Search for the ingested page — use company name only, no date, since recording may be dated differently
  let pages = [];
  try {
    const searchRes = await brainsTool('search', {
      q: `${companyName} ${titleKeywords}`,
      type: 'gdrive_file',
      limit: 5,
    });
    pages = searchRes?.results ?? [];
  } catch (e) {
    log(`  Drive search error: ${e.message}`);
    return null;
  }

  // Read the most relevant page
  for (const page of pages) {
    const slug = page.slug ?? page.id ?? '';
    if (!slug) continue;
    try {
      const fullPage = await brainsTool('get_page', { slug });
      const transcript = String(fullPage?.text ?? fullPage?.body ?? fullPage?.content ?? '').trim();
      if (transcript.length > 100) {
        log(`  Drive transcript found: "${page.title}" (${transcript.length} chars)`);
        return { notesSource: 'drive', transcript };
      }
    } catch (e) { /* try next */ }
  }

  return null;
}

// ---------- syncCommittedDrafts ----------
// Picks up crm_draft rows marked 'committed' by the brains automation and writes
// them to the CRM board using the full user token (which has cross-brain access).

async function syncCommittedDrafts() {
  const draftB = await brainsTool('get_board', { board_id: BOARD_ID, dataset: 'crm_draft', limit: 100 });
  const drafts = draftB?.data?.datasets?.crm_draft?.rows ?? [];
  const committed = drafts.filter(r => r.status === 'committed');
  if (committed.length === 0) return;

  log(`syncCommittedDrafts: ${committed.length} draft(s) to sync.`);

  const [crmCompB, crmLeadsB, crmMeetB] = await Promise.all([
    brainsTool('get_board', { board_id: CRM_BOARD, dataset: 'companies', limit: 200 }),
    brainsTool('get_board', { board_id: CRM_BOARD, dataset: 'leads', limit: 200 }),
    brainsTool('get_board', { board_id: CRM_BOARD, dataset: 'meetings', limit: 200 }),
  ]);

  const companies = crmCompB?.data?.datasets?.companies?.rows ?? [];
  const leads     = crmLeadsB?.data?.datasets?.leads?.rows ?? [];
  const meetings  = crmMeetB?.data?.datasets?.meetings?.rows ?? [];

  let maxMT = meetings.reduce((max, r) => {
    const n = parseInt(String(r.row_id ?? '').replace('MT-', '').replace(/^0+/, ''), 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);

  for (const draft of committed) {
    const { row_id: draftRowId, draft_id, cd_meeting_title, cd_date, cd_company,
            company_id, lead_id, lead_name, meeting_notes, outcome, next_steps,
            update_text, suggested_status, cd_test_mode } = draft;
    const isTest = String(cd_test_mode ?? '') === 'true';
    const now    = new Date().toISOString();

    // Match company: exact ID first, then fuzzy by name (company_id is empty when CRM was unavailable at draft creation time)
    let crmCompany = company_id
      ? companies.find(c => String(c.row_id ?? '') === String(company_id ?? ''))
      : null;
    if (!crmCompany) {
      const nl = String(cd_company ?? '').toLowerCase().trim().replace(/^test-/i, '');
      crmCompany = nl ? companies.find(c => {
        const cn = String(c.name ?? '').toLowerCase().trim();
        return cn && (cn.includes(nl) || nl.includes(cn));
      }) : null;
    }
    if (!crmCompany) {
      log(`  ${draft_id}: no company match for "${cd_company}" — skipping.`);
      continue;
    }

    // Match lead: exact ID first, then fuzzy by name
    let crmLead = lead_id
      ? leads.find(l => String(l.row_id ?? '') === String(lead_id ?? ''))
      : null;
    if (!crmLead && lead_name) {
      const nl = String(lead_name ?? '').toLowerCase().trim().replace(/^test-/i, '');
      crmLead = nl ? leads.find(l => {
        const ln = String(l.name ?? '').toLowerCase().trim();
        return ln && (ln.includes(nl) || nl.includes(ln));
      }) : null;
    }

    // Dedup: skip meeting write if native agent (matthiasetherabot) already committed it
    const existingMeeting = meetings.find(m => {
      const titleMatch = String(m.title ?? '').toLowerCase().trim() === String(cd_meeting_title ?? '').toLowerCase().trim();
      const dateMatch  = String(m.date ?? '').slice(0, 10) === String(cd_date ?? '').slice(0, 10);
      return titleMatch && dateMatch;
    });
    if (existingMeeting) {
      log(`  ${draft_id}: meeting already exists (${existingMeeting.row_id}) — skipping write, marking synced.`);
      await brainsTool('update_board_row', {
        board_id: BOARD_ID, dataset: 'crm_draft', row_id: String(draftRowId),
        patch: { status: 'synced', meeting_id: String(existingMeeting.row_id ?? ''), synced_at: now },
      });
      continue;
    }

    maxMT++;
    const newMeetingId = `MT-${String(maxMT).padStart(4, '0')}`;

    try {
      await brainsTool('append_board_rows', {
        board_id: CRM_BOARD, dataset: 'meetings',
        rows: [{
          row_id: newMeetingId,
          title: cd_meeting_title, date: cd_date, company: cd_company,
          format: 'Video', attendees: crmLead ? [crmLead.name] : [],
          notes: String(meeting_notes ?? ''), outcome: String(outcome ?? ''),
          next_steps: String(next_steps ?? ''), company_id: String(crmCompany.row_id ?? ''),
          _updated_at: now,
        }],
      });
    } catch (e) {
      log(`  ${draft_id}: meeting write error: ${e.message} — skipping.`);
      continue;
    }

    try {
      const existingNotes = String(crmCompany.notes ?? '').trim();
      const patch = {
        notes: (existingNotes ? `${existingNotes}\n\n[${cd_date}] ${update_text}` : `[${cd_date}] ${update_text}`).slice(0, 10000),
        last_meeting: cd_date,
      };
      if (suggested_status) patch.status = suggested_status;
      await brainsTool('update_board_row', { board_id: CRM_BOARD, dataset: 'companies', row_id: String(crmCompany.row_id), patch });
    } catch (e) { log(`  ${draft_id}: company update error: ${e.message}`); }

    if (crmLead?.row_id) {
      try {
        const leadNotes = String(crmLead.notes ?? '').trim();
        await brainsTool('update_board_row', {
          board_id: CRM_BOARD, dataset: 'leads', row_id: String(crmLead.row_id),
          patch: {
            notes: (leadNotes ? `${leadNotes}\n\n[${cd_date}] ${update_text}` : `[${cd_date}] ${update_text}`).slice(0, 10000),
            last_contact: cd_date,
          },
        });
      } catch (e) { log(`  ${draft_id}: lead update error: ${e.message}`); }
    }

    await brainsTool('update_board_row', {
      board_id: BOARD_ID, dataset: 'crm_draft', row_id: String(draftRowId),
      patch: { status: 'synced', meeting_id: newMeetingId, synced_at: now },
    });
    log(`  ${draft_id} -> ${newMeetingId} synced${isTest ? ' [TEST]' : ''}.`);
  }
}

// ---------- Heartbeat ----------

async function pingHeartbeat() {
  const value = JSON.stringify({ status: 'running', last_ping: new Date().toISOString() });
  try {
    const metaBoard = await brainsTool('get_board', { board_id: CC_BOARD_ID, dataset: 'meta', limit: 50 });
    const rows = metaBoard?.data?.datasets?.meta?.rows ?? [];
    const existing = rows.find(r => r.key === 'runner_agent4_ping');
    if (existing?.row_id) {
      await brainsTool('update_board_row', { board_id: CC_BOARD_ID, dataset: 'meta', row_id: String(existing.row_id), patch: { value } });
    } else {
      await brainsTool('append_board_rows', { board_id: CC_BOARD_ID, dataset: 'meta', rows: [{ key: 'runner_agent4_ping', value }] });
    }
    log('Heartbeat OK');
  } catch (e) {
    log(`Heartbeat error: ${e.message?.slice(0, 60)}`);
  }
}

// ---------- Main ----------

async function main() {
  const cfg = loadEnv();
  _brainsToken = cfg.BRAINS_TOKEN;
  await loadCCConfig();
  try { await pingHeartbeat(); } catch (e) { log(`Heartbeat error: ${e.message}`); }

  const state  = loadState();
  const nowMs  = Date.now();
  const sgtDate = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

  log(`Agent 4 (local)${TEST_MODE ? ' [TEST MODE]' : ''} — ${sgtDate}`);

  // syncCommittedDrafts removed — Agent 4 brains automation now writes CRM directly (v13)

  let toProcess;

  if (INJECT_TEST_MEETING) {
    const fakeEndMs  = nowMs - 15 * 60 * 1000;
    const fakeStartMs = fakeEndMs - 45 * 60 * 1000;
    toProcess = [{
      id: 'TEST_WORLDPAY_MEETING',
      title: 'Ethera x Worldpay intro',
      event_start: new Date(fakeStartMs).toISOString(),
      event_end:   new Date(fakeEndMs).toISOString(),
      status: 'confirmed',
      attendees: [
        { email: 'matthias@ssvlabs.io', self: true },
        { email: 'ali.albalaghi@worldpay.com', self: false, displayName: 'Ali AlBalaghi' },
      ],
    }];
    log(`[TEST] Injected: "Ethera x Worldpay intro" (ended 15 min ago)`);
  } else {
    let calResult;
    try {
      calResult = await brainsTool('list_calendar_events', {
        start: sgtDate + 'T00:00:00+08:00',
        end:   sgtDate + 'T23:59:59+08:00',
        limit: 50,
      });
    } catch (e) {
      log(`Calendar fetch error: ${e.message}`);
      return;
    }

    const events = (calResult?.results ?? []).filter(e => e.status !== 'cancelled');
    toProcess = events.filter(e => {
      const endMs  = new Date(e.event_end ?? e.event_start).getTime();
      const diffMs = nowMs - endMs;
      if (diffMs < ENDED_MIN_MS || diffMs > ENDED_MAX_MS) return false;
      return getExternalAttendees(e).length > 0;
    });

    if (toProcess.length === 0) {
      log('No completed external meetings in window — done.');
      return;
    }
  }

  log(`${toProcess.length} meeting(s) to process.`);

  for (const event of toProcess) {
    const meetingKey = `${event.id ?? event.title}_${sgtDate}`;
    if (state.processed.includes(meetingKey)) {
      log(`Already processed: ${event.title}`);
      continue;
    }

    log(`Processing: "${event.title}"`);

    const external = getExternalAttendees(event);
    let company = extractCompanyFromTitle(event.title);
    if (!company && external[0]) {
      company = extractCompanyFromDomain((external[0].email.split('@')[1] ?? '').toLowerCase());
    }
    if (!company) company = 'Unknown';
    log(`  Company: ${company}`);

    // In test mode, use hardcoded transcript so the row is complete on write (no cron race)
    let result;
    if (INJECT_TEST_MEETING) {
      result = {
        notesSource: 'test',
        transcript: `Meeting: Ethera x Worldpay intro
Date: ${sgtDate}
Attendees: Ali AlBalaghi (ali.albalaghi@worldpay.com, Worldpay), Matthias Ang (Ethera)

Summary:
Introductory call to explore Ethera settlement infrastructure for Worldpay.

Ali explained that Worldpay processes $2T+ in payment volume annually and is evaluating blockchain-based settlement rails to reduce correspondent banking costs and accelerate cross-border settlement cycles from T+2 to near real-time.

Matthias presented Ethera's sovereign permissioned chain approach — each financial institution gets its own chain that connects to public Ethereum only when needed for liquidity or final settlement. No public chain exposure for day-to-day operations.

Key discussion points:
- Worldpay interested in how Ethera handles end-to-end fund flow: merchant -> acquirer -> Worldpay -> correspondent -> beneficiary bank
- Ali asked for a detailed fund flow diagram showing exactly how settlement works with Ethera in the stack, including tokenized positions and netting
- Discussed potential integration paths: Fireblocks for institutional custody, Zero Hash or BVNK as stablecoin/tokenized fiat rails on top of Ethera
- Worldpay runs Visa/Mastercard scheme rails and needs any solution to be scheme-agnostic

Action items agreed:
1. SSV/Ethera to send Worldpay fund flow diagrams showing how end-to-end settlement works with Ethera infrastructure — Ali specifically requested this to share with their head of settlement innovation
2. Ethera to prepare a brief on how integration via Fireblocks, Zero Hash, and BVNK would work in practice for Worldpay's use case — covering custody model, stablecoin issuance, and redemption flow

Next steps:
- Ethera sends both documents within 1 week
- Follow-up call in 2 weeks after Ali reviews with internal team
- Ali to loop in Worldpay head of settlement innovation for next call`,
      };
      log(`  [TEST] Using hardcoded transcript (skipping Granola/Drive fetch).`);
    } else {
      // Try Granola first (subprocess, pre-approved tools), then Drive directly via brains
      log(`  Fetching transcript — trying Granola...`);
      result = fetchGranolaTranscript(event, company, sgtDate);

      if (!result) {
        log(`  Granola returned nothing — trying Google Drive Meet Recordings...`);
        result = await fetchDriveTranscript(event, company, sgtDate);
      }

      if (!result) {
        log('  No transcript found in Granola or Drive — queuing with empty transcript for LLM to work from context.');
        result = { notesSource: 'none', transcript: '' };
      }
    }

    log(`  Source: ${result.notesSource} — queuing for brains automation.`);

    const attendeeStr = external
      .map(a => `${a.displayName ?? a.email} (${a.email})`)
      .join(', ');

    try {
      await brainsTool('append_board_rows', {
        board_id: BOARD_ID,
        dataset:  'transcript_queue',
        rows: [{
          meeting_title:      event.title,
          tq_date:            sgtDate,
          company,
          external_attendees: attendeeStr,
          transcript:         String(result.transcript ?? '').slice(0, 20000),
          notes_source:       result.notesSource ?? 'none',
          processed:          'false',
          test_mode:          TEST_MODE ? 'true' : 'false',
          tq_created_at:      new Date().toISOString(),
        }],
      });
      log(`  Queued. Brains automation will handle CRM write + email + Telegram.`);
    } catch (e) {
      log(`  Queue error: ${e.message} — will retry next tick.`);
      continue;
    }

    // Mark processed (always, to avoid re-queuing on next tick)
    state.processed.push(meetingKey);
    if (state.processed.length > 100) state.processed = state.processed.slice(-100);
    saveState(state);
    log(`  Done.`);
  }

  log('Agent 4 (local) complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
