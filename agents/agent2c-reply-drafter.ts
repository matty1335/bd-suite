// ============================================================
// Agent 2C: Reply Drafter
// Brains automation ID: 3966e90e-3ded-48c1-bea6-775597f00843
// Version: 8 — edit_instruction support: re-draft with revision, lead_email fix
// Trigger: on-demand via run_automation_once from linkedin-runner
// Description: Generates reply drafts when prospects reply on LinkedIn or email.
//              Reads reply_req_* meta rows, LLM-drafts reply, creates OQ row, Telegram.
// ============================================================

const _ccSecret   = "{{cc_board_id}}";
const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
const TG_BASE = "https://api.telegram.org/bot{{telegram_bot_id}}:{{telegram_bot_secret}}";

function extractLlmText(res: unknown): string {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object") return "";
  const r = res as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  if (typeof r.completion === "string") return r.completion;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content) && r.content.length > 0) { const f = r.content[0] as Record<string, unknown>; if (typeof f.text === "string") return f.text; }
  if (Array.isArray(r.choices) && r.choices.length > 0) { const c = r.choices[0] as Record<string, unknown>; const m = c.message as Record<string, unknown> | undefined; if (m && typeof m.content === "string") return m.content; }
  return "";
}

function getFirstName(n: string): string { return n.trim().split(/\s+/)[0]; }

function getBoardRows(board: unknown, dataset: string): Record<string, unknown>[] {
  if (!board || typeof board !== "object") return [];
  const b = board as Record<string, unknown>;
  const direct = (b as Record<string, unknown>)[dataset];
  if (direct && typeof direct === "object") { const rows = (direct as Record<string, unknown>).rows; if (Array.isArray(rows)) return rows as Record<string, unknown>[]; }
  const datasets = (b.datasets ?? (b.data as Record<string, unknown>)?.datasets) as Record<string, unknown> | undefined;
  if (datasets) { const ds = datasets[dataset] as Record<string, unknown> | undefined; if (ds?.rows && Array.isArray(ds.rows)) return ds.rows as Record<string, unknown>[]; }
  return [];
}

