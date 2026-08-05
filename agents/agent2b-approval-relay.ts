// ============================================================
// Agent 2B: Ethera Approval Relay
// Brains automation ID: f363a88a-7c8c-4e74-bb66-229c53b2fd2c
// Version: 23
// Cron: * * * * * (every minute)
// Description: Reads pending email drafts from board, relays to Telegram (matthiasetherabot),
//              processes send/discard/skip/edit commands from chat_session pages.
// ============================================================

// v23: Add "edit OQ-XXXX: [instructions]" command — migrated from legacy ethera-outreach-approval-processor.
//      Reads current body, calls LLM to apply edit, updates OQ row, pushes new preview immediately.
//      Requires automation_llm_complete grant.
// ETHERA AGENT 2B v20 — Step 1 scans all non-terminal email rows, not a specific status
// v20: Chasing specific intermediate statuses (pending_approval, draft_ready, pending_send)
//      is brittle -- the approval-processor can introduce new ones. The correct gate is
//      the Gmail sent check itself. Step 1 now scans ANY email row that isn't already
//      terminal (sent/discarded/skipped/linkedin_sent) and has a subject + draft_id.
// v19: Step 1 filter previously only picked up rows with status==="pending_approval".
//      OQ rows confirmed from brains inbox get status "draft_ready" (set by
//      ethera-outreach-approval-processor), not "pending_approval". Gmail scan
//      was skipping them entirely -- no markSent, no notification. Fix: include
//      "draft_ready" alongside "pending_approval" in the Step 1 filter.
// v18: Add "Do not include any email signature" to the NL request so brains does not
//      append the Gmail HTML signature block to FU threaded replies. FU emails use
//      plain-text "Best,\nMatthias" embedded in body2 only.
// v17: threading fix: revert edits on confirm_action, use NL request
// v16: sign-off fix: confirm_action edits:{body:body2} to force-inject sign-off. (broke threading)
// v15: sign-off fix: strip quoted thread before act_on_integration
// v15: brains re-draft LLM strips "Best,\nMatthias" when it appears right before
//   "On [date]...wrote:". Fix: extract new content only (before the
//   quoted thread separator) before calling act_on_integration. thread_id handles threading.
// ETHERA AGENT 2B — APPROVAL RELAY v14
// v14: Fix two status-update bugs:
//   Bug 1 (FU): Remove notify:["inbox"] from FU act_on_integration call. brains was creating an
//     inbox action and its confirm side-effect overwrote markSent's {status:"sent"} with
//     {status:"approved", approval_outcome:"sent"}, which Agent 2A's fuBatch filter missed.
//   Bug 2 (Cold): When native brains bot confirms a draft before Agent 2B's proactive Gmail scan,
//     OQ row gets status:"sent" but approval_outcome:"" (brains-set, no markSent). Next Agent 2B
//     tick skips it (filter requires pending_approval). Lead row stays Queued. Fix: in Step 2,
//     when "send OQ-xxxx" command is seen for a row already "sent", check if lead still needs
//     syncing and update it.
// v13: Fix Gmail threading for FU emails. FU OQ rows have no draft_id (Agent 2A stopped creating
//      brains drafts for FUs). Step 1 proactive scan skips rows without draft_id. Step 2 "send"
//      handler detects FU rows with gmail_thread_id and calls act_on_integration+confirm_action
//      directly with thread_id -- bypassing the native bot re-draft that was stripping thread_id.
//      Step 3 preview now includes FU rows without draft_id (identified by gmail_thread_id).
// v12: Store gmail_thread_id + gmail_message_id on OQ row when email confirmed sent.
// v11: Fix FU false-positive auto-confirm via internalDate timestamp filtering.
// v10: Remove SIGNATURE from Telegram previews.
// v9:  Fix spam via telegram_msg_id flag.
// ============================================================

const _ccSecret   = "{{cc_board_id}}";
const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
let BOARD_ID      = "95dcb668-e2d9-4093-9a3e-3200901846fa";
const _gmailSecret = "{{gmail_install_id}}";
const GMAIL_INSTALL_ID: string | null = _gmailSecret.startsWith("{{") ? null : _gmailSecret;
let TEST_ONLY_MODE = true;
const CMD_WINDOW_MS = 2 * 60 * 60 * 1000;
const FOLLOW_UP_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

