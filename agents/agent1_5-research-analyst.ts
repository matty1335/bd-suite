// ============================================================
// RESEARCH ANALYST v12
//
// v10: Multi-tenant generalization.
//   - PRODUCT_CONTEXT (was ETHERA_CONTEXT) defaults to "" -- populated from campaign
//     product_description + value_prop. Research prompts anchor to this automatically.
//   - PRODUCT_NAME extracted from campaign sender_title (e.g. "CCO at Acme" -> "Acme").
//     Used in section headers, Telegram messages, and prompts.
//   - needsResearch(): removed Ethera-specific quality gate
//     (sovereign|permissioned chain|besu). Now checks content quality only.
//   - Research prompt: section heading uses PRODUCT_NAME dynamically
//     ("Relevance to Acme", "Acme Use Cases" etc). extractSection() uses
//     the same heading + backward-compat fallback for old "Relevance to Ethera" entries.
//   - Board write: also writes product_use_cases alongside ethera_use_cases for
//     backward compat with reader agents.
//
// v9 fix (2026-07-28): Remove version-check re-queue trigger.
//     needsResearch() uses content quality only (hasEtheraContext check removed here).
//     FORMAT RULE added to both prompts to suppress LLM meta-commentary.
//
// v9: Campaign-awareness. Read active campaign config from Control Centre board
//     at startup. RESEARCH_TOPIC_SIGNALS from campaign. PRODUCT_CONTEXT from
//     campaign.product_description + value_prop.
// ============================================================

let BOARD_ID      = "95dcb668-e2d9-4093-9a3e-3200901846fa";
const _ccSecret   = "{{cc_board_id}}";
const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
const VERSION     = "v10";
const DEADLINE_MS = 220_000;

// Populated from campaign config at startup
let PRODUCT_CONTEXT = "";   // product description for research anchoring
let PRODUCT_NAME = "";      // short name extracted from sender_title (e.g. "Acme")

let RESEARCH_TOPIC_SIGNALS = [
  "digital asset", "blockchain", "tokenization", "tokenisation", "stablecoin", "CBDC", "RWA",
];

async function searchSerper(query: string, maxResults: number = 5): Promise<{title:string;url:string;content:string}[]> {
  try {
    const r = await brains.http_fetch({
      url: "https://google.serper.dev/search",
      method: "POST",
      headers: {"Content-Type":"application/json","X-API-KEY":"{{serper_api_key}}"},
      body: JSON.stringify({q: query, num: maxResults})
    });
    if (!r.ok) return [];
    const data = r.json as {organic?: {title:string;link:string;snippet:string}[]};
    return (data.organic ?? []).map(item => ({title: item.title, url: item.link, content: item.snippet}));
  } catch { return []; }
}