async function main() {
  console.log("Reply Drafter v8 starting...");
  const now = new Date();

  // --- Read cc_setup and active campaign config ---
  let BOARD_ID = "95dcb668-e2d9-4093-9a3e-3200901846fa";
  let SENDER_NAME = "Matthias";
  let SENDER_IDENTITY = "Matthias Ang, CCO at Ethera";
  let PRODUCT_NAME = "Ethera";
  let PRODUCT_DESC = "private permissioned blockchain infrastructure for banks";

  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, { dataset: "meta", limit: 50 });
    const ccRows = getBoardRows(ccBoard, "meta");

    const setupRow = ccRows.find(r => r.key === "cc_setup");
    if (setupRow) {
      const setup = JSON.parse(String(setupRow.value ?? "{}"));
      if (setup.prospector_id) BOARD_ID = setup.prospector_id;
    }

    const configRow = ccRows.find(r => r.key === "agent_config");
    if (configRow) {
      const cfg = JSON.parse(String(configRow.value ?? "{}"));
      const campaigns = Array.isArray(cfg.campaigns) ? cfg.campaigns : [];
      const active = campaigns.find((c: Record<string, unknown>) => c.id === cfg.active_campaign_id);
      if (active) {
        if (active.sender_name)          SENDER_NAME      = String(active.sender_name);
        if (active.sender_title)         SENDER_IDENTITY  = `${active.sender_name ?? SENDER_NAME}, ${active.sender_title}`;
        if (active.sender_title)         PRODUCT_NAME     = String(active.sender_title).split(/,\s*at\s*/i)[1]?.split(/[,\s]/)[0]?.trim() || PRODUCT_NAME;
        if (active.product_description)  PRODUCT_DESC     = String(active.product_description);
      }
    }
  } catch (e) {
    console.log(`cc_setup read failed, using defaults: ${String(e).slice(0, 80)}`);
  }

  console.log(`Config: BOARD_ID=${BOARD_ID} SENDER=${SENDER_NAME} PRODUCT=${PRODUCT_NAME}`);

  const metaBoard = await brains.boards.get(BOARD_ID, { dataset: "meta", limit: 100 });
  const metaRows = getBoardRows(metaBoard, "meta");

  const counterRow  = metaRows.find(r => r.key === "outreach_queue_counter");
  const chatIdRow   = metaRows.find(r => r.key === "telegram_chat_id");
  const etherabotChatId = String(chatIdRow?.value ?? "").trim();
  let queueCounter = parseInt(String(counterRow?.value ?? "0"), 10);

  const pendingReqs = metaRows
    .filter(r => String(r.key ?? "").startsWith("reply_req_"))
    .map(r => {
      try {
        const data = JSON.parse(String(r.value ?? "{}"));
        return { row_id: String(r.row_id), key: String(r.key), data };
      } catch { return null; }
    })
    .filter((r): r is { row_id: string; key: string; data: Record<string, unknown> } =>
      r !== null && r.data?.status === "pending"
    );

  console.log(`Pending reply requests: ${pendingReqs.length}`);
  if (pendingReqs.length === 0) { console.log("Nothing to do."); return; }

  // Fetch leads for research context
  let leadRows: Record<string, unknown>[] = [];
  try {
    const leadsBoard = await brains.boards.get(BOARD_ID, { dataset: "leads", limit: 2000 });
    leadRows = getBoardRows(leadsBoard, "leads");
  } catch (e) {
    console.log(`leads fetch failed: ${String(e).slice(0, 80)}`);
  }

  const queueBoard = await brains.boards.get(BOARD_ID, { dataset: "outreach_queue", limit: 2000 });
  const queueRows = getBoardRows(queueBoard, "outreach_queue");
  const maxExisting = Math.max(0, ...queueRows.map(r =>
    parseInt(String(r.id ?? "").replace("OQ-", ""), 10)
  ).filter(n => !isNaN(n)));
  if (maxExisting > queueCounter) queueCounter = maxExisting;

  for (const req of pendingReqs) {
    const d = req.data;
    const name      = String(d.name ?? "");
    const company   = String(d.company ?? "");
    const position  = String(d.position ?? "");
    const channel   = String(d.channel ?? "linkedin");
    const snippet   = String(d.snippet ?? "");
    const slug      = String(d.slug ?? "");
    const lead_id        = String(d.lead_id ?? "");
    const editInstruction = String(d.edit_instruction ?? "").trim();
    const firstName = getFirstName(name);

    if (!name || !company || !lead_id) {
      await brains.update_board_row({ board_id: BOARD_ID, row_id: req.row_id, dataset: "meta",
        patch: { value: JSON.stringify({ ...d, status: "error", error: "missing fields" }) }
      });
      continue;
    }

    // Research context from lead profile
    const leadRow = leadRows.find(r => String(r.id ?? "") === lead_id);
    const daResearch  = leadRow ? String(leadRow.da_research ?? "").trim() : "";
    const useCases    = leadRow ? String(leadRow.ethera_use_cases ?? leadRow.product_use_cases ?? "").trim() : "";
    const researchCtx = [daResearch, useCases].filter(Boolean).join("\n\n").slice(0, 700);
    const researchBlock = researchCtx
      ? `\nResearch on ${company} (use as context — don't recite verbatim):\n${researchCtx}\n`
      : "";

    const editBlock = editInstruction
      ? `\nIMPORTANT: The sender reviewed a previous draft and requested this revision: "${editInstruction}"\nRevise accordingly.\n`
      : "";

    const prompt = channel === "linkedin"
      ? `You are ${SENDER_IDENTITY} (${PRODUCT_DESC}).
${name} (${position} at ${company}) replied to your LinkedIn DM about ${PRODUCT_NAME}.
${snippet ? `What they wrote:\n"${snippet}"\n` : ""}${researchBlock}${editBlock}
Write a short warm LinkedIn reply. If interested: propose a 20-min intro call. If asking for info: use the research to give one relevant, specific hook about ${PRODUCT_NAME} + offer call. If unclear: ask a light clarifying question.
Tone: direct, human, conversational, not salesy. No em dashes. Max 100 words. No greeting (already prepended).
Return only the message body — no greeting, no sign-off.`
      : `You are ${SENDER_IDENTITY} (${PRODUCT_DESC}).
${name} (${position} at ${company}) replied to your cold outreach email.
${snippet ? `What they wrote:\n"${snippet}"\n` : ""}${researchBlock}${editBlock}
Write a short warm reply. If interested: use the research to make one specific, relevant point about ${PRODUCT_NAME} + propose a 20-min call. If asking for info: one focused paragraph. If not interested: thank gracefully, leave door open.
Tone: direct, human, not salesy. No em dashes. Max 120 words. No greeting (already prepended).
Return only the message body — no greeting, no sign-off.`;

    let draftBody = "";
    let llmFailed = false;
    try {
      const res = await brains.llm({ prompt, max_tokens: 200 });
      const raw = extractLlmText(res).trim();
      draftBody = raw ? `Hi ${firstName},\n\n${raw}\n\nBest,\n${SENDER_NAME}` : "";
      if (!draftBody) llmFailed = true;
    } catch (e) {
      console.log(`  LLM err: ${String(e).slice(0, 80)}`);
      llmFailed = true;
    }
    if (llmFailed) draftBody = `(LLM failed -- draft manually for ${name})`;

    queueCounter++;
    const qid = `OQ-${String(queueCounter).padStart(4, "0")}`;
    try {
      await brains.append_board_rows({ board_id: BOARD_ID, dataset: "outreach_queue", rows: [{
        id: qid, lead_id, lead_name: name, company, channel,
        lead_linkedin_id: slug, lead_email: String(leadRow?.email ?? ""),
        follow_up_number: "-1", status: "pending_approval",
        body: draftBody, subject: PRODUCT_NAME,
        original_body: draftBody, draft_id: "", approval_outcome: "",
        edit_instruction: "", got_response: "", response_days: "",
        response_channel: "", created_at: now.toISOString(), telegram_msg_id: ""
      }]});
      console.log(`  Created ${qid} for ${name} (${channel})`);
    } catch (e) { console.log(`  OQ append err: ${String(e).slice(0, 80)}`); }

    const label = channel === "linkedin" ? "LinkedIn" : "Email";
    const revLabel = editInstruction ? "Revised " : "";
    const snippetDisplay = snippet ? `\n\nThey wrote:\n"${snippet.slice(0, 200)}"` : "";
    const draftSection = llmFailed
      ? `\n\n${revLabel}Draft reply (${qid}): LLM failed -- draft manually`
      : `\n\n${revLabel}Draft reply (${qid}):\n\n${draftBody}`;
    const text = `${label} reply from ${name} @ ${company}${snippetDisplay}${draftSection}\n\nFU paused.`;

    if (!etherabotChatId) {
      console.log(`  telegram_chat_id not found in meta, cannot send notification`);
    } else {
      try {
        const kb = encodeURIComponent(JSON.stringify({
          inline_keyboard: [[
            { text: "Send Reply", callback_data: `send ${qid}` },
            { text: "Edit", callback_data: `edit ${qid}` },
            { text: "Skip", callback_data: `skip ${qid}` }
          ]]
        }));
        const url = `${TG_BASE}/sendMessage?chat_id=${encodeURIComponent(etherabotChatId)}&text=${encodeURIComponent(text)}&reply_markup=${kb}`;
        const tgRes = await brains.http_fetch({ url, method: "GET" });
        if (tgRes.ok) {
          console.log(`  Notified TelegramBot (${qid})`);
        } else {
          console.log(`  Telegram push failed: HTTP ${tgRes.status}`);
        }
      } catch (e) {
        console.log(`  Telegram push error: ${String(e).slice(0, 80)}`);
      }
    }

    try {
      await brains.update_board_row({ board_id: BOARD_ID, row_id: req.row_id, dataset: "meta",
        patch: { value: JSON.stringify({ ...d, status: "done", qid, processed_at: now.toISOString() }), updated_at: now.toISOString() }
      });
    } catch (e) { console.log(`  mark done err: ${String(e).slice(0, 60)}`); }
  }

  if (counterRow?.row_id) {
    try {
      await brains.update_board_row({ board_id: BOARD_ID, row_id: String(counterRow.row_id), dataset: "meta",
        patch: { value: String(queueCounter), updated_at: now.toISOString() }
      });
    } catch {}
  }

  console.log(`Reply Drafter v8 done. ${pendingReqs.length} request(s) processed.`);
}

await main();