function getBoardRows(board: unknown, dataset: string): Record<string, unknown>[] {
  if (!board || typeof board !== "object") return [];
  const b = board as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  const datasets = data?.datasets as Record<string, unknown> | undefined;
  const ds = datasets?.[dataset] as Record<string, unknown> | undefined;
  return (ds?.rows as Record<string, unknown>[]) ?? [];
}

function isTestLead(id: string): boolean { return String(id).toUpperCase().startsWith("TEST-"); }

function extractLlmText(res: unknown): string {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object") return "";
  const r = res as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  if (typeof r.completion === "string") return r.completion;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content) && r.content.length > 0) {
    const f = r.content[0] as Record<string, unknown>;
    if (typeof f.text === "string") return f.text;
  }
  return "";
}

async function fetchGmailSentMessages(subject: string, after: Date | null): Promise<Record<string, unknown>[]> {
  try {
    const afterStr = after
      ? `${after.getUTCFullYear()}/${String(after.getUTCMonth() + 1).padStart(2, "0")}/${String(after.getUTCDate()).padStart(2, "0")}`
      : "2026/01/01";
    const query = `in:sent subject:"${subject.replace(/"/g, "")}" after:${afterStr}`;
    const res = await brains.act_on_integration({
      source: "gmail",
      ...(GMAIL_INSTALL_ID ? { install_id: GMAIL_INSTALL_ID } : {}),
      action_name: "search_emails",
      input: { query, limit: 10 }
    });
    if (!res || typeof res !== "object") return [];
    const r = res as Record<string, unknown>;
    const result = r.result as Record<string, unknown> | undefined;
    const messages = (result?.messages ?? r.messages) as Record<string, unknown>[] | undefined;
    return messages ?? [];
  } catch { return []; }
}

type GmailCheck = { confirmed: boolean; threadId: string; messageId: string };
const GMAIL_NOT_FOUND: GmailCheck = { confirmed: false, threadId: "", messageId: "" };

async function checkGmailSentAfterTime(subject: string, afterMs: number): Promise<GmailCheck> {
  const afterDate = new Date(afterMs);
  const messages = await fetchGmailSentMessages(subject, afterDate);
  if (messages.length === 0) return GMAIL_NOT_FOUND;

  function extractIds(m: Record<string, unknown>): { threadId: string; messageId: string } {
    return {
      threadId: String(m.threadId ?? m.thread_id ?? ""),
      messageId: String(m.id ?? m.messageId ?? m.message_id ?? ""),
    };
  }

  let hasTimestamp = false;
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    const rawDate = m.internalDate ?? m.date ?? m.timestamp ?? m.sentAt ?? m.sent_at;
    if (rawDate === undefined || rawDate === null) continue;
    hasTimestamp = true;
    let msgMs: number;
    if (typeof rawDate === "number") {
      msgMs = rawDate > 1e12 ? rawDate : rawDate * 1000;
    } else if (typeof rawDate === "string" && /^\d{10,13}$/.test(rawDate)) {
      const n = parseInt(rawDate, 10);
      msgMs = n > 1e12 ? n : n * 1000;
    } else {
      msgMs = new Date(String(rawDate)).getTime();
    }
    if (!isNaN(msgMs) && msgMs >= afterMs) {
      return { confirmed: true, ...extractIds(m) };
    }
  }

  if (!hasTimestamp) {
    console.log(`  No timestamps in Gmail results -- trusting date filter (${messages.length} match(es))`);
    return { confirmed: true, ...extractIds(messages[0] as Record<string, unknown>) };
  }
  console.log(`  Gmail match found but all messages pre-date OQ row creation -- false positive skipped`);
  return GMAIL_NOT_FOUND;
}

async function markSent(row: Record<string, unknown>, allLeads: Record<string, unknown>[], now: Date, reason: string, threadId = "", messageId = ""): Promise<void> {
  const qid = String(row.id ?? "");
  const name = String(row.lead_name ?? row.lead_id ?? "");
  const company = String(row.company ?? "");
  const subject = String(row.subject ?? "");
  const fuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
  const fuLabel = fuNum === 0 ? "Cold" : fuNum === -1 ? "Reply" : `FU${fuNum}`;

  const patch: Record<string, unknown> = { status: "sent", approval_outcome: reason };
  if (threadId) patch.gmail_thread_id = threadId;
  if (messageId) patch.gmail_message_id = messageId;
  await brains.update_board_row({
    board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue",
    patch
  });
  const lead = allLeads.find(l => String(l.id ?? "") === String(row.lead_id ?? ""));
  if (lead?.row_id) {
    await brains.update_board_row({
      board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads",
      patch: {
        outreach_status: "Sent",
        follow_up_due_at: new Date(now.getTime() + FOLLOW_UP_DELAY_MS).toISOString()
      }
    });
  }
  await brains.telegram_push({
    text: `${fuLabel} email confirmed sent: ${name} @ ${company}\nSubject: ${subject}\n\nLead -> Sent. Next FU in 3 days.`
  });
  console.log(`${qid}: marked sent (${reason})`);
}