async function researchCompany(
  company: string,
  name: string,
  position: string
): Promise<{daSummary: string; productCases: string}> {

  const topicAnchor = RESEARCH_TOPIC_SIGNALS.slice(0, 5).join(" OR ");
  const queries = [
    `"${company}" ${topicAnchor} strategy 2025 2026`,
    `"${company}" ${topicAnchor} settlement partnerships`,
    `"${company}" fintech acquisition launch pilot ${topicAnchor} infrastructure`,
    `"${company}" institutional custody compliance ${topicAnchor}`,
  ];

  const seenUrls = new Set<string>();
  const results: {title:string;url:string;content:string}[] = [];

  for (const q of queries) {
    for (const item of await searchSerper(q, 5)) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        results.push(item);
      }
    }
  }

  const sourcesBlock = results
    .slice(0, 20)
    .map(r => `=== ${r.title}\nURL: ${r.url}\n${r.content}`)
    .join("\n\n---\n\n");

  // Build context block from PRODUCT_CONTEXT
  const productCtxSection = PRODUCT_CONTEXT
    ? `\nABOUT THE PRODUCT BEING SOLD:\n${PRODUCT_CONTEXT}\n`
    : "";

  // Dynamic section heading for relevance
  const relevanceHeading = PRODUCT_NAME ? `Relevance to ${PRODUCT_NAME}` : "Relevance";
  const productRef = PRODUCT_NAME || "this product";

  let daSummary = "";
  try {
    const researchPrompt = `You are an expert financial technology research analyst producing a strategic intelligence brief for an institutional sales team.${productCtxSection}

SUBJECT COMPANY: ${company}
CONTACT: ${name}, ${position}

Draw on BOTH your existing knowledge about ${company} AND the following recent web search results. Your knowledge is the foundation -- the search results add confirmed recent deals, partnerships, and product launches. Integrate both seamlessly. Do not say "based on the sources" or "according to search results" -- write as a unified authoritative brief.

${sourcesBlock ? `RECENT SEARCH RESULTS:\n${sourcesBlock}` : `(No search results returned -- rely on your knowledge of ${company}.)`}

Write a comprehensive strategic research brief using this structure. Be specific -- include named deals, amounts, dates, partner names, technology choices:

## Strategic Thesis
2-3 sentences on their overall bet in digital assets and what problem they are trying to own.

## Key Initiatives
Number each major initiative. For each: name it, what it does, named partners or technology stack, current stage (announced / pilot / live / scaled). Include specific figures and dates where available.

## Notable Partnerships & Technology Choices
Specific firms, chains, and platforms they have committed to, and why it matters strategically.

## Maturity Assessment
Where are they on the adoption curve? What signals point to next moves?

## ${relevanceHeading}
Given ${name}'s role as ${position} and ${company}'s direction, what is the specific opening for ${productRef}? Be concrete about which of ${company}'s current initiatives or gaps ${productRef} addresses -- reference specific named initiatives above.

## Sources
List URLs used from search results.

FORMAT RULE: Do NOT include any meta-commentary, preambles, caveats, disclaimers, or warnings anywhere in the output -- no "First, the honest caveat", "Before the brief", "Note:", "Flag:", or similar. Start directly with ## Strategic Thesis and follow the structure exactly.`;

    const resp = await brains.llm({messages:[{role:"user",content:researchPrompt}], max_tokens:3000, model:"claude-opus-4-8"});
    const r = resp as Record<string, unknown>;
    daSummary = String(r?.text ?? (r?.content as {text?:string}[])?.[0]?.text ?? "").trim();
  } catch {}

  if (!daSummary) return {daSummary: "", productCases: ""};

  let productCases = "";
  try {
    const productCtxLine = PRODUCT_CONTEXT ? `\nPRODUCT:\n${PRODUCT_CONTEXT}\n` : "";
    const assessPrompt = `You are a senior sales strategist.${productCtxLine}

PROSPECT: ${name} -- ${position} at ${company}

RESEARCH BRIEF ON ${company.toUpperCase()}:
${daSummary}

Based on this brief, identify 2-3 concrete use cases for ${productRef} at ${company}. For each: name the use case, tie it directly to a specific initiative or gap in their current direction, and state what ${productRef} enables that they cannot get from their current stack. Reference specific named initiatives from the brief. Max 200 words.

FORMAT RULE: Do NOT begin with any preamble, warning, disclaimer, or meta-commentary. Start directly with the first use case.`;

    const resp = await brains.llm({messages:[{role:"user",content:assessPrompt}], max_tokens:2000, model:"claude-opus-4-8"});
    const r = resp as Record<string, unknown>;
    productCases = String(r?.text ?? (r?.content as {text?:string}[])?.[0]?.text ?? "").trim();
  } catch {}

  return {daSummary, productCases};
}

