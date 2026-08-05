// ============================================================
// Agent 3: Meeting Intel
// Brains automation ID: ec09efd3-0529-4a79-ac22-f91edb14fb27
// Version: 13 — swap Tavily -> Serper; fix PRODUCT_NAME extraction comma-split
// Cron: */5 * * * * Asia/Singapore (every 5 min, brief fires 30 min before meeting)
// Description: Pre-call intelligence brief — detects external meetings, matches board leads,
//              fetches Serper news, generates LLM brief, pushes to Telegram.
// NOTE: TEST_MODE=false in production
// Last updated: 2026-08-04 (v13: swap Tavily -> Serper; fix PRODUCT_NAME extraction comma-split)
// ============================================================

// ============================================================
// MEETING INTEL — Agent 3 v13
//
// v13: Swap Tavily -> Serper for web search. Fix PRODUCT_NAME extraction to use
//      comma-split ("CCO, Ethera" -> "Ethera") instead of old "at" regex.
//      Keep api.tavily.com in http_fetch_hosts for rollback capability.
//
// v9: Consolidate noise_domains into exclude_domains. Single field for all
//     configurable noise domains — no more split between exclude_domains and
//     noise_domains. Reads campaign.exclude_domains at startup and merges into
//     NOISE_DOMAINS (which stays hardcoded personal-email-only baseline).
//     Falls back to legacy hardcoded set if exclude_domains absent or empty.
//
// v8: noise_domains refactor. NOISE_DOMAINS hardcoded set reduced to universal
//     personal email providers only.
//
// v7: Campaign-awareness. Reads active campaign config from Control Centre board
//     (2907a47b) at startup. SEARCH_TOPIC_SIGNALS replaces hardcoded topic terms
//     in BOTH Serper queries (7-day DA news + 30-day announcements). PRODUCT_CONTEXT
//     replaced with campaign.product_description. All with length > 0 fallback guards.
//
// v6: cron changed from 0 7 * * * to */5 * * * * (every 5 min polling).
// v5: Switch from 7AM daily cron to every-5-min polling.
// v4: Fix announcements query.
// v3: Add 30-day announcements search.
// v2: Add TEST_MODE.
// ============================================================

const TEST_MODE = false;

let BOARD_ID      = "95dcb668-e2d9-4093-9a3e-3200901846fa";
const _ccSecret   = "{{cc_board_id}}";
const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
const VERSION     = "v13";
const DEADLINE_MS = 200_000;

let SEARCH_TOPIC_SIGNALS = "digital assets blockchain tokenization fintech";
let PRODUCT_CONTEXT = "";
let SENDER_NAME     = "";
let SENDER_IDENTITY = "";
let PRODUCT_NAME    = "";
let OWN_DOMAIN      = "";
let TEST_EMAIL      = "";

const BRIEF_WINDOW_MIN_MS = 20 * 60 * 1000;
const BRIEF_WINDOW_MAX_MS = 40 * 60 * 1000;

// Universal personal email providers — always filtered; no prospect will ever have one
const NOISE_DOMAINS = new Set([
  "gmail.com","googlemail.com","yahoo.com","outlook.com","hotmail.com",
  "live.com","icloud.com","me.com","protonmail.com","pm.me",
]);

