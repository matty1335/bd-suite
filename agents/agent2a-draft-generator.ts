// ============================================================
// Agent 2A: Ethera Outreach Draft Generator
// Brains automation ID: c17055be-4f42-4487-8acf-16f3be220bfe
// Version: 182 — read test_mode from cc_setup (no more hardcoded TEST_MODE=true); known_platform_users absent = [] (recipe-general)
// Cron: */30 * * * * (every 30 min)
// Description: Picks up to 10 New leads with emails, detects Besu/fresh-start angle,
//              fetches recent news, generates personalized email + LinkedIn connection
//              note via LLM, writes to outreach_queue, sends drafts to Telegram.
// ============================================================

//
// ETHERA AGENT 2A - DRAFT GENERATOR v177
// v177: Campaign-awareness. Reads active campaign config from Control Centre board
//       (2907a47b) at startup. SENDER_IDENTITY, PRODUCT_NAME, ACTIVE_PITCH_BLOCK,
//       BESU_PITCH_BLOCK, EMAIL_CTA_STYLE, EMAIL_WORD_COUNT, SENDER_FIRST_NAME all
//       driven by campaign. Falls back to hardcoded Ethera defaults if no campaign.
//       All prompts and sign-offs updated to use dynamic vars.
// v176: Add Best,\nMatthias sign-off to LI reply drafts (checkLinkedInReplies). Slice to 280+sign-off.
// v175: Add Best,\nMatthias sign-off to email reply drafts (checkEmailReplies).
// v174: Restore TEST_MODE=true (production safety). v172 test confirmed checkEmailReplies works.
// v171: Add 'Best,\nMatthias' sign-off to LI DM FU messages. Prompt instructs LLM
//       to omit sign-off; we slice body to 370 chars and append it ourselves.
// v170 (deployed): v168 revert — keeps pushToEtheraBot routing to etheraoutreachbot.
// v158: FU email threading fix: don't create brains draft for FU emails. Store gmail_thread_id on
//       OQ row instead. Agent 2B reads it and calls act_on_integration+confirm_action with thread_id.
// ============================================================

let BOARD_ID      = "95dcb668-e2d9-4093-9a3e-3200901846fa";
const _ccSecret   = "{{cc_board_id}}";
const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
const _gmailSecret = "{{gmail_install_id}}";
const GMAIL_INSTALL_ID: string | null = _gmailSecret.startsWith("{{") ? null : _gmailSecret;
const TG_BASE = "https://api.telegram.org/bot{{telegram_bot_id}}:{{telegram_bot_secret}}";
const BATCH_SIZE = 10;
let TEST_MODE = true;
let TEST_ONLY_MODE = true;
let TEST_EMAIL = "matthias@ssvlabs.io";
let SENDER_EMAIL = "matthias@ssvlabs.io";
const TEST_STALE_EMAIL_MS = 8 * 60 * 60 * 1000;
const PROD_STALE_EMAIL_MS = 20 * 60 * 60 * 1000;
const TEST_STALE_LI_MS = 8 * 60 * 60 * 1000;
const PROD_STALE_LI_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;
const DRAFT_EXPIRY_MS = 60 * 60 * 1000;
const CLEANUP_WINDOW_MS = 48 * 60 * 60 * 1000;

let SCHEDULING_URL = "https://calendar.google.com/calendar/appointments/schedules/AcZssZ0IBUnMuZAL_MD7FiF-otefRSq9yo1sxKcGpN57rwuBpGLzcsaCzGz8vUWfTtVSAK5n6uZirF8g";
let SCHEDULING_LINE = `Book a 20-minute call here: ${SCHEDULING_URL}`;

const ANGLE1_PITCH = `Ethera ships as a Besu upgrade. Procurement clearance, CISO sign-off, compliance filings - already done. No rip-and-replace. No new procurement cycle. Full sovereignty preserved. What changes: assets now settle atomically with other institutions on the network, ZK-proven, with final settlement on Ethereum. Compresses a 3-5 year bank sale into a single upgrade cycle. Traction: 100+ institutional conversations, 4 partners moving to deployment. SSV Labs: 7M+ ETH staked, 20% of all staked ETH, inventors of DVT.`;

const ANGLE2_PITCH = `The window is open - GENIUS Act, MiCA, BIS framework for tokenized deposits, CEO-level conviction (Fink, Dimon). But the failure pattern from 2016-2022 is clear: private chains that work in isolation but settle with nobody (Corda, IBM Fabric, Onyx, Forge - all quietly wound down). Ethera connects institutions from day one: sovereign private chain + global network + Ethereum's $170B stablecoins + $130B DeFi liquidity already live. Traction: 100+ institutional conversations, 4 partners moving to deployment. SSV Labs: 7M+ ETH staked, inventors of DVT.`;

// Campaign-aware vars — overridden at startup from CC board
let SENDER_NAME = "Matthias Ang";
let SENDER_FIRST_NAME = "Matthias";
let SENDER_IDENTITY = "Matthias Ang, CCO at Ethera";
let PRODUCT_NAME = "Ethera";
let ACTIVE_PITCH_BLOCK = ANGLE2_PITCH;
let BESU_PITCH_BLOCK = ANGLE1_PITCH;
let EMAIL_CTA_STYLE = "Short closing question, e.g. 'Worth 20 minutes?'";
let EMAIL_WORD_COUNT = "150-180";

function sanitizeEmDashes(text: string): string {
  return text.replace(/—/g, '-').replace(/–/g, '-');
}

function stripLeadingGreeting(text: string, firstName: string): string {
  const escaped = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`^Hi\\s+${escaped}[,.]?\\s*\\n+`, 'i'), '')
    .replace(new RegExp(`^${escaped}[,.]\\s+`, 'i'), '');
}

function stripSignOff(text: string): string {
  return text.replace(
    /\n+\s*(Best(?:\s+regards)?|Regards|Kind\s+regards|Sincerely|Thanks|Thank\s+you|Warm\s+regards|Cheers|Looking\s+forward)[,.]?\s*\n[\s\S]*$/i,
    ''
  ).trim();
}

// null = disabled (no platform-specific angle); empty array = also disabled; populated = use list
let KNOWN_BESU_LIST: string[] | null = ["jpmorgan", "jp morgan", "quorum", "consensys", "ing bank",
  "societe generale", "societe generale", "santander", "deutsche bank",
  "credit suisse", "bnp paribas", "itau", "itau", "hsbc", "lseg", "euroclear",
  "dtcc", "dbs", "ocbc", "standard chartered", "btg pactual", "fnality", "setl"];

function isKnownBesu(c: string): boolean {
  if (!KNOWN_BESU_LIST || KNOWN_BESU_LIST.length === 0) return false;
  return KNOWN_BESU_LIST.some(b => c.toLowerCase().includes(b));
}
function isTestLead(id: string): boolean { return String(id).toUpperCase().startsWith("TEST-"); }
function resolveToEmail(leadEmail: string): string { return TEST_MODE ? TEST_EMAIL : leadEmail; }

function formatGmailDate(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function extractLlmText(res: unknown): string {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object") return "";
  const r = res as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  if (typeof r.completion === "string") return r.completion;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content) && r.content.length > 0) { const f = r.content[0] as Record<string, unknown>; if (typeof f.text === "string") return f.text; }
  return "";
}

function extractPages(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.pages)) return r.pages as Record<string, unknown>[];
  if (Array.isArray(r.results)) return r.results as Record<string, unknown>[];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  return [];
}