async function syncLeadToSent(leadId: string, allLeads: Record<string, unknown>[], now: Date, qid: string): Promise<void> {
  const lead = allLeads.find(l => String(l.id ?? "") === leadId);
  if (!lead?.row_id) return;
  if (String(lead.outreach_status ?? "") === "Sent") return;
  await brains.update_board_row({
    board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads",
    patch: {
      outreach_status: "Sent",
      follow_up_due_at: new Date(now.getTime() + FOLLOW_UP_DELAY_MS).toISOString()
    }
  });
  const name = String(lead.name ?? lead.id ?? "");
  const company = String(lead.company ?? "");
  await brains.telegram_push({ text: `Lead synced to Sent: ${name} @ ${company} (${qid} auto-confirmed by brains)` });
  console.log(`${qid}: lead synced to Sent (brains auto-confirmed cold email)`);
}

async function main() {
  console.log(`Agent 2B v23 starting...`);
  const now = new Date();

  // Read cc_setup from CC board to get test_mode override
  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, { dataset: "meta", limit: 100 });
    const ccRows = getBoardRows(ccBoard, "meta").filter((r: Record<string, unknown>) => !r._deleted_at);
    const setupRow = ccRows.find((r: Record<string, unknown>) => r.key === "cc_setup");
    if (setupRow) {
      const setup = JSON.parse(String(setupRow.value ?? "{}")) as Record<string, unknown>;
      if (!_ccSecret.startsWith("{{") && setup.prospector_id) BOARD_ID = String(setup.prospector_id);
      if (typeof setup.test_mode === "boolean") TEST_ONLY_MODE = setup.test_mode;
    }
  } catch (e) {
    console.log(`cc_setup read error (using default TEST_ONLY_MODE=${TEST_ONLY_MODE}): ${String(e).slice(0, 80)}`);
  }
  console.log(`TEST_ONLY_MODE=${TEST_ONLY_MODE}`);

  const queueBoard = await brains.boards.get(BOARD_ID, { dataset: "outreach_queue", limit: 2000 });
  const queueRows = getBoardRows(queueBoard, "outreach_queue").filter(r => !r._deleted_at);
  const leadsBoard = await brains.boards.get(BOARD_ID, { dataset: "leads", limit: 1000 });
  const allLeads = getBoardRows(leadsBoard, "leads").filter(l => !l._deleted_at);

  // --- Step 1: Proactive Gmail scan — any non-terminal email row with a subject ---
  const TERMINAL_STATUSES = new Set(["sent", "discarded", "skipped", "linkedin_sent"]);
  const pendingEmailRows = queueRows.filter(r => {
    if (TERMINAL_STATUSES.has(String(r.status ?? "")) || r.channel !== "email") return false;
    if (TEST_ONLY_MODE && !isTestLead(String(r.lead_id ?? ""))) return false;
    if (!String(r.draft_id ?? "").trim() || String(r.draft_id ?? "").trim().length < 10) return false;
    return String(r.subject ?? "").trim().length > 0;
  });

  const sentQids = new Set<string>();

  for (const row of pendingEmailRows) {
    const qid = String(row.id ?? "");
    const subject = String(row.subject ?? "").trim();
    const rowCreatedAt = row.created_at ? new Date(String(row.created_at)) : null;
    const afterMs = rowCreatedAt ? rowCreatedAt.getTime() : 0;
    const fuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
    console.log(`Checking Gmail sent for ${qid} (FU${fuNum}): "${subject.slice(0, 50)}"`);
    const gmailCheck = await checkGmailSentAfterTime(subject, afterMs);
    if (gmailCheck.confirmed) {
      try { await markSent(row, allLeads, now, "confirmed_via_gmail", gmailCheck.threadId, gmailCheck.messageId); sentQids.add(qid); }
      catch (e) { console.log(`markSent err ${qid}: ${String(e).slice(0, 80)}`); }
    } else {
      console.log(`${qid}: not confirmed in Gmail sent`);
    }
  }

  // --- Step 1b: Sync leads for brains-auto-confirmed cold emails ---
  const brainsConfirmedRows = queueRows.filter(r => {
    if (r.status !== "sent" || r.channel !== "email") return false;
    if (TEST_ONLY_MODE && !isTestLead(String(r.lead_id ?? ""))) return false;
    if (parseInt(String(r.follow_up_number ?? "0"), 10) !== 0) return false;
    if (String(r.approval_outcome ?? "").trim() !== "") return false;
    const rowCreatedAt = r.created_at ? new Date(String(r.created_at)) : null;
    if (!rowCreatedAt) return false;
    const ageMs = now.getTime() - rowCreatedAt.getTime();
    return ageMs < 24 * 60 * 60 * 1000;
  });

  for (const row of brainsConfirmedRows) {
    const qid = String(row.id ?? "");
    if (sentQids.has(qid)) continue;
    await syncLeadToSent(String(row.lead_id ?? ""), allLeads, now, qid);
  }

  // --- Step 2: Process send/discard/skip commands from recent chat_session pages (2h window) ---
  let cmdPages: Record<string, unknown>[] = [];
  try {
    const raw = await brains.search({ query: "send OQ- discard OQ- skip OQ- edit OQ-", type: "chat_session", limit: 20 });
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      const pages = (r.pages ?? r.results ?? []) as Record<string, unknown>[];
      cmdPages = pages.filter(p => {
        const d = p.updated_at ?? p.created_at;
        if (!d) return false;
        const dt = new Date(String(d));
        return !isNaN(dt.getTime()) && now.getTime() - dt.getTime() < CMD_WINDOW_MS;
      });
    }
  } catch (e) { console.log(`search error: ${String(e).slice(0, 80)}`); }

  const processedQids = new Set<string>();

  for (const page of cmdPages) {
    const text = String(page.content ?? page.body ?? page.text ?? page.title ?? "");

    const sendMatches = [...text.matchAll(/^send\s+(OQ-\d+)\s*$/gim)];
    for (const match of sendMatches) {
      const qid = match[1].toUpperCase();
      if (processedQids.has(`send:${qid}`)) continue;
      processedQids.add(`send:${qid}`);

      const row = queueRows.find(r => String(r.id) === qid);
      if (!row) continue;
      if (TEST_ONLY_MODE && !isTestLead(String(row.lead_id ?? ""))) continue;

      if (["discarded", "skipped"].includes(String(row.status ?? ""))) continue;

      if (String(row.status ?? "") === "sent") {
        if (sentQids.has(qid)) continue;
        await syncLeadToSent(String(row.lead_id ?? ""), allLeads, now, qid);
        sentQids.add(qid);
        continue;
      }

      const subject = String(row.subject ?? "").trim();
      const rowCreatedAt = row.created_at ? new Date(String(row.created_at)) : null;
      const afterMs = rowCreatedAt ? rowCreatedAt.getTime() : 0;
      const rowDraftId = String(row.draft_id ?? "").trim();
      const rowFuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
      const rowGmailThreadId = String(row.gmail_thread_id ?? "").trim();

      if (!rowDraftId && rowFuNum > 0 && rowGmailThreadId) {
        console.log(`"send ${qid}" FU${rowFuNum} -- sending as threaded reply, thread_id=${rowGmailThreadId}`);
        const toEmail = String(row.lead_email ?? "");
        const fullBody = String(row.body ?? "").trim();
        const quoteIdx = fullBody.search(/\n+On .+wrote:/i);
        const body2 = quoteIdx >= 0 ? fullBody.slice(0, quoteIdx).trim() : fullBody;
        try {
          const sendRes = await brains.act_on_integration({
            source: "gmail",
            ...(GMAIL_INSTALL_ID ? { install_id: GMAIL_INSTALL_ID } : {}),
            request: `Reply in Gmail thread ${rowGmailThreadId} to ${toEmail}. Subject: "${subject}". Do not include any email signature. Use this exact body verbatim:\n\n${body2}`
          });
          const newDraftId = String((sendRes as Record<string, unknown>)?.draft_id ?? "").trim();
          if (newDraftId) {
            await brains.confirm_action({ draft_id: newDraftId });
            const gmailCheck3 = await checkGmailSentAfterTime(subject, afterMs);
            await markSent(row, allLeads, now, "agent2b_threaded_send",
              gmailCheck3.confirmed ? gmailCheck3.threadId : rowGmailThreadId,
              gmailCheck3.confirmed ? gmailCheck3.messageId : "");
            sentQids.add(qid);
          } else {
            console.log(`${qid}: act_on_integration returned no draft_id -- skipping`);
          }
        } catch (e) { console.log(`FU threaded send ${qid} err: ${String(e).slice(0, 80)}`); }

      } else {
        console.log(`"send ${qid}" command detected -- verifying in Gmail Sent...`);
        const gmailCheck2 = await checkGmailSentAfterTime(subject, afterMs);
        if (gmailCheck2.confirmed) {
          try { await markSent(row, allLeads, now, "confirmed_via_telegram_cmd", gmailCheck2.threadId, gmailCheck2.messageId); sentQids.add(qid); }
          catch (e) { console.log(`markSent send ${qid} err: ${String(e).slice(0, 80)}`); }
        } else {
          console.log(`${qid}: "send" command seen but not yet in Gmail Sent -- will retry next tick`);
        }
      }
    }

    const cmdMatches = [...text.matchAll(/\b(discard|skip)\s+(OQ-\d+)/gi)];
    for (const match of cmdMatches) {
      const cmd = match[1].toLowerCase();
      const qid = match[2].toUpperCase();
      if (processedQids.has(`${cmd}:${qid}`)) continue;
      processedQids.add(`${cmd}:${qid}`);
      if (sentQids.has(qid)) continue;

      const row = queueRows.find(r => String(r.id) === qid);
      if (!row) continue;
      if (TEST_ONLY_MODE && !isTestLead(String(row.lead_id ?? ""))) continue;
      if (["sent", "discarded", "skipped"].includes(String(row.status ?? ""))) continue;

      const name = String(row.lead_name ?? row.lead_id ?? "");
      const company = String(row.company ?? "");
      const draftId = String(row.draft_id ?? "").trim() || undefined;

      if (cmd === "discard") {
        try {
          if (draftId) { try { await brains.discard_action({ draft_id: draftId }); } catch {} }
          await brains.update_board_row({
            board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue",
            patch: { status: "discarded", approval_outcome: "discarded_by_user" }
          });
          const fuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
          if (fuNum === 0 && row.channel === "email") {
            const lead = allLeads.find(l => String(l.id ?? "") === String(row.lead_id ?? ""));
            if (lead?.row_id) {
              await brains.update_board_row({
                board_id: BOARD_ID, row_id: String(lead.row_id), dataset: "leads",
                patch: { outreach_status: "New", cold_email_subject: "" }
              });
            }
          }
          await brains.telegram_push({ text: `Discarded: ${qid} -- ${name} @ ${company}.` });
        } catch (e) { console.log(`discard ${qid} err: ${String(e).slice(0, 80)}`); }

      } else if (cmd === "skip") {
        try {
          await brains.update_board_row({
            board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue",
            patch: { status: "skipped", approval_outcome: "skipped_by_user" }
          });
          await brains.telegram_push({ text: `Skipped: ${qid} -- ${name} @ ${company}.` });
        } catch (e) { console.log(`skip ${qid} err: ${String(e).slice(0, 80)}`); }
      }
    }

    // --- edit OQ-XXXX: [instructions] ---
    const editMatches = [...text.matchAll(/\bedit\s+(OQ-\d+):\s*([^\n]+)/gi)];
    for (const match of editMatches) {
      const qid = match[1].toUpperCase();
      const instruction = match[2].trim();
      if (processedQids.has(`edit:${qid}`)) continue;
      processedQids.add(`edit:${qid}`);
      if (sentQids.has(qid)) continue;

      const row = queueRows.find(r => String(r.id) === qid);
      if (!row) { console.log(`edit ${qid}: row not found`); continue; }
      if (TEST_ONLY_MODE && !isTestLead(String(row.lead_id ?? ""))) continue;
      if (["sent", "discarded", "skipped"].includes(String(row.status ?? ""))) continue;

      const name = String(row.lead_name ?? row.lead_id ?? "");
      const company = String(row.company ?? "");
      const toEmail = String(row.lead_email ?? "");
      const subject = String(row.subject ?? "").trim();
      const currentBody = String(row.original_body ?? row.body ?? "").trim();
      const fuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
      const fuLabel = fuNum === 0 ? "Cold" : fuNum === -1 ? "Reply" : `FU${fuNum}`;

      try {
        const prompt = `You wrote this outreach email:\n\nSubject: ${subject}\n\n${currentBody}\n\nEdit request: "${instruction}"\n\nApply the edit. No em dashes. Return exactly:\nSubject: [subject line]\n\n[full email body including greeting and sign-off]`;
        const res = await brains.llm({ prompt, max_tokens: 500 });
        const raw = extractLlmText(res).trim();
        const lines = raw.split("\n");
        const subLine = lines.find(l => l.toLowerCase().startsWith("subject:"));
        const newSubject = subLine ? subLine.replace(/^subject:\s*/i, "").trim() : subject;
        const bodyLines = subLine ? lines.slice(lines.indexOf(subLine) + 1) : lines;
        const newBody = bodyLines.join("\n").replace(/^\n+/, "").trim() || currentBody;

        await brains.update_board_row({
          board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue",
          patch: { body: newBody, subject: newSubject, edit_instruction: instruction, telegram_msg_id: "" }
        });

        let preview = `EDITED ${qid} | ${fuLabel} | ${name} @ ${company}\n\nTo: ${toEmail}\nSubject: ${newSubject}\n\n${newBody}`;
        preview += `\n\n---\nsend ${qid} | discard ${qid} | skip ${qid} | edit ${qid}: [instructions]`;
        await brains.telegram_push({ text: preview.slice(0, 4096) });
        await brains.update_board_row({
          board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue",
          patch: { telegram_msg_id: "previewed" }
        });
        console.log(`edit ${qid}: regenerated (${instruction.slice(0, 50)})`);
      } catch (e) {
        console.log(`edit ${qid} err: ${String(e).slice(0, 80)}`);
        try { await brains.telegram_push({ text: `Edit failed for ${qid}: ${String(e).slice(0, 100)}` }); } catch {}
      }
    }
  }

  // --- Step 3: Preview new pending email rows -- only if telegram_msg_id is empty ---
  const unpreviewedRows = queueRows.filter(r => {
    if (r._deleted_at || r.status !== "pending_approval" || r.channel !== "email") return false;
    if (TEST_ONLY_MODE && !isTestLead(String(r.lead_id ?? ""))) return false;
    const hasDraft = String(r.draft_id ?? "").trim().length >= 10;
    const isFuWithThread = parseInt(String(r.follow_up_number ?? "0"), 10) > 0 && String(r.gmail_thread_id ?? "").trim().length > 5;
    if (!hasDraft && !isFuWithThread) return false;
    if (sentQids.has(String(r.id ?? ""))) return false;
    const msgId = String(r.telegram_msg_id ?? "").trim();
    return msgId === "" || msgId === "null" || msgId === "undefined";
  });

  if (unpreviewedRows.length === 0) {
    console.log("No unpreviewed pending email rows.");
    return;
  }

  console.log(`Sending previews for ${unpreviewedRows.length} unpreviewed email row(s)...`);
  const approveAllIds: string[] = [];

  for (const row of unpreviewedRows) {
    const qid = String(row.id ?? "");
    const name = String(row.lead_name ?? row.lead_id ?? "");
    const company = String(row.company ?? "");
    const toEmail = String(row.lead_email ?? "");
    const subject = String(row.subject ?? "");
    const fuNum = parseInt(String(row.follow_up_number ?? "0"), 10);
    const fuLabel = fuNum === 0 ? "Cold" : fuNum === -1 ? "Reply" : `FU${fuNum}`;
    const body = String(row.body ?? "");

    let preview = `${qid} | ${fuLabel} | ${name} @ ${company}\n\nTo: ${toEmail}\nSubject: ${subject}\n\n${body}`;
    preview += `\n\n---\nsend ${qid} | discard ${qid} | skip ${qid} | edit ${qid}: [instructions]`;

    try {
      await brains.telegram_push({ text: preview.slice(0, 4096) });
      await brains.update_board_row({
        board_id: BOARD_ID, row_id: String(row.row_id), dataset: "outreach_queue",
        patch: { telegram_msg_id: "previewed" }
      });
      console.log(`Previewed ${qid}`);
      approveAllIds.push(qid);
    } catch (e) {
      console.log(`telegram_push err for ${qid}: ${String(e).slice(0, 80)}`);
    }
  }

  if (approveAllIds.length > 1) {
    const batchMsg = `Ethera Outreach -- ${approveAllIds.length} email draft(s) pending\n\nApprove all at once:\nsend ${approveAllIds.join(" ")}\n\nOr approve individually: send OQ-xxxx`;
    try { await brains.telegram_push({ text: batchMsg }); } catch {}
  }

  console.log(`Agent 2B v23 done. Previewed: ${approveAllIds.join(", ")}`);
}

main();