const DOMAIN_MAP: Record<string, string> = {
  "hsbc.com":"HSBC","jpmorgan.com":"JPMorgan","jpmchase.com":"JPMorgan",
  "ms.com":"Morgan Stanley","goldmansachs.com":"Goldman Sachs","gs.com":"Goldman Sachs",
  "blackrock.com":"BlackRock","bnymellon.com":"BNY Mellon",
  "statestreet.com":"State Street","db.com":"Deutsche Bank",
  "deutschebank.com":"Deutsche Bank","ubs.com":"UBS","barclays.com":"Barclays",
  "bnpparibas.com":"BNP Paribas","societegenerale.com":"Societe Generale",
  "citi.com":"Citi","citibank.com":"Citi","citigroup.com":"Citi",
  "swift.com":"SWIFT","dtcc.com":"DTCC","euroclear.com":"Euroclear",
  "clearstream.com":"Clearstream","fireblocks.com":"Fireblocks",
  "coinbase.com":"Coinbase","circle.com":"Circle","paxos.com":"Paxos",
  "anchorage.com":"Anchorage","worldpay.com":"Worldpay","fis.com":"FIS",
  "mastercard.com":"Mastercard","visa.com":"Visa",
  "uob.com.sg":"UOB","dbs.com.sg":"DBS","ocbc.com.sg":"OCBC",
  "mas.gov.sg":"MAS","hkma.gov.hk":"HKMA",
  "a16z.com":"a16z","paradigm.xyz":"Paradigm",
  "block.xyz":"Block","squareup.com":"Block",
};