function extractSection(text: string, heading: string): string {
  const re = new RegExp(`## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

async function safePush(text: string) {
  try { await brains.telegram_push({text: text.slice(0, 4096)}); } catch {}
}

async function main() {
  const startTime = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const nowMs = Date.now();
  function elapsed() { return Date.now() - startTime; }
  function overDeadline() { return elapsed() > DEADLINE_MS; }

  // Campaign config -- read from Control Centre board, fallback to empty defaults
  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, {dataset:"meta", limit:10});
    const ccRows = ((ccBoard?.datasets?.meta?.rows ?? ccBoard?.data?.datasets?.meta?.rows ?? []) as Record<string, unknown>[]);
    if (!_ccSecret.startsWith("{{")) {
      const setupRow = ccRows.find((r: Record<string, unknown>) => r.key === "cc_setup");
      if (setupRow) {
        try {
          const setup = JSON.parse(String(setupRow.value ?? "{}")) as Record<string, unknown>;
          if (setup.prospector_id) BOARD_ID = String(setup.prospector_id);
          // Extract PRODUCT_NAME from sender_title as fallback
          if (setup.sender_title) {
            const pn = String(setup.sender_title).split(",")[1]?.trim();
            if (pn) PRODUCT_NAME = pn;
          }
        } catch {}
      }
    }
    const configRow = ccRows.find((r: Record<string, unknown>) => r.key === "agent_config");
    if (configRow) {
      const config = JSON.parse(String(configRow.value ?? "{}")) as Record<string, unknown>;
      const campaigns = (config.campaigns as {id:string;topic_signals?:string[];product_description?:string;value_prop?:string;sender_title?:string;prospector_board_id?:string}[] ?? []);
      const activeCampaignId = String(config.active_campaign_id ?? "");
      const campaign = campaigns.find(c => c.id === activeCampaignId) ?? null;
      if (campaign) {
        if ((campaign.prospector_board_id ?? "").length > 0) BOARD_ID = String(campaign.prospector_board_id);
        if ((campaign.topic_signals ?? []).length > 0) RESEARCH_TOPIC_SIGNALS = campaign.topic_signals as string[];
        if ((campaign.product_description ?? "").length > 0) {
          PRODUCT_CONTEXT = campaign.product_description as string;
          if ((campaign.value_prop ?? "").length > 0) PRODUCT_CONTEXT += "\n\nValue proposition: " + campaign.value_prop;
        }
        // Extract PRODUCT_NAME from campaign sender_title (e.g. "CCO, Ethera" -> "Ethera")
        if (campaign.sender_title) {
          const pn = String(campaign.sender_title).split(",")[1]?.trim();
          if (pn) PRODUCT_NAME = pn;
        }
        console.log(`Campaign: ${campaign.id} loaded (${RESEARCH_TOPIC_SIGNALS.length} signals, PRODUCT=${PRODUCT_NAME || '(none)'})`);
      } else {
        console.log("Campaign config: no active campaign -- using generic defaults");
      }
    }
  } catch (e) { console.log(`Campaign config: ${String(e).slice(0, 80)} -- using generic defaults`); }

  const relevanceHeading = PRODUCT_NAME ? `Relevance to ${PRODUCT_NAME}` : "Relevance";

  function needsResearch(l: Record<string, unknown>): boolean {
    if (!String(l.company ?? "").trim()) return false;
    if (!l.da_research) return true;
    const da = String(l.da_research ?? "");
    const hasBadContent = /no information about|cannot responsibly fabricate|framework for how to construct/i.test(da);
    if (hasBadContent) return true;
    return false;
  }

  // 1. Load board leads
  const boardLeads: Record<string, unknown>[] = [];
  let boardOffset = 0;
  while (true) {
    const board = await brains.boards.get(BOARD_ID, {dataset:"leads", offset:boardOffset, limit:1000});
    const rows = (board?.datasets?.leads?.rows ?? board?.data?.datasets?.leads?.rows ?? []) as Record<string, unknown>[];
    boardLeads.push(...rows);
    if (rows.length < 1000) break;
    boardOffset += rows.length;
    if (boardOffset > 10000) break;
  }

  const boardQueue = boardLeads.filter(l => !l._deleted_at && needsResearch(l));
  console.log(`Board queue: ${boardQueue.length} leads need research`);

  // 2. Build prioritised queue
  const sevenDaysMs = 7 * 24 * 3600 * 1000;

  type QueueItem = {
    row_id: string;
    company: string;
    name: string;
    position: string;
    priority: number;
    createdAt: string;
  };

  const queue: QueueItem[] = [];

  for (const l of boardQueue) {
    const company = String(l.company ?? "").trim();
    const createdAt = String(l.createdAt ?? "");
    const followUp = String(l.follow_up_due_at ?? "");
    let priority = 3;
    if (createdAt.startsWith(today)) priority = 1;
    else if (followUp && (new Date(followUp).getTime() - nowMs) < sevenDaysMs && (new Date(followUp).getTime() - nowMs) > 0) priority = 2;
    queue.push({row_id: String(l.row_id ?? ""), company, name: String(l.name ?? ""), position: String(l.position ?? ""), priority, createdAt});
  }

  queue.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const totalInQueue = queue.length;
  console.log(`Total queue: ${totalInQueue} | elapsed: ${Math.round(elapsed()/1000)}s`);

  if (totalInQueue === 0) {
    console.log("Queue empty -- silent exit.");
    return;
  }

  await safePush(`Research Analyst ${VERSION} started - ${totalInQueue} in queue${PRODUCT_NAME ? ` (${PRODUCT_NAME})` : ''}`);

  // 3. Research loop
  type ResearchResult = {daSummary: string; productCases: string; researchedAt: string};
  const companyCache = new Map<string, ResearchResult>();
  let boardEnriched = 0;
  const enrichedCompanies: string[] = [];

  for (const item of queue) {
    if (overDeadline()) { console.log(`Deadline hit at ${Math.round(elapsed()/1000)}s -- stopping`); break; }

    const companyKey = item.company.toLowerCase().trim();

    // Already researched this run -- write cached result to this board row
    if (companyCache.has(companyKey)) {
      if (item.row_id) {
        const cached = companyCache.get(companyKey)!;
        try {
          await brains.update_board_row({
            board_id: BOARD_ID,
            row_id: item.row_id,
            dataset: "leads",
            patch: {
              da_research: cached.daSummary,
              product_use_cases: cached.productCases,
              ethera_use_cases: cached.productCases,
              research_updated_at: cached.researchedAt,
              research_source: VERSION
            }
          });
          boardEnriched++;
          console.log(`  Board updated (cached): ${item.name} @ ${item.company}`);
        } catch (e) { console.log(`  Board write error (cached): ${String(e).slice(0, 60)}`); }
      }
      continue;
    }

    console.log(`Researching: ${item.company} | ${item.name} | elapsed: ${Math.round(elapsed()/1000)}s`);
    const {daSummary, productCases} = await researchCompany(item.company, item.name, item.position);

    if (!daSummary) {
      console.log(`  No brief generated for ${item.company}`);
      continue;
    }

    const researchedAt = new Date().toISOString();
    companyCache.set(companyKey, {daSummary, productCases, researchedAt});

    // Telegram: 3 messages per company
    const thesis = extractSection(daSummary, "Strategic Thesis");
    // Backward-compat: try dynamic heading first, then old "Relevance to Ethera"
    const relevance = extractSection(daSummary, relevanceHeading) || extractSection(daSummary, "Relevance to Ethera");
    const header = `Research: ${item.company}\nContact: ${item.name} - ${item.position}`;

    await safePush(`${header}\n\nStrategic Thesis\n${thesis || "(see board)"}`);
    if (relevance) await safePush(`${relevanceHeading} - ${item.company}\n${relevance}`);
    if (productCases) await safePush(`${PRODUCT_NAME ? PRODUCT_NAME + ' ' : ''}Use Cases - ${item.company}\n${productCases}`);

    // Write to board row
    if (item.row_id) {
      try {
        await brains.update_board_row({
          board_id: BOARD_ID,
          row_id: item.row_id,
          dataset: "leads",
          patch: {
            da_research: daSummary,
            product_use_cases: productCases,
            ethera_use_cases: productCases,
            research_updated_at: researchedAt,
            research_source: VERSION
          }
        });
        boardEnriched++;
        console.log(`  Board updated: ${item.name} @ ${item.company}`);
      } catch (e) { console.log(`  Board write error: ${String(e).slice(0, 60)}`); }
    }

    enrichedCompanies.push(item.company);
  }

  // 4. End summary
  const runtimeSec = Math.round(elapsed() / 1000);
  const companyList = enrichedCompanies.slice(0, 15).join(", ");
  const more = enrichedCompanies.length > 15 ? ` +${enrichedCompanies.length - 15} more` : "";

  await safePush([
    `Research Analyst ${VERSION} done - ${today}`,
    ``,
    `Board: ${boardEnriched} enriched`,
    `Runtime: ${runtimeSec}s | ${totalInQueue - enrichedCompanies.length} remaining in queue`,
    enrichedCompanies.length > 0 ? `Companies: ${companyList}${more}` : `Companies: none enriched`,
  ].join("\n"));
}

await main();