function getBoardRows(board: unknown, dataset: string): Record<string, unknown>[] {
  if (!board || typeof board !== "object") return [];
  const b = board as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  const datasets = data?.datasets as Record<string, unknown> | undefined;
  const ds = datasets?.[dataset] as Record<string, unknown> | undefined;
  return (ds?.rows as Record<string, unknown>[]) ?? [];
}

function getFirstName(name: string): string { return name.split(" ")[0] ?? name; }

function parseSubjectAndBody(text: string, fallbackSubject: string): { subject: string; body: string } {
  const lines = text.split("\n");
  const subjectLine = lines[0]?.trim() ?? "";
  if (subjectLine.toLowerCase().startsWith("subject:")) {
    const subject = subjectLine.slice("subject:".length).trim() || fallbackSubject;
    const body = lines.slice(1).join("\n").replace(/^\s*\n/, "").trim();
    return { subject, body };
  }
  return { subject: fallbackSubject, body: text.trim() };
}

function stripLiPreamble(text: string): string {
  return text.replace(/^(here'?s?\s+(follow-?up|fu)\s*[#\d]*:?\s*|")/i, "").trim();
}


function liButtons(qid: string): unknown {
  return { inline_keyboard: [[
    { text: "Send", callback_data: `send ${qid}` },
    { text: "Skip", callback_data: `skip ${qid}` },
    { text: "Edit", callback_data: `edit ${qid}` },
    { text: "Discard", callback_data: `discard ${qid}` }
  ]]};
}

async function searchGmailViaIntegration(fromEmail: string, sentAt: Date | null): Promise<Record<string, unknown>[]> {
  try {
    const afterDate = sentAt
      ? `${sentAt.getUTCFullYear()}/${String(sentAt.getUTCMonth() + 1).padStart(2, "0")}/${String(sentAt.getUTCDate()).padStart(2, "0")}`
      : "2026/01/01";
    const query = `from:${fromEmail} subject:"re:" after:${afterDate}`;
    const res = await brains.act_on_integration({ source: "gmail", ...(GMAIL_INSTALL_ID ? {install_id: GMAIL_INSTALL_ID} : {}), action_name: "search_emails", input: { query, limit: 20 } });
    if (!res || typeof res !== "object") return [];
    const result = (res as Record<string, unknown>).result as Record<string, unknown> | undefined;
    const messages = (result?.messages ?? (res as Record<string, unknown>).messages) as Record<string, unknown>[] | undefined;
    if (!messages || messages.length === 0) return [];
    return messages.map(m => ({ title: String(m.subject ?? ""), subject: String(m.subject ?? ""), snippet: String(m.snippet ?? ""), date: m.date ?? null, updated_at: m.date ?? null, id: m.id, _source: "gmail_integration" }));
  } catch { return []; }
}

async function searchGmailSent(subject: string, after: Date | null): Promise<boolean> {
  try {
    const afterStr = after
      ? `${after.getUTCFullYear()}/${String(after.getUTCMonth() + 1).padStart(2, "0")}/${String(after.getUTCDate()).padStart(2, "0")}`
      : "2026/01/01";
    const query = `in:sent subject:"${subject.replace(/"/g, "")}" after:${afterStr}`;
    const res = await brains.act_on_integration({ source: "gmail", ...(GMAIL_INSTALL_ID ? {install_id: GMAIL_INSTALL_ID} : {}), action_name: "search_emails", input: { query, limit: 5 } });
    if (!res || typeof res !== "object") return false;
    const result = (res as Record<string, unknown>).result as Record<string, unknown> | undefined;
    const messages = (result?.messages ?? (res as Record<string, unknown>).messages) as Record<string, unknown>[] | undefined;
    return (messages?.length ?? 0) > 0;
  } catch { return false; }
}

async function pushToEtheraBot(chatId: string, message: string, replyMarkup?: unknown): Promise<boolean> {
  try {
    let url = `${TG_BASE}/sendMessage?chat_id=${encodeURIComponent(chatId)}&text=${encodeURIComponent(message)}`;
    if (replyMarkup) url += `&reply_markup=${encodeURIComponent(JSON.stringify(replyMarkup))}`;
    const res = await brains.http_fetch({ url, method: "GET" });
    if (!res.ok) { return false; }
    return true;
  } catch { return false; }
}

async function draftEmail(params: {
  qid: string; name: string; company: string; leadEmail: string;
  subject: string; body: string; fuLabel: string; replySnippet?: string;
  threadId?: string;
}): Promise<{ draftId: string; sent: boolean }> {
  const { qid, leadEmail, subject, body } = params;
  const toEmail = resolveToEmail(leadEmail);
  const cleanBody = stripSignOff(body);
  let draftId = "", kindReturned = "";
  try {
    const emailInput: Record<string, unknown> = { to: [toEmail], subject, body: cleanBody };
    if (params.threadId) emailInput.thread_id = params.threadId;
    const result = await brains.act_on_integration({
      source: "gmail",
      ...(GMAIL_INSTALL_ID ? {install_id: GMAIL_INSTALL_ID} : {}),
      action_name: "send_email",
      notify: ["inbox"],
      input: emailInput
    });
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      kindReturned = String(r.kind ?? "?");
      draftId = String(r.draft_id ?? "");
      console.log(`act_on_integration ${qid}: kind=${kindReturned} draft_id=${draftId || "MISSING"} to=${toEmail}`);
    }
  } catch (e) { console.log(`act_on_integration err (${qid}): ${String(e).slice(0, 120)}`); }
  const sent = kindReturned === "auto_executed" || kindReturned === "confirmed";
  return { draftId, sent };
}

async function discardOqRow(rowId: string, draftId: string | undefined, patch: Record<string, unknown>): Promise<void> {
  await brains.update_board_row({ board_id: BOARD_ID, row_id: rowId, dataset: "outreach_queue", patch });
  if (draftId) { try { await brains.discard_action({ draft_id: draftId }); } catch {} }
}

async function discardPendingForLead(leadId: string, channel: "email" | "linkedin", activeQueueRows: Record<string, unknown>[], discardedRowIds: Set<string>): Promise<string[]> {
  const COLD_DISCARD_STATUSES = new Set(["pending_approval", "sent", "linkedin_sent", "dm_pending"]);
  const existing = activeQueueRows.filter(r => String(r.lead_id) === leadId && r.channel === channel && COLD_DISCARD_STATUSES.has(String(r.status)) && String(r.follow_up_number ?? "0") !== "-1" && !discardedRowIds.has(String(r.row_id)));
  const discardedIds: string[] = [];
  for (const row of existing) {
    discardedRowIds.add(String(row.row_id));
    discardedIds.push(String(row.id));
    const draftId = channel === "email" ? (String(row.draft_id || "") || undefined) : undefined;
    await discardOqRow(String(row.row_id), draftId, { status: "discarded", approval_outcome: "superseded" });
  }
  if (discardedIds.length > 0) console.log(`  Discarded old ${channel} rows for ${leadId}: ${discardedIds.join(", ")}`);
  return discardedIds;
}

async function cleanupDiscardedDrafts(queueRows: Record<string, unknown>[], now: Date): Promise<void> {
  const toClean = queueRows.filter(r => {
    if (!r.draft_id || String(r.draft_id).length < 10) return false;
    if (String(r.status) === "pending_approval") return false;
    const createdAt = r.created_at ? new Date(String(r.created_at)) : null;
    const ageMs = createdAt ? now.getTime() - createdAt.getTime() : Infinity;
    return ageMs < CLEANUP_WINDOW_MS;
  });
  if (toClean.length === 0) { console.log("cleanupDiscardedDrafts: nothing to clean"); return; }
  console.log(`Cleaning up ${toClean.length} old draft(s) from brains inbox...`);
  for (const row of toClean) { try { await brains.discard_action({ draft_id: String(row.draft_id) }); console.log(`  Discarded draft ${String(row.draft_id).slice(0, 8)}... (${row.id})`); } catch {} }
}

function applyDateFilter(pages: Record<string, unknown>[], sentAt: Date | null): Record<string, unknown>[] {
  if (!sentAt) return pages;
  return pages.filter(p => { const d = p.updated_at || p.date || p.created_at; if (!d) return false; const dt = new Date(String(d)); return !isNaN(dt.getTime()) && dt > sentAt!; });
}

type Counter = { value: number };
function nextQid(counter: Counter): string { counter.value++; return `OQ-${String(counter.value).padStart(4, "0")}`; }

async function checkPendingEmailDrafts(allLeads: Record<string, unknown>[], queueRows: Record<string, unknown>[], now: Date): Promise<void> {
  const pendingOqRows = queueRows.filter(r =>
    !r._deleted_at && String(r.status) === "pending_approval" && String(r.channel) === "email" &&
    r.draft_id && String(r.draft_id).length > 10 &&
    (!TEST_ONLY_MODE || isTestLead(String(r.lead_id ?? "")))
  );
  if (pendingOqRows.length === 0) return;
  console.log(`Checking ${pendingOqRows.length} pending email draft(s)...`);
  for (const row of pendingOqRows) {
    const rowCreatedAt = row.created_at ? new Date(String(row.created_at)) : null;
    const ageMs = rowCreatedAt ? now.getTime() - rowCreatedAt.getTime() : Infinity;
    const draftId = String(row.draft_id ?? "").trim() || undefined;
    const fuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
    const isColdEmail = fuNum === 0;
    const leadId = String(row.lead_id ?? "");
    const subject = String(row.subject ?? "").trim();
    const lead = allLeads.find(l => String(l.id ?? "") === leadId);
    if (ageMs < DRAFT_EXPIRY_MS) { console.log(`  ${leadId} (${row.id}): draft ${Math.round(ageMs / 1000)}s old, still pending`); continue; }
    if (!isColdEmail) {
      console.log(`  ${leadId} (${row.id}): FU${fuNum} expired -> discarding (Telegram-only confirmation)`);
      if (draftId) { try { await brains.discard_action({ draft_id: draftId }); } catch {} }
      await brains.update_board_row({ board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue", patch: { status: "discarded", approval_outcome: "expired" } });
      row.status = "discarded";
      continue;
    }
    const foundInSent = subject ? await searchGmailSent(subject, rowCreatedAt) : false;
    if (foundInSent) {
      console.log(`  ${leadId} (${row.id}): cold email found in Gmail sent -> Sent`);
      await brains.update_board_row({ board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue", patch: { status: "sent", approval_outcome: "confirmed" } });
      row.status = "sent";
      if (lead?.row_id) { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads", patch: { outreach_status: "Sent", follow_up_due_at: new Date(now.getTime() + FOLLOW_UP_DELAY_MS).toISOString() } }); lead.outreach_status = "Sent"; lead.follow_up_due_at = new Date(now.getTime() + FOLLOW_UP_DELAY_MS).toISOString(); }
    } else {
      console.log(`  ${leadId} (${row.id}): cold email not in Gmail sent -> expired -> discard + New`);
      if (draftId) { try { await brains.discard_action({ draft_id: draftId }); } catch {} }
      await brains.update_board_row({ board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue", patch: { status: "discarded", approval_outcome: "discarded_by_user" } });
      row.status = "discarded";
      if (lead?.row_id) { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads", patch: { outreach_status: "New", cold_email_subject: "" } }); lead.outreach_status = "New"; lead.cold_email_subject = ""; }
    }
  }
}

async function checkEmailReplies(allLeads: Record<string, unknown>[], queueRows: Record<string, unknown>[], now: Date, counter: Counter): Promise<void> {
  if (TEST_MODE) { console.log("checkEmailReplies: skipped in TEST_MODE"); return; }
  const sentLeads = allLeads.filter(l => !l._deleted_at && l.outreach_status === "Sent" && l.email && String(l.email).includes("@") && (!TEST_ONLY_MODE || isTestLead(String(l.id ?? ""))));
  if (sentLeads.length === 0) return;
  for (const lead of sentLeads) {
    const email = String(lead.email ?? "").trim(); const leadId = String(lead.id ?? ""); const name = String(lead.name ?? ""); const company = String(lead.company ?? ""); const position = String(lead.position ?? "");
    for (const row of queueRows.filter(r => !r._deleted_at && String(r.lead_id) === leadId && r.channel === "email" && String(r.follow_up_number ?? "0") === "-1" && (r.status === "pending_approval" || r.status === "sent"))) {
      await discardOqRow(String(row.row_id), String(row.draft_id || "") || undefined, { status: "discarded", approval_outcome: "stale_reset" });
    }
    const sentSubjectKeys: string[] = [];
    const coldSubject = String(lead.cold_email_subject ?? "").trim();
    if (coldSubject) { const key = coldSubject.toLowerCase().replace(/^(re:|fw:|fwd:)\s*/i, "").trim().slice(0, 20); if (key) sentSubjectKeys.push(key); }
    let sentAt: Date | null = null;
    const coldRow = queueRows.find(r => String(r.lead_id) === leadId && r.channel === "email" && String(r.follow_up_number ?? "0") === "0" && r.status === "sent");
    if (coldRow?.created_at) sentAt = new Date(String(coldRow.created_at));
    if (!sentAt && lead.last_contacted_at) sentAt = new Date(String(lead.last_contacted_at));
    if (sentSubjectKeys.length === 0 && !sentAt) continue;
    let pages: Record<string, unknown>[] = [];
    for (const key of sentSubjectKeys) { if (pages.length > 0) break; try { const raw = await brains.search({ query: `from:${email} re: ${key}`, type: "email", limit: 10 }); pages.push(...extractPages(raw).filter(p => isReplyEmail(p, sentSubjectKeys))); } catch {} }
    if (pages.length === 0 && sentAt) { try { const raw = await brains.search({ query: `from:${email}`, type: "email", limit: 30 }); pages = extractPages(raw).filter(p => isReplyEmail(p, sentSubjectKeys)); } catch {} }
    if (pages.length === 0 && sentSubjectKeys.length > 0) { const gmailPages = await searchGmailViaIntegration(email, sentAt); pages.push(...gmailPages.filter(p => isReplyEmail(p, sentSubjectKeys))); }
    const replies = applyDateFilter(pages, sentAt);
    if (replies.length === 0) continue;
    const replyPage = replies.sort((a, b) => new Date(String(b.updated_at ?? b.date ?? b.created_at ?? 0)).getTime() - new Date(String(a.updated_at ?? a.date ?? a.created_at ?? 0)).getTime())[0];
    const replySubject = String(replyPage?.title ?? replyPage?.subject ?? coldSubject);
    const replySnippet = String(replyPage?.snippet ?? replyPage?.body ?? replyPage?.content ?? "").slice(0, 300);
    if (lead.row_id) { try { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads", patch: { outreach_status: "Responded", response_channel: "email" } }); } catch {} }
    for (const row of queueRows.filter(r => String(r.lead_id) === leadId && r.channel === "email" && r.status === "pending_approval" && String(r.follow_up_number ?? "0") !== "-1")) { try { await discardOqRow(String(row.row_id), String(row.draft_id || "") || undefined, { status: "discarded", approval_outcome: "prospect_replied" }); } catch {} }
    const replyPrompt = `You are ${SENDER_IDENTITY}. ${name} (${position} at ${company}) replied to your outreach. Subject: "${replySubject}". ${replySnippet ? `They wrote: "${replySnippet}"` : ""} Write short warm reply, propose 20-min call. No em dashes. No sign-off, no closing, no 'Best', no 'Regards', no name at the end. Max 120 words. First line: Subject: [subject]. Blank line. Start with: Hi ${getFirstName(name)},`;
    let replyEmailSubject = replySubject, replyEmailBody = "";
    try {
      const llmRes = await brains.llm({ prompt: replyPrompt, max_tokens: 300 });
      const parsed = parseSubjectAndBody(sanitizeEmDashes(extractLlmText(llmRes).trim()), replyEmailSubject);
      replyEmailSubject = parsed.subject;
      replyEmailBody = `${sanitizeEmDashes(stripSignOff(parsed.body))}\n\n${SCHEDULING_LINE}\n\nBest,\n${SENDER_FIRST_NAME}`;
    } catch { replyEmailBody = `(LLM unavailable for ${name})\n\n${SCHEDULING_LINE}\n\nBest,\n${SENDER_FIRST_NAME}`; }
    const replyQid = nextQid(counter);
    const { draftId: replyDraftId } = await draftEmail({ qid: replyQid, name, company, leadEmail: email, subject: replyEmailSubject, body: replyEmailBody, fuLabel: "Email (Reply)", replySnippet });
    try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: replyQid, lead_id: leadId, lead_name: name, lead_email: resolveToEmail(email), company, channel: "email", follow_up_number: "-1", status: "pending_approval", body: replyEmailBody, subject: replyEmailSubject, draft_id: replyDraftId, approval_outcome: "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
  }
}

function isReplyEmail(page: Record<string, unknown>, subjectKeys: string[]): boolean {
  const pageSubject = String(page.title ?? page.subject ?? "").toLowerCase().trim();
  if (!pageSubject.startsWith("re:") && !pageSubject.startsWith("fw:") && !pageSubject.startsWith("fwd:")) return false;
  if (subjectKeys.length === 0) return true;
  return subjectKeys.some(key => key.length === 0 || pageSubject.includes(key));
}

async function checkLinkedInReplies(allLeads: Record<string, unknown>[], queueRows: Record<string, unknown>[], now: Date, etherabotChatId: string, counter: Counter): Promise<void> {
  const repliedLeads = allLeads.filter(l => !l._deleted_at && (l as Record<string, unknown>).linkedin_status === "replied" && (!TEST_ONLY_MODE || isTestLead(String(l.id ?? ""))));
  if (repliedLeads.length === 0) return;
  for (const lead of repliedLeads) {
    const leadId = String(lead.id ?? ""); const name = String(lead.name ?? ""); const company = String(lead.company ?? ""); const position = String(lead.position ?? "");
    if (lead.outreach_status === "Responded") continue;
    const sentLiRow = queueRows.find(r => !r._deleted_at && String(r.lead_id) === leadId && r.channel === "linkedin" && r.status === "linkedin_sent");
    if (!sentLiRow) { console.log(`  Skipping ${name}: linkedin_status=replied but no sent LI OQ row found`); continue; }
    for (const row of queueRows.filter(r => !r._deleted_at && String(r.lead_id) === leadId && r.channel === "linkedin" && String(r.follow_up_number ?? "0") === "-1" && (r.status === "pending_approval" || r.status === "sent"))) { await discardOqRow(String(row.row_id), undefined, { status: "discarded", approval_outcome: "stale_reset" }); }
    const liReplyRow = queueRows.find(r => String(r.lead_id) === leadId && r.channel === "linkedin" && !r._deleted_at && r.status === "replied");
    const replySnippet = liReplyRow ? String(liReplyRow.body ?? "").slice(0, 300) : "";
    const origLiRow = queueRows.filter(r => String(r.lead_id) === leadId && r.channel === "linkedin" && !r._deleted_at).sort((a, b) => parseInt(String(a.follow_up_number ?? "0"), 10) - parseInt(String(b.follow_up_number ?? "0"), 10))[0];
    const origLiNote = origLiRow ? String(origLiRow.body ?? "") : "";
    const replyContext = replySnippet ? `They wrote: "${replySnippet}"` : "Assume positive -- propose 20-min call.";
    const replyPrompt = `You are ${SENDER_IDENTITY}. ${name} (${position} at ${company}) replied on LinkedIn. ${origLiNote ? `Your original: "${origLiNote}"` : ""} ${replyContext} Short warm reply. No em dashes. Max 300 chars. Start: Hi ${getFirstName(name)},`;
    let liReplyBody = "";
    try { const llmRes = await brains.llm({ prompt: replyPrompt, max_tokens: 150 }); liReplyBody = sanitizeEmDashes(stripLiPreamble(extractLlmText(llmRes).trim())).slice(0, 280) + `\n\nBest,\n${SENDER_FIRST_NAME}`; } catch { liReplyBody = `Hi ${getFirstName(name)}, thanks for getting back! Would love to find 20 min to connect.\n\nBest,\n${SENDER_FIRST_NAME}`; }
    const replyQid = nextQid(counter);
    try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: replyQid, lead_id: leadId, lead_name: name, company, channel: "linkedin", follow_up_number: "-1", status: "pending_approval", body: liReplyBody, subject: "LinkedIn reply", draft_id: "", approval_outcome: "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
    if (lead.row_id) { try { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads", patch: { outreach_status: "Responded", response_channel: "linkedin" } }); } catch {} }
    const notifMsg = `LI Reply from ${name} @ ${company}${replySnippet ? `\n\nThey wrote:\n"${replySnippet.slice(0, 200)}"` : ""}\n\nDraft LI reply (${replyQid}):\n${liReplyBody}`;
    if (etherabotChatId) await pushToEtheraBot(etherabotChatId, notifMsg, liButtons(replyQid)); else await brains.telegram_push({ text: notifMsg });
  }
}

async function main() {
  console.log(`Draft Generator v182 starting... TEST_MODE=${TEST_MODE} TEST_ONLY_MODE=${TEST_ONLY_MODE}`);
  const now = new Date();

  // Campaign config — read from Control Centre board FIRST so BOARD_ID is resolved before any board reads
  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, { dataset: "meta", limit: 10 });
    const ccRows = ((ccBoard?.datasets?.meta?.rows ?? ccBoard?.data?.datasets?.meta?.rows ?? []) as Record<string, unknown>[]);
    // cc_setup: read unconditionally — BOARD_ID update gated for new users only; test_email applies to all
    const setupRow = ccRows.find((r: Record<string, unknown>) => r.key === "cc_setup");
    if (setupRow) {
      try {
        const setup = JSON.parse(String(setupRow.value ?? "{}")) as Record<string, unknown>;
        if (!_ccSecret.startsWith("{{") && setup.prospector_id) BOARD_ID = String(setup.prospector_id);
        if (setup.test_email) TEST_EMAIL = String(setup.test_email);
        if (setup.sender_email) SENDER_EMAIL = String(setup.sender_email);
        if (typeof setup.test_mode === "boolean") { TEST_MODE = setup.test_mode; TEST_ONLY_MODE = setup.test_mode; }
        console.log(`cc_setup loaded: TEST_MODE=${TEST_MODE} TEST_EMAIL=${TEST_EMAIL} SENDER_EMAIL=${SENDER_EMAIL}`);
      } catch {}
    }
    const configRow = ccRows.find((r: Record<string, unknown>) => r.key === "agent_config");
    if (configRow) {
      const config = JSON.parse(String(configRow.value ?? "{}")) as Record<string, unknown>;
      // known_platform_users: top-level config field — overrides KNOWN_BESU_LIST for this org
      // absent = disabled ([]) for recipe-general; explicit list = use it; [] = also disabled
      KNOWN_BESU_LIST = Array.isArray(config.known_platform_users) ? (config.known_platform_users as string[]) : [];
      const campaigns = (config.campaigns as {id:string;sender_name?:string;sender_title?:string;product_description?:string;value_prop?:string;problem_opener?:string;proof_points?:string[];cta_style?:string;email_tone?:string;scheduling_url?:string;prospector_board_id?:string}[] ?? []);
      const activeCampaignId = String(config.active_campaign_id ?? "");
      const campaign = campaigns.find(c => c.id === activeCampaignId) ?? null;
      if (campaign) {
        if ((campaign.prospector_board_id ?? "").length > 0) BOARD_ID = String(campaign.prospector_board_id);
        SENDER_NAME = String(campaign.sender_name || SENDER_NAME);
        SENDER_FIRST_NAME = getFirstName(SENDER_NAME);
        const rawTitle = String(campaign.sender_title || "CCO, Ethera");
        const titleParts = rawTitle.split(",").map((s: string) => s.trim());
        const role = titleParts[0] ?? "CCO";
        const org = titleParts.slice(1).join(" ").trim() || "Ethera";
        SENDER_IDENTITY = `${SENDER_NAME}, ${role} at ${org}`;
        PRODUCT_NAME = org;
        if ((campaign.product_description || "").length > 0) {
          const parts: string[] = [campaign.product_description as string];
          if ((campaign.problem_opener || "").length > 0) parts.push(campaign.problem_opener as string);
          if (Array.isArray(campaign.proof_points) && (campaign.proof_points as string[]).length > 0)
            parts.push("Proof: " + (campaign.proof_points as string[]).slice(0, 3).join(". "));
          if ((campaign.value_prop || "").length > 0) parts.push(campaign.value_prop as string);
          ACTIVE_PITCH_BLOCK = parts.join("\n\n");
          BESU_PITCH_BLOCK = campaign.id === "ethera-default" ? ANGLE1_PITCH : ACTIVE_PITCH_BLOCK;
        }
        if ((campaign.cta_style || "").length > 0) EMAIL_CTA_STYLE = String(campaign.cta_style);
        if ((campaign.email_tone || "").length > 0) {
          const wc = String(campaign.email_tone).match(/(\d+)-(\d+)\s*words?/i);
          if (wc) EMAIL_WORD_COUNT = `${wc[1]}-${wc[2]}`;
        }
        if ((campaign.scheduling_url || "").length > 0) SCHEDULING_URL = String(campaign.scheduling_url);
        console.log(`Agent 2A campaign: ${campaign.id} | ${SENDER_IDENTITY} | ${PRODUCT_NAME}`);
      } else {
        SENDER_FIRST_NAME = getFirstName(SENDER_NAME);
        console.log("Agent 2A: no active campaign found — using hardcoded Ethera defaults");
      }
    }
  } catch (e) {
    SENDER_FIRST_NAME = getFirstName(SENDER_NAME);
    console.log(`Agent 2A campaign config error: ${String(e).slice(0, 80)} — using defaults`);
  }
  // Recompute SCHEDULING_LINE after SCHEDULING_URL may have been updated from campaign config
  SCHEDULING_LINE = `Book a 20-minute call here: ${SCHEDULING_URL}`;

  const metaBoard = await brains.boards.get(BOARD_ID, { dataset: "meta", limit: 100 });
  const metaRows = getBoardRows(metaBoard, "meta");
  const counterRow = metaRows.find(r => r.key === "outreach_queue_counter");
  const learningsRow = metaRows.find(r => r.key === "outreach_learnings");
  const chatIdRow = metaRows.find(r => r.key === "telegram_chat_id");
  let queueCounter = parseInt(String(counterRow?.value ?? "0"), 10);
  const learnings = String(learningsRow?.value ?? "{}");
  const hasLearnings = learnings !== "{}" && learnings.length > 2;
  const etherabotChatId = String(chatIdRow?.value ?? "").trim();
  const leadsBoard = await brains.boards.get(BOARD_ID, { dataset: "leads", limit: 1000 });
  const allLeads = getBoardRows(leadsBoard, "leads").filter(l => !l._deleted_at);
  const queueBoard = await brains.boards.get(BOARD_ID, { dataset: "outreach_queue", limit: 2000 });
  const queueRows = getBoardRows(queueBoard, "outreach_queue").filter(r => !r._deleted_at);
  console.log(`Leads: ${allLeads.length} | Queue: ${queueRows.length} | chatId: ${etherabotChatId}`);

  const maxExistingNum = Math.max(queueCounter, ...queueRows.map(r => parseInt(String(r.id ?? "").replace("OQ-", ""), 10)).filter(n => !isNaN(n)));
  const counter: Counter = { value: maxExistingNum };
  await cleanupDiscardedDrafts(queueRows, now);
  await checkPendingEmailDrafts(allLeads, queueRows, now);
  await checkEmailReplies(allLeads, queueRows, now, counter);
  await checkLinkedInReplies(allLeads, queueRows, now, etherabotChatId, counter);
  const discardedRowIds = new Set<string>();
  const staleEmailPending = queueRows.filter(r => r.status === "pending_approval" && r.channel === "email" && parseInt(String(r.follow_up_number ?? "0"), 10) === 0 && (now.getTime() - new Date(String(r.created_at ?? 0)).getTime()) > (TEST_MODE ? TEST_STALE_EMAIL_MS : PROD_STALE_EMAIL_MS));
  if (staleEmailPending.length > 0) { for (const row of staleEmailPending) { discardedRowIds.add(String(row.row_id)); await discardOqRow(String(row.row_id), String(row.draft_id || "") || undefined, { status: "discarded", approval_outcome: "stale" }); } }
  const staleLiPending = queueRows.filter(r => r.status === "pending_approval" && r.channel === "linkedin" && (now.getTime() - new Date(String(r.created_at ?? 0)).getTime()) > (TEST_MODE ? TEST_STALE_LI_MS : PROD_STALE_LI_MS));
  if (staleLiPending.length > 0) { for (const row of staleLiPending) { discardedRowIds.add(String(row.row_id)); await discardOqRow(String(row.row_id), undefined, { status: "discarded", approval_outcome: "stale" }); } }
  let activeQueueRows = queueRows.filter(r => !discardedRowIds.has(String(r.row_id)));
  const newLeadIds = new Set(allLeads.filter(l => !l._deleted_at && l.outreach_status === "New" && (!TEST_ONLY_MODE || isTestLead(String(l.id ?? "")))).map(l => String(l.id ?? "")));
  if (newLeadIds.size > 0) { for (const leadId of newLeadIds) { await discardPendingForLead(leadId, "email", activeQueueRows, discardedRowIds); await discardPendingForLead(leadId, "linkedin", activeQueueRows, discardedRowIds); } activeQueueRows = queueRows.filter(r => !discardedRowIds.has(String(r.row_id))); }
  const COLD_BLOCK_STATUSES_EMAIL = new Set(["pending_approval"]);
  const sentColdLeadIds = new Set(activeQueueRows.filter(r => r.channel === "email" && String(r.follow_up_number ?? "0") === "0" && COLD_BLOCK_STATUSES_EMAIL.has(String(r.status))).map(r => String(r.lead_id)));
  const coldBatch = allLeads.filter(l => l.email && String(l.email).includes("@") && !l._deleted_at && l.outreach_status === "New" && !sentColdLeadIds.has(String(l.id ?? "")) && (!TEST_ONLY_MODE || isTestLead(String(l.id ?? "")))).slice(0, BATCH_SIZE);
  const fuBatch = allLeads.filter(l => {
    if (!l.email || !String(l.email).includes("@") || l._deleted_at || l.outreach_status !== "Sent") return false;
    if (parseInt(String(l.follow_up_count ?? "0"), 10) >= 3) return false;
    if (TEST_ONLY_MODE && !isTestLead(String(l.id ?? ""))) return false;
    const hasPendingFu = activeQueueRows.some(r => String(r.lead_id) === String(l.id ?? "") && r.channel === "email" && parseInt(String(r.follow_up_number ?? "0"), 10) > 0 && r.status === "pending_approval");
    if (hasPendingFu) return false;
    if (!l.follow_up_due_at) {
      const sentColdRow = activeQueueRows.find(r => String(r.lead_id) === String(l.id ?? "") && r.channel === "email" && r.status === "sent" && parseInt(String(r.follow_up_number ?? "0"), 10) === 0);
      if (!sentColdRow?.created_at) return true;
      return now.getTime() >= new Date(String(sentColdRow.created_at)).getTime() + FOLLOW_UP_DELAY_MS;
    }
    return new Date(String(l.follow_up_due_at)) <= now;
  });
  console.log(`Cold batch: ${coldBatch.length} | FU batch: ${fuBatch.length}`);
  if (coldBatch.length === 0 && fuBatch.length === 0) { console.log("No cold/FU batch -- checking LI catch-up..."); }
  const emailDraftsCreated: string[] = [];
  const liDraftsCreated: string[] = [];

  for (const lead of coldBatch) {
    const leadId = String(lead.id ?? "");
    await discardPendingForLead(leadId, "email", activeQueueRows, discardedRowIds);
    await discardPendingForLead(leadId, "linkedin", activeQueueRows, discardedRowIds);
    const emailQid = nextQid(counter); const liQid = nextQid(counter);
    const name = String(lead.name ?? ""), company = String(lead.company ?? ""), position = String(lead.position ?? "");
    const leadEmail = String(lead.email ?? ""); const linkedIn = String(lead.linkedIn ?? "");
    const signal = String((lead as Record<string, unknown>).signal ?? "");
    const besuDetected = isKnownBesu(company); const freshStart = String(lead.besu_detected ?? "").toLowerCase() === "no";
    const daResearch = String((lead as Record<string, unknown>).da_research ?? "").trim().slice(0, 600);
    const etheraCases = String((lead as Record<string, unknown>).ethera_use_cases ?? "").trim().slice(0, 400);
    let newsContext = "";
    try { const nr = await brains.http_fetch({ url: `https://newsapi.org/v2/everything?q=${encodeURIComponent(company)}&sortBy=publishedAt&pageSize=3&apiKey={{newsapi_key}}`, method: "GET" }); const nj = nr.body as Record<string, unknown>; const arts = (nj?.articles as Record<string, unknown>[])?.slice(0, 3) ?? []; if (arts.length > 0) newsContext = arts.map((a: Record<string, unknown>) => `- ${a.title} (${a.source ? (a.source as Record<string, unknown>).name : ""})`).join("\n"); } catch {}
    const besuSignal = besuDetected ? `${company} uses Hyperledger Besu.` : freshStart ? `${company} is exploring blockchain without a platform yet.` : "";
    const pitchBlock = besuDetected ? BESU_PITCH_BLOCK : ACTIVE_PITCH_BLOCK;
    const hasLN = hasLearnings ? `\n\nPrior learnings:\n${learnings}` : "";
    const researchCtx = daResearch ? `\n\nCompany intelligence (use to personalise the hook):\n${daResearch}` : "";
    const useCaseCtx = etheraCases ? `\n\n${PRODUCT_NAME} use cases for ${company} (pick the strongest one as the hook):\n${etheraCases}` : "";
    const liUseCaseHint = etheraCases ? ` Best ${PRODUCT_NAME} use case: ${etheraCases.split("\n")[0].slice(0, 150)}.` : "";
    const emailPrompt = `You are ${SENDER_IDENTITY}.\nCold email to ${name} (${position} at ${company}).\n${signal ? `Signal: ${signal}\n` : ""}${besuSignal ? `${besuSignal}\n` : ""}${newsContext ? `Recent news:\n${newsContext}\n` : ""}${researchCtx}${useCaseCtx}\n\nProduct pitch to use:\n${pitchBlock}${hasLN}\n\nNo em dashes. ${EMAIL_WORD_COUNT} words. First line: Subject: [subject]. Blank line. Then: Hi ${getFirstName(name)}, blank line, body. ${EMAIL_CTA_STYLE}. No scheduling URL, no sign-off, no closing line, no name at end.`;
    const liPrompt = `You are ${SENDER_IDENTITY}.\nLinkedIn connection note to ${name} at ${company}.\n${besuSignal ? `${besuSignal}\n` : ""}${liUseCaseHint}\nSoft intro, reason for connecting, no hard pitch. No em dashes. Max 290 chars. Start: Hi ${getFirstName(name)},`;
    let emailSubject = `${PRODUCT_NAME} x ${company}`, emailBody = "", liNote = "", angle = "general", angleReason = "";
    try {
      const r = await brains.llm({ prompt: emailPrompt, max_tokens: 500 });
      const p = parseSubjectAndBody(sanitizeEmDashes(extractLlmText(r).trim()), emailSubject);
      emailSubject = p.subject;
      const llmBody = sanitizeEmDashes(stripSignOff(stripLeadingGreeting(p.body, getFirstName(name))));
      emailBody = `Hi ${getFirstName(name)},\n\n${llmBody}\n\n${SCHEDULING_LINE}\n\nBest,`;
      angle = besuDetected ? "besu" : freshStart ? "fresh_start" : signal ? "signal" : "general";
      angleReason = besuDetected ? "Known Besu user" : freshStart ? "No platform yet" : signal.slice(0, 60);
    } catch { emailBody = `(LLM unavailable)\n\n${SCHEDULING_LINE}\n\nBest,`; }
    try { const r = await brains.llm({ prompt: liPrompt, max_tokens: 120 }); liNote = sanitizeEmDashes(stripLiPreamble(extractLlmText(r).trim())).slice(0, 290); } catch { liNote = `Hi ${getFirstName(name)}, I'd love to connect about ${PRODUCT_NAME}.`; }
    const { draftId, sent: emailSent } = await draftEmail({ qid: emailQid, name, company, leadEmail, subject: emailSubject, body: emailBody, fuLabel: "Email (Cold)" });
    if (etherabotChatId) await pushToEtheraBot(etherabotChatId, `[LI] ${liQid} | ${name} @ ${company}\n\n${liNote}`, liButtons(liQid));
    else await brains.telegram_push({ text: `[LI] ${liQid} | ${name} @ ${company}\n${angle}\n\n${liNote}` });
    const emailOqStatus = emailSent ? "sent" : "pending_approval"; const resolvedEmail = resolveToEmail(leadEmail);
    try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: emailQid, lead_id: leadId, lead_name: name, lead_email: resolvedEmail, company, channel: "email", follow_up_number: "0", angle, angle_reason: angleReason, subject: emailSubject, body: emailBody, original_body: emailBody, status: emailOqStatus, draft_id: draftId, approval_outcome: emailSent ? "auto_sent" : "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
    try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: liQid, lead_id: leadId, lead_name: name, lead_linkedin_id: linkedIn, company, channel: "linkedin", follow_up_number: "0", angle, angle_reason: angleReason, subject: "Connection request", body: liNote, original_body: liNote, status: "pending_approval", draft_id: "", approval_outcome: "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
    if (lead.row_id) {
      const leadPatch: Record<string, unknown> = { cold_email_subject: emailSubject, outreach_status: emailSent ? "Sent" : "Queued" };
      if (emailSent) leadPatch.follow_up_due_at = new Date(now.getTime() + FOLLOW_UP_DELAY_MS).toISOString();
      try { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads", patch: leadPatch }); } catch {}
    }
    emailDraftsCreated.push(`${emailQid}: ${emailSubject} -> ${resolvedEmail}`); liDraftsCreated.push(`${liQid}: ${liNote.slice(0, 80)}`);
  }

  for (const lead of fuBatch) {
    const leadId = String(lead.id ?? ""); const fuCount = parseInt(String(lead.follow_up_count ?? "0"), 10), fuNum = fuCount + 1;
    const emailFuQid = nextQid(counter);
    const name = String(lead.name ?? ""), company = String(lead.company ?? ""), position = String(lead.position ?? "");
    const leadEmail = String(lead.email ?? ""); const linkedInId = String((lead as Record<string, unknown>).linkedin_profile_id ?? (lead as Record<string, unknown>).linkedIn ?? "");
    const coldEmailSubject = String(lead.cold_email_subject ?? "").trim();
    const fuSubject = coldEmailSubject ? `Re: ${coldEmailSubject}` : `Following up -- ${PRODUCT_NAME} x ${company}`;
    const lastSentEmailRow = activeQueueRows.filter(r => String(r.lead_id) === leadId && r.channel === "email" && r.status === "sent").sort((a, b) => new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime())[0];
    const lastBody = String(lastSentEmailRow?.body ?? "");
    const gmailThreadId = String(lastSentEmailRow?.gmail_thread_id ?? "").trim() || undefined;
    const fuDaResearch = String((lead as Record<string, unknown>).da_research ?? "").trim().slice(0, 400);
    const fuEtheraCases = String((lead as Record<string, unknown>).ethera_use_cases ?? "").trim().slice(0, 400);
    const fuWordCount = fuNum === 1 ? "80" : fuNum === 2 ? "120" : "60";
    const fuResearchCtx = fuNum === 2 && fuDaResearch ? `\n\nRecent company intelligence for the new angle:\n${fuDaResearch}` : "";
    const fuCasesCtx = fuEtheraCases ? `\n\n${PRODUCT_NAME} use cases for ${company}:\n${fuEtheraCases}` : "";
    const fuStyle = fuNum === 1
      ? "FU1: brief nudge, reference first email, add one stat, end with 'worth a call?'. 80 words max. No scheduling URL."
      : fuNum === 2
      ? "FU2: new angle - use the company intelligence below to open with a fresh hook, then connect to a different pitch angle. 120 words max. No scheduling URL."
      : "FU3: polite breakup, acknowledge they're busy, leave door open, no pressure. 60 words max. No scheduling URL.";
    const fuEmailPrompt = `You are ${SENDER_IDENTITY}.\nFU #${fuNum} to ${name} (${position} at ${company}) who hasn't replied.\n${lastBody ? `Previous email:\n${String(lastBody).slice(0, 300)}\n` : ""}${fuResearchCtx}${fuCasesCtx}\n${fuStyle}\nNo em dashes. Max ${fuWordCount} words. First line: Subject: ${fuSubject}. Blank line. Start: Hi ${getFirstName(name)}, blank line, body. No sign-off, no name at end.`;
    const sentDate = lastSentEmailRow?.created_at ? new Date(String(lastSentEmailRow.created_at)) : now;
    const quotedPrevBody = lastBody ? lastBody.split('\n').map((line: string) => `> ${line}`).join('\n') : '> [previous message]';
    let fuEmailBody = "";
    try {
      const r = await brains.llm({ prompt: fuEmailPrompt, max_tokens: 350 });
      const p = parseSubjectAndBody(sanitizeEmDashes(extractLlmText(r).trim()), fuSubject);
      const llmFuBody = sanitizeEmDashes(stripSignOff(stripLeadingGreeting(p.body, getFirstName(name))));
      fuEmailBody = `Hi ${getFirstName(name)},\n\n${llmFuBody}\n\n${SCHEDULING_LINE}\n\nBest,\n${SENDER_FIRST_NAME}`;
    } catch { fuEmailBody = `Hi ${getFirstName(name)},\n\n(LLM unavailable)\n\n${SCHEDULING_LINE}\n\nBest,\n${SENDER_FIRST_NAME}`; }
    fuEmailBody += `\n\nOn ${formatGmailDate(sentDate)}, ${SENDER_NAME} <${SENDER_EMAIL}> wrote:\n\n${quotedPrevBody}`;
    const resolvedFuEmail = resolveToEmail(leadEmail);
    try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: emailFuQid, lead_id: leadId, lead_name: name, lead_email: resolvedFuEmail, company, channel: "email", follow_up_number: String(fuNum), subject: fuSubject, body: fuEmailBody, original_body: fuEmailBody, status: "pending_approval", draft_id: "", gmail_thread_id: gmailThreadId || "", approval_outcome: "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
    const sentLiRow = activeQueueRows.find(r => String(r.lead_id) === leadId && r.channel === "linkedin" && !r._deleted_at && (r.status === "sent" || r.status === "linkedin_sent"));
    if (sentLiRow) {
      const liFuQid = nextQid(counter); const origLiNote = String(sentLiRow.body ?? "");
      const fuLiStyle = fuNum === 1 ? "FU1: new angle or question." : fuNum === 2 ? "FU2: concrete example or social proof." : "FU3: polite breakup, leave door open.";
      const fuLiCasesCtx = fuEtheraCases ? ` ${PRODUCT_NAME} use case for ${company}: ${fuEtheraCases.split("\n")[0].slice(0, 150)}.` : "";
      const fuLiPrompt = `You are ${SENDER_IDENTITY}.\nLI DM follow-up #${fuNum} to ${name} at ${company}. You are already connected on LinkedIn and already sent an initial DM. Do NOT say "thanks for connecting" -- the connection already happened.\n${origLiNote ? `Your original DM: "${origLiNote}"\n` : ""}${fuLiCasesCtx}\n${fuLiStyle}\nNo em dashes. Short paragraphs, blank line between each. Max 350 chars. Do not include any sign-off or closing line. Start: Hi ${getFirstName(name)},`;
      let fuLiNote = "";
      try { const r = await brains.llm({ prompt: fuLiPrompt, max_tokens: 150 }); fuLiNote = sanitizeEmDashes(stripLiPreamble(extractLlmText(r).trim())).slice(0, 370) + `\n\nBest,\n${SENDER_FIRST_NAME}`; } catch { fuLiNote = `Hi ${getFirstName(name)}, following up on my earlier note.\n\nBest,\n${SENDER_FIRST_NAME}`; }
      if (etherabotChatId) await pushToEtheraBot(etherabotChatId, `[LI FU${fuNum}] ${liFuQid} | ${name} @ ${company}\n\n${fuLiNote}`, liButtons(liFuQid));
      else await brains.telegram_push({ text: `[LI FU${fuNum}] ${liFuQid} | ${name} @ ${company}\n${fuLiNote}` });
      try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: liFuQid, lead_id: leadId, lead_name: name, lead_linkedin_id: linkedInId, company, channel: "linkedin", follow_up_number: String(fuNum), subject: `Follow-up ${fuNum}`, body: fuLiNote, original_body: fuLiNote, status: "pending_approval", draft_id: "", approval_outcome: "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
      liDraftsCreated.push(`${liFuQid}: FU${fuNum} LI -> ${name} @ ${company}`);
    } else { console.log(`  ${leadId}: skipping LI FU${fuNum} - no sent LinkedIn cold row`); }
    if (lead.row_id) { try { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads", patch: { follow_up_count: String(fuNum), follow_up_due_at: new Date(now.getTime() + FOLLOW_UP_DELAY_MS).toISOString() } }); } catch {} }
    emailDraftsCreated.push(`${emailFuQid}: FU${fuNum} -> ${resolvedFuEmail}`);
  }

  const liCatchupLeads = allLeads.filter(l => {
    if (l._deleted_at || l.outreach_status !== "Sent") return false;
    if (TEST_ONLY_MODE && !isTestLead(String(l.id ?? ""))) return false;
    const leadId = String(l.id ?? "");
    const hasSentLiCold = activeQueueRows.some(r =>
      String(r.lead_id) === leadId && r.channel === "linkedin" &&
      String(r.follow_up_number ?? "0") === "0" && (r.status === "sent" || r.status === "linkedin_sent")
    );
    if (!hasSentLiCold) return false;
    const latestEmailFu = activeQueueRows
      .filter(r => String(r.lead_id) === leadId && r.channel === "email" &&
        parseInt(String(r.follow_up_number ?? "0"), 10) > 0 &&
        (r.status === "pending_approval" || r.status === "sent"))
      .sort((a, b) => parseInt(String(b.follow_up_number ?? "0"), 10) - parseInt(String(a.follow_up_number ?? "0"), 10))[0];
    if (!latestEmailFu) return false;
    const fuNum = parseInt(String(latestEmailFu.follow_up_number ?? "0"), 10);
    const hasLiFu = activeQueueRows.some(r =>
      String(r.lead_id) === leadId && r.channel === "linkedin" &&
      parseInt(String(r.follow_up_number ?? "0"), 10) === fuNum &&
      (r.status === "pending_approval" || r.status === "sent" || r.status === "dm_pending" || r.status === "linkedin_sent")
    );
    return !hasLiFu;
  });
  if (liCatchupLeads.length > 0) {
    console.log(`LI catch-up: ${liCatchupLeads.length} lead(s) missing LI FU`);
    for (const lead of liCatchupLeads) {
      const leadId = String(lead.id ?? "");
      const name = String(lead.name ?? ""), company = String(lead.company ?? "");
      const linkedInId = String((lead as Record<string, unknown>).linkedin_profile_id ?? (lead as Record<string, unknown>).linkedIn ?? "");
      const fuEtheraCases = String((lead as Record<string, unknown>).ethera_use_cases ?? "").trim().slice(0, 400);
      const latestEmailFu = activeQueueRows
        .filter(r => String(r.lead_id) === leadId && r.channel === "email" &&
          parseInt(String(r.follow_up_number ?? "0"), 10) > 0 &&
          (r.status === "pending_approval" || r.status === "sent"))
        .sort((a, b) => parseInt(String(b.follow_up_number ?? "0"), 10) - parseInt(String(a.follow_up_number ?? "0"), 10))[0];
      const fuNum = parseInt(String(latestEmailFu?.follow_up_number ?? "1"), 10);
      const sentLiColdRow = activeQueueRows.find(r =>
        String(r.lead_id) === leadId && r.channel === "linkedin" &&
        String(r.follow_up_number ?? "0") === "0" && (r.status === "sent" || r.status === "linkedin_sent")
      );
      const origLiNote = String(sentLiColdRow?.body ?? "");
      const fuLiStyle = fuNum === 1 ? "FU1: new angle or question." : fuNum === 2 ? "FU2: concrete example or social proof." : "FU3: polite breakup, leave door open.";
      const fuLiCasesCtx = fuEtheraCases ? ` ${PRODUCT_NAME} use case for ${company}: ${fuEtheraCases.split("\n")[0].slice(0, 150)}.` : "";
      const fuLiPrompt = `You are ${SENDER_IDENTITY}.\nLI DM follow-up #${fuNum} to ${name} at ${company}. You are already connected on LinkedIn and already sent an initial DM. Do NOT say "thanks for connecting" -- the connection already happened.\n${origLiNote ? `Your original DM: "${origLiNote}"\n` : ""}${fuLiCasesCtx}\n${fuLiStyle}\nNo em dashes. Short paragraphs, blank line between each. Max 350 chars. Do not include any sign-off or closing line. Start: Hi ${getFirstName(name)},`;
      let fuLiNote = "";
      try { const r = await brains.llm({ prompt: fuLiPrompt, max_tokens: 150 }); fuLiNote = sanitizeEmDashes(stripLiPreamble(extractLlmText(r).trim())).slice(0, 370) + `\n\nBest,\n${SENDER_FIRST_NAME}`; } catch { fuLiNote = `Hi ${getFirstName(name)}, following up on my earlier note.\n\nBest,\n${SENDER_FIRST_NAME}`; }
      const liFuQid = nextQid(counter);
      if (etherabotChatId) await pushToEtheraBot(etherabotChatId, `[LI FU${fuNum}] ${liFuQid} | ${name} @ ${company}\n\n${fuLiNote}`, liButtons(liFuQid));
      else await brains.telegram_push({ text: `[LI FU${fuNum}] ${liFuQid} | ${name} @ ${company}\n${fuLiNote}` });
      try { await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{ id: liFuQid, lead_id: leadId, lead_name: name, lead_linkedin_id: linkedInId, company, channel: "linkedin", follow_up_number: String(fuNum), subject: `Follow-up ${fuNum}`, body: fuLiNote, original_body: fuLiNote, status: "pending_approval", draft_id: "", approval_outcome: "", edit_instruction: "", created_at: now.toISOString() }] }); } catch {}
      liDraftsCreated.push(`${liFuQid}: LI FU${fuNum} catch-up -> ${name} @ ${company}`);
      console.log(`  LI catch-up: ${liFuQid} FU${fuNum} -> ${name} @ ${company}`);
    }
  }

  const newMax = Math.max(counter.value, queueCounter);
  try { await brains.update_board_row({ board_id: BOARD_ID, row_id: String(counterRow?.row_id ?? ""), dataset: "meta", patch: { value: String(newMax), updated_at: now.toISOString() } }); } catch {}
  console.log(`Done. Email: ${emailDraftsCreated.join(", ")} | LI: ${liDraftsCreated.join(", ")}`);
}

main();