function extractCompanyFromDomain(domain: string): string {
  if (DOMAIN_MAP[domain]) return DOMAIN_MAP[domain];
  const parts = domain.split(".");
  const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

function extractCompanyFromTitle(title: string): string {
  const escapedPN = PRODUCT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const xMatch = PRODUCT_NAME ? title.match(new RegExp(`(?:${escapedPN})\\s*[x×]\\s*(.+?)(?:\\s*[-|({]|$)`, 'i')) : null;
  if (xMatch) return xMatch[1].trim().replace(/\s+(intro|call|meeting|demo|sync)$/i, "").trim();
  const withMatch = title.match(/(?:call|intro|meeting|chat|sync|discussion|demo|catch-?up)\s+with\s+(.+?)(?:\s*[-|({]|$)/i);
  if (withMatch) return withMatch[1].trim();
  return "";
}

async function searchSerper(query: string, days: number): Promise<{title:string;url:string;content:string}[]> {
  try {
    const tbs = days <= 7 ? "qdr:w" : days <= 30 ? "qdr:m" : "qdr:y";
    const r = await brains.http_fetch({
      url: "https://google.serper.dev/search", method: "POST",
      headers: {"Content-Type":"application/json","X-API-KEY":"{{serper_api_key}}"},
      body: JSON.stringify({q: query, num: 5, tbs})
    });
    if (!r.ok) return [];
    const data = r.json as {organic?: {title:string;link:string;snippet:string}[]};
    return (data.organic ?? []).map(item => ({title: item.title, url: item.link, content: item.snippet}));
  } catch { return []; }
}

async function safePush(text: string) {
  try { await brains.telegram_push({text: text.slice(0, 4096)}); } catch {}
}

async function main() {
  const startTime = Date.now();
  function elapsed() { return Date.now() - startTime; }
  function overDeadline() { return elapsed() > DEADLINE_MS; }

  const nowMs = Date.now();
  const sgtOffsetMs = 8 * 60 * 60 * 1000;
  const todaySgt = new Date(nowMs + sgtOffsetMs).toISOString().slice(0, 10);
  const startIso = todaySgt + "T00:00:00+08:00";
  const endIso   = todaySgt + "T23:59:59+08:00";

  // Campaign config — read from Control Centre board, fallback to hardcoded defaults
  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, {dataset:"meta", limit:10});
    const ccRows = ((ccBoard?.datasets?.meta?.rows ?? ccBoard?.data?.datasets?.meta?.rows ?? []) as Record<string, unknown>[]);
    if (!_ccSecret.startsWith("{{")) {
      const setupRow = ccRows.find((r: Record<string, unknown>) => r.key === "cc_setup");
      if (setupRow) {
        try {
          const setup = JSON.parse(String(setupRow.value ?? "{}")) as Record<string, unknown>;
          if (setup.prospector_id) BOARD_ID = String(setup.prospector_id);
          if (setup.sender_name) { SENDER_NAME = String(setup.sender_name); SENDER_IDENTITY = SENDER_NAME; }
          if (setup.sender_title) SENDER_IDENTITY = `${SENDER_NAME}, ${String(setup.sender_title)}`;
          const senderEmail = String(setup.sender_email ?? "");
          if (senderEmail.includes("@")) OWN_DOMAIN = senderEmail.split("@")[1].toLowerCase().trim();
          if (setup.test_email) TEST_EMAIL = String(setup.test_email);
        } catch {}
      }
    }
    const configRow = ccRows.find((r: Record<string, unknown>) => r.key === "agent_config");
    if (configRow) {
      const config = JSON.parse(String(configRow.value ?? "{}")) as Record<string, unknown>;
      const campaigns = (config.campaigns as {id:string;topic_signals?:string[];product_description?:string;exclude_domains?:string[]}[] ?? []);
      const activeCampaignId = String(config.active_campaign_id ?? "");
      const campaign = campaigns.find(c => c.id === activeCampaignId) ?? null;
      if (campaign) {
        if ((campaign.topic_signals ?? []).length > 0) SEARCH_TOPIC_SIGNALS = (campaign.topic_signals as string[]).slice(0, 5).join(" ");
        if ((campaign.product_description ?? "").length > 0) PRODUCT_CONTEXT = campaign.product_description as string;
        if ((campaign as any).sender_name) { SENDER_NAME = String((campaign as any).sender_name); SENDER_IDENTITY = SENDER_NAME; }
        if ((campaign as any).sender_title) {
          SENDER_IDENTITY = `${SENDER_NAME}, ${String((campaign as any).sender_title)}`;
          const pn = String((campaign as any).sender_title).split(",")[1]?.trim();
          if (pn) PRODUCT_NAME = pn;
        }
        const excludeDoms = Array.isArray(campaign.exclude_domains) ? (campaign.exclude_domains as string[]) : [];
        if (excludeDoms.length > 0) {
          for (const d of excludeDoms) NOISE_DOMAINS.add(d.toLowerCase());
        } else {
          // No exclude_domains set — use generic tool fallback
          for (const d of ["zoom.us","teams.microsoft.com","webex.com","meet.google.com","calendly.com","hubspot.com","linkedin.com","notion.so"]) NOISE_DOMAINS.add(d);
          if (OWN_DOMAIN) NOISE_DOMAINS.add(OWN_DOMAIN);
        }
        console.log(`Campaign: ${campaign.id} loaded (${NOISE_DOMAINS.size} noise domains total)`);
      } else {
        // No active campaign — load generic tool fallback set
        for (const d of ["zoom.us","teams.microsoft.com","webex.com","meet.google.com","calendly.com","hubspot.com","linkedin.com","notion.so"]) NOISE_DOMAINS.add(d);
        if (OWN_DOMAIN) NOISE_DOMAINS.add(OWN_DOMAIN);
        console.log("Campaign config: no active campaign — using generic defaults");
      }
    }
  } catch (e) {
    // Error reading config — load generic tool fallback set
    for (const d of ["zoom.us","teams.microsoft.com","webex.com","meet.google.com","calendly.com","hubspot.com","linkedin.com","notion.so"]) NOISE_DOMAINS.add(d);
    if (OWN_DOMAIN) NOISE_DOMAINS.add(OWN_DOMAIN);
    console.log(`Campaign config: ${String(e).slice(0, 80)} — using generic defaults`);
  }

  type CalEvent = {
    id?: string;
    title: string; event_start: string; event_end?: string;
    location?: string; status?: string;
    attendees?: Array<{email:string;self?:boolean;response?:string;displayName?:string}>;
  };
  type MeetingItem = CalEvent & { meetingKey: string };

  let pendingMeetings: MeetingItem[] = [];

  if (TEST_MODE) {
    const testStartMs = nowMs + 30 * 60 * 1000;
    const testSgtTime = new Date(testStartMs + sgtOffsetMs).toISOString().slice(11, 16);
    console.log(`[TEST MODE] Injecting test meeting at ${testSgtTime} SGT`);
    pendingMeetings = [{
      id: "TEST_MEETING",
      meetingKey: "TEST_MEETING",
      title: `${PRODUCT_NAME || "Product"} x Test Company intro`,
      event_start: new Date(testStartMs).toISOString(),
      attendees: [{email: TEST_EMAIL || "test@example.com", self: false}],
    }];
  } else {
    const cal = await brains.call<{results?: CalEvent[]}>("list_calendar_events", {
      start: startIso, end: endIso, limit: 50
    });
    const allEvents = (cal.results ?? []).filter(e => e.status !== "cancelled");

    for (const e of allEvents) {
      const extAttendees = (e.attendees ?? []).filter(a => {
        if (a.self) return false;
        const domain = (a.email.split("@")[1] ?? "").toLowerCase();
        return !NOISE_DOMAINS.has(domain);
      });
      if (extAttendees.length === 0) continue;
      const diffMs = new Date(e.event_start).getTime() - nowMs;
      if (diffMs < BRIEF_WINDOW_MIN_MS || diffMs > BRIEF_WINDOW_MAX_MS) continue;
      pendingMeetings.push({ ...e, meetingKey: e.id ?? e.title });
    }

    console.log(`Calendar: ${allEvents.length} events, ${pendingMeetings.length} in 20-40 min window`);
    if (pendingMeetings.length === 0) { console.log("No meetings in window — exit."); return; }
  }

  const briefedKey = `meeting_intel_briefed_${todaySgt}`;
  let briefedIds: string[] = [];
  let briefedRowId: string | null = null;

  if (!TEST_MODE) {
    const metaBoard = await brains.boards.get(BOARD_ID, {dataset:"meta", limit:200});
    const metaRows = (
      (metaBoard as Record<string, unknown>)?.datasets as Record<string, {rows?: Record<string, unknown>[]}> | undefined
    )?.meta?.rows ?? (
      ((metaBoard as Record<string, unknown>)?.data as Record<string, unknown> | undefined)?.datasets as Record<string, {rows?: Record<string, unknown>[]}> | undefined
    )?.meta?.rows ?? [] as Record<string, unknown>[];

    const briefedRow = (metaRows as Record<string, unknown>[]).find(r => String(r.key ?? "") === briefedKey);
    if (briefedRow) {
      try { briefedIds = JSON.parse(String(briefedRow.value ?? "[]")); } catch {}
      briefedRowId = String(briefedRow.row_id ?? "");
    }

    pendingMeetings = pendingMeetings.filter(m => !briefedIds.includes(m.meetingKey));
    if (pendingMeetings.length === 0) { console.log("All in-window meetings already briefed — exit."); return; }
  }

  const boardLeads: Record<string, unknown>[] = [];
  let bOffset = 0;
  while (true) {
    const board = await brains.boards.get(BOARD_ID, {dataset:"leads", offset:bOffset, limit:1000});
    const rows = (
      (board as Record<string, unknown>)?.datasets as Record<string, {rows?: Record<string, unknown>[]}> | undefined
    )?.leads?.rows ?? (
      ((board as Record<string, unknown>)?.data as Record<string, unknown> | undefined)?.datasets as Record<string, {rows?: Record<string, unknown>[]}> | undefined
    )?.leads?.rows ?? [] as Record<string, unknown>[];
    boardLeads.push(...(rows as Record<string, unknown>[]));
    if ((rows as unknown[]).length < 1000) break;
    bOffset += (rows as unknown[]).length;
    if (bOffset > 10000) break;
  }
  const activeLeads = boardLeads.filter(l => !l._deleted_at);

  const companyLeadMap = new Map<string, Record<string, unknown>>();
  for (const lead of activeLeads) {
    const co = String(lead.company ?? "").toLowerCase().trim();
    if (!co) continue;
    const existing = companyLeadMap.get(co);
    if (!existing || (!existing.da_research && lead.da_research)) companyLeadMap.set(co, lead);
  }

  function findLead(companyName: string): Record<string, unknown> | null {
    const coLower = companyName.toLowerCase().trim();
    if (companyLeadMap.has(coLower)) return companyLeadMap.get(coLower)!;
    for (const [key, lead] of companyLeadMap.entries()) {
      if (key.includes(coLower) || coLower.includes(key)) return lead;
    }
    return null;
  }

  let briefCount = 0;

  for (const event of pendingMeetings) {
    if (overDeadline()) { console.log(`Deadline at ${Math.round(elapsed()/1000)}s`); break; }

    const time = new Date(new Date(event.event_start).getTime() + sgtOffsetMs).toISOString().slice(11, 16);
    const external = (event.attendees ?? []).filter(a => {
      if (a.self) return false;
      const domain = (a.email.split("@")[1] ?? "").toLowerCase();
      return !NOISE_DOMAINS.has(domain);
    });
    const externalEmails = external.map(a => a.email);

    let company = extractCompanyFromTitle(event.title);
    let lead: Record<string, unknown> | null = company ? findLead(company) : null;

    if (!lead) {
      for (const attendee of external) {
        const domain = (attendee.email.split("@")[1] ?? "").toLowerCase();
        const co = extractCompanyFromDomain(domain);
        const match = findLead(co);
        if (match) { company = co; lead = match; break; }
        if (!company) company = co;
      }
    }
    if (!company && external[0]) {
      company = extractCompanyFromDomain((external[0].email.split("@")[1] ?? "").toLowerCase());
    }

    console.log(`Meeting: "${event.title}" @ ${time} -> company="${company}" lead=${lead ? String(lead.name) : "none"}`);

    const [newsResults, announcementResults] = await Promise.all([
      searchSerper(`"${company}" ${SEARCH_TOPIC_SIGNALS} 2026`, 7),
      searchSerper(`"${company}" ${SEARCH_TOPIC_SIGNALS} partnership deal announcement launch`, 30),
    ]);

    const newsUrls = new Set(newsResults.map(r => r.url));
    const freshAnnouncements = announcementResults.filter(r => !newsUrls.has(r.url));

    const newsBlock = newsResults.slice(0, 4).map(r => `- ${r.title}\n  ${r.content.slice(0, 200)}`).join("\n\n");
    const announcementBlock = freshAnnouncements.slice(0, 4).map(r => `- ${r.title}\n  ${r.content.slice(0, 200)}`).join("\n\n");

    const daResearch   = lead?.da_research       ? String(lead.da_research)       : "";
    const productCases = lead?.product_use_cases ? String(lead.product_use_cases) : lead?.ethera_use_cases ? String(lead.ethera_use_cases) : "";
    const leadName     = lead?.name              ? String(lead.name)              : "";
    const leadPosition = lead?.position         ? String(lead.position)         : "";
    const leadEmail    = lead?.email            ? String(lead.email)            : "";

    const prompt = `You are a senior BD strategist (${PRODUCT_CONTEXT}).

${SENDER_IDENTITY ? `Prepare a tight pre-call intelligence brief for ${SENDER_IDENTITY} before this meeting.` : "Prepare a tight pre-call intelligence brief before this meeting."}

MEETING: ${event.title}
TIME: ${time} SGT
COMPANY: ${company}${leadName ? `\nCONTACT: ${leadName}${leadPosition ? ` — ${leadPosition}` : ""}${leadEmail && leadEmail !== "pending" ? ` (${leadEmail})` : ""}` : ""}
EXTERNAL ATTENDEES: ${externalEmails.join(", ")}

${daResearch ? `COMPANY RESEARCH (Agent 1.5):\n${daResearch.slice(0, 2000)}` : `(No prior board research — rely on your knowledge of ${company})`}
${productCases ? `\nIDENTIFIED ${PRODUCT_NAME ? PRODUCT_NAME.toUpperCase() : "PRODUCT"} USE CASES:\n${productCases}` : ""}
${newsBlock ? `\nFRESH NEWS (last 7 days):\n${newsBlock}` : "(No fresh news found)"}
${announcementBlock ? `\nRECENT ANNOUNCEMENTS & PARTNERSHIPS (last 30 days):\n${announcementBlock}` : "(No recent announcements found)"}

Write a pre-call brief using these exact section headers on their own lines (no colons, no bold):

Context
One sentence: where is ${company} on this topic right now and what is the key moment they are in.

Recent Announcements
2-3 bullet points of the most significant deals, partnerships, or launches from the last 30 days. Include non-blockchain announcements if they reveal strategic direction. If nothing material in the data, write "(none found in the last 30 days)". Be specific: name the partner, the technology, the scope.

Talking Points
3 numbered points ${SENDER_NAME || "the sender"} can use to open the conversation. Each tied to a specific initiative or signal from the research or recent announcements. Most relevant to ${PRODUCT_NAME || "the product"} first. No em dashes.

Competitive Angle
Who else are they likely talking to? State the strongest ${PRODUCT_NAME || "product"} differentiator to emphasise with this company specifically.

Recommended Ask
One specific, concrete thing to push for at the end of this call (not generic like "schedule a follow-up" — name what, with whom, by when).

Questions to Ask
2-3 discovery questions that will reveal whether this is a real opportunity and which ${PRODUCT_NAME || "product"} capability fits best.

No em dashes. Plain text only. Under 1500 chars total.`;

    let brief = "";
    try {
      const res = await brains.llm({messages:[{role:"user",content:prompt}], max_tokens:750});
      const r = res as Record<string, unknown>;
      brief = String(r?.text ?? (r?.content as {text?:string}[])?.[0]?.text ?? "").trim();
    } catch (e) {
      console.log(`  LLM error: ${String(e).slice(0, 60)}`);
      brief = "(LLM unavailable — review board research manually)";
    }

    const line = "-".repeat(32);
    const contactLine = leadName
      ? `Contact: ${leadName}${leadPosition ? ` — ${leadPosition}` : ""}`
      : `Attendees: ${externalEmails.slice(0, 3).join(", ")}`;
    const researchTag = daResearch ? " [researched]" : " [no prior research]";
    const testTag = TEST_MODE ? " [TEST]" : "";

    const msg = [
      `Meeting Intel ${VERSION}${testTag} | ${time} SGT`,
      event.title,
      line,
      `Company: ${company}${researchTag}`,
      contactLine,
      "",
      brief,
    ].join("\n");

    await safePush(msg);
    briefCount++;

    if (!TEST_MODE) {
      briefedIds.push(event.meetingKey);
      if (briefedRowId) {
        try {
          await brains.update_board_row({
            board_id: BOARD_ID, dataset: "meta", row_id: briefedRowId,
            patch: { value: JSON.stringify(briefedIds) }
          });
        } catch (e) { console.log(`  briefed update err: ${String(e).slice(0, 60)}`); }
      } else {
        try {
          await brains.append_board_rows({
            board_id: BOARD_ID, dataset: "meta",
            rows: [{ key: briefedKey, value: JSON.stringify(briefedIds) }]
          });
          const mb2 = await brains.boards.get(BOARD_ID, {dataset:"meta", limit:200});
          const mrows2 = (
            (mb2 as Record<string, unknown>)?.datasets as Record<string, {rows?: Record<string, unknown>[]}> | undefined
          )?.meta?.rows ?? [] as Record<string, unknown>[];
          const newRow = (mrows2 as Record<string, unknown>[]).find(r => String(r.key ?? "") === briefedKey);
          if (newRow) briefedRowId = String(newRow.row_id ?? "");
        } catch (e) { console.log(`  briefed append err: ${String(e).slice(0, 60)}`); }
      }
    }

    console.log(`  Pushed for "${event.title}" | news=${newsResults.length} annc=${freshAnnouncements.length} | ${Math.round(elapsed()/1000)}s`);
  }

  console.log(`Meeting Intel ${VERSION} done: ${briefCount} brief(s)`);
}

await main();
