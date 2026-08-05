// ============================================================
// Agent 1: Ethera Prospector
// Brains automation ID: e535386e-50f7-4211-9528-c21c9769f9f4
// Version: 194 -- campaign-generic LLM prompts (Option B + main extraction)
// Cron: 0 2 * * * UTC (2AM nightly)
// Description: Nightly Sales Intelligence Analyst -- searches Apollo for Digital Assets decision-makers at 30 target TradFi/crypto companies, dedupes against existing CRM, appends new Viable leads to brains board + ethera-labs/crm git repo, pings Telegram with summary.
// ============================================================
// ============================================================
// ETHERA PROSPECTOR v178 -- Campaign-Aware
//
// v178: Read discovery_queries, topic_signals, institution_signals, target_titles
//       from active campaign in Control Centre board (2907a47b) at startup.
//       All 5 hardcoded arrays (QUERIES_NEWSAPI, QUERIES_TAVILY, BLOCKCHAIN_TERMS,
//       FI_TERMS, DA_TITLES) fall back to hardcoded defaults if campaign is missing
//       or any field is empty. Zero quality regression risk.
//
// v177: Add Firecrawl for reliable content extraction.
//       - JS-rendered domains (CoinDesk, TheBlock, etc.) now fetched via Firecrawl
//         instead of raw http_fetch that returns empty JS shells.
//       - Option A source link fetching now uses Firecrawl -- fixes swift.com blocking
//         raw HTTP so press-release names are captured.
//       - URL scanning extended to Firecrawl markdown (not just rawHtml hrefs),
//         so institutional links are found even from JS-rendered articles.
//       firecrawl_api_key secret already in vault; api.firecrawl.dev added to hosts.
// v176: Fix false-positive leads -- require non-empty company + add geographic
//       terms to INVALID_NAME_WORDS (prevents "New Hampshire" type false positives).
//       Option B now runs on ALL signal/partner articles (not just 0-extract fallback),
//       searching Apollo for companies not already covered by the main LLM extraction.
// v175: Option A (source link following) + Option B (company->contact Apollo pipeline).
// v174: Tavily batched in groups of 3 (fixes rate limit 11err in v173).
// v173: Parallelize Tavily + institutional RSS.
// v172: Add all 11 NewsAPI keyword queries to Tavily.
// v171: Remove wrong Besu assumption from Tavily queries.
// v170: Add Tavily + institutional RSS + 72h NewsAPI window.
// ============================================================

let BLOCKCHAIN_TERMS = [
  "blockchain","tokeniz","tokenis","digital asset","stablecoin","defi",
  "distributed ledger","smart contract","on-chain","rwa","real-world asset",
  "cbdc","crypto","digital bond","digital security","token issuance",
  "atomic settlement","programmable money","institutional defi",
  "openusd","open usd","usd interoperability"
];
let FI_TERMS = [
  "bank","asset management","hedge fund","custodian","clearing","exchange",
  "securities","capital markets","fintech","investment","financial institution",
  "jpmorgan","goldman sachs","blackrock","citigroup","citi","hsbc","bny mellon",
  "state street","northern trust","franklin templeton","fidelity","vanguard",
  "deutsche bank","ubs","morgan stanley","barclays","bnp paribas","societe generale",
  "credit agricole","ing group","santander","cme group","dtcc","euroclear",
  "clearstream","coinbase","circle","paxos","fireblocks","anchorage","revolut","stripe",
  "visa","mastercard","swift","depository","settlement","treasury","payments"
];

const PROFILE_PATTERNS: RegExp[] = [
  /^who is ([A-Z][a-zÀ-ÿ\-']+ (?:[A-Z][a-zÀ-ÿ\-']+ ){0,2}[A-Z][a-zÀ-ÿ\-']+)/i,
  /^meet ([A-Z][a-zÀ-ÿ\-']+ (?:[A-Z][a-zÀ-ÿ\-']+ ){0,2}[A-Z][a-zÀ-ÿ\-']+)/i,
  /^([A-Z][a-zÀ-ÿ\-']+ (?:[A-Z][a-zÀ-ÿ\-']+ ){0,2}[A-Z][a-zÀ-ÿ\-']+)[,:]? (?:joins|named|appointed|tapped|to lead|becomes|takes over as|promoted to|is joining|has joined)/i,
  /^([A-Z][a-zÀ-ÿ\-']+ (?:[A-Z][a-zÀ-ÿ\-']+ ){0,2}[A-Z][a-zÀ-ÿ\-']+) (?:is|was) (?:named|appointed|hired|promoted)/i,
  /\bwho is ([A-Z][a-zÀ-ÿ\-']+ (?:[A-Z][a-zÀ-ÿ\-']+ ){0,2}[A-Z][a-zÀ-ÿ\-']+)\b/i,
];

const INVALID_NAME_WORDS = new Set([
  "world","cup","wall","street","main","federal","reserve","central",
  "bitcoin","ethereum","group","corp","inc","ltd","fund","market",
  "exchange","blockchain","token","nft","defi","web3","capital","asset",
  "global","digital","quarter","summit","conference","consortium","coalition",
  "network","platform","protocol","committee","alliance","report","index",
  // Geographic entities (prevent state/country/city names being extracted as people)
  "hampshire","carolina","island","dakota","mexico","angeles","francisco",
  "california","texas","florida","illinois","ohio","georgia","michigan",
  "pennsylvania","indiana","tennessee","missouri","maryland","wisconsin",
  "colorado","minnesota","louisiana","alabama","kentucky","oregon","oklahoma",
  "connecticut","utah","iowa","nevada","arkansas","mississippi","kansas",
  "nebraska","idaho","hawaii","maine","montana","wyoming","alaska","vermont",
  "city","county","region","district","province","territory","republic","kingdom",
  "state","states","government","ministry","department","authority","agency"
]);

// Institutional domains to follow for full press release text
const INST_LINK_DOMAINS = [
  "swift.com","bis.org","prnewswire.com","businesswire.com","globenewswire.com",
  "imf.org","fsb.org","ecb.europa.eu","mas.gov.sg","hkma.gov.hk",
  "federalreserve.gov","sec.gov",
];

// Apollo titles for digital asset executives
let DA_TITLES = [
  "Head of Digital Assets","Managing Director Digital Assets","MD Digital Assets",
  "Head of Tokenization","Head of Blockchain","Chief Digital Officer",
  "Head of Innovation","Digital Assets Director","Head of Digital Innovation",
  "VP Digital Assets","Head of Crypto","Head of DeFi","Head of Web3",
  "Head of Transaction Banking","Chief Blockchain Officer",
];

// JS-rendered domains that return empty shells on raw http_fetch -- use Firecrawl
const JS_DOMAINS = new Set([
  "coindesk.com","theblock.co","cointelegraph.com","blockworks.co","decrypt.co"
]);

function isValidHumanName(name: string): boolean {
  if (!name || name.length < 5 || name.length > 55) return false;
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 5) return false;
  if (parts.some(p => INVALID_NAME_WORDS.has(p.toLowerCase()))) return false;
  if (parts.some(p => /^\d/.test(p))) return false;
  return true;
}

function extractNameFromHeadline(title: string): string | null {
  for (const pattern of PROFILE_PATTERNS) {
    const m = title.match(pattern);
    if (m?.[1] && isValidHumanName(m[1])) return m[1];
  }
  return null;
}

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function isRelevantArticle(title: string, desc: string): boolean {
  const text = `${title} ${desc}`.toLowerCase();
  return BLOCKCHAIN_TERMS.some(t => text.includes(t)) && FI_TERMS.some(t => text.includes(t));
}

function extractJsonArray(text: string): unknown[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : []; } catch { return []; }
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]{1,200}>/g, " ")
    .replace(/&[a-z]{2,8};/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyArticle(title: string, desc: string): "signal" | "news" | "partner" | "appt" {
  const text = `${title} ${desc}`.toLowerCase();
  if (/appoint|hire|join|named|promot|head of|exec|director|chief|officer|lead|new role|takes over/.test(text)) return "signal";
  if (/partner|collaborat|alliance|integrat|join forces|mou|agreement|deal/.test(text)) return "partner";
  if (/consortium|launch|announce|introduc|initiative|pilot|program|unveil|backed by|supported by|led by|co-found/.test(text)) return "signal";
  if (/summit|conference|speak|panel|forum|event|webinar|roundtable/.test(text)) return "appt";
  return "news";
}

const CONTENT_DOMAINS = new Set([
  "coindesk.com","theblock.co","cointelegraph.com","blockworks.co",
  "reuters.com","decrypt.co","ledgerinsights.com","dlnews.com",
  "cryptobriefing.com","financemagnates.com","coingape.com","thedigitalbanker.com",
  "thedefiant.io",
  "swift.com","bis.org","imf.org","fsb.org","ecb.europa.eu",
  "mas.gov.sg","hkma.gov.hk","federalreserve.gov","sec.gov",
  "prnewswire.com","www.prnewswire.com","businesswire.com","www.businesswire.com",
  "globenewswire.com","www.globenewswire.com",
]);

let QUERIES_NEWSAPI = [
  '"tokenization" OR "tokenisation" bank executive appointment hire',
  '"digital assets" "head of" OR "managing director" bank joins OR named OR appointed',
  '"blockchain" fintech executive "new role" OR joins OR hire',
  '"digital assets" OR "tokenization" OR "stablecoin" bank consortium launch initiative pilot',
  '"stablecoin" OR "CBDC" OR "digital dollar" institutional bank launch announcement',
  '"real world assets" OR "RWA" institutional launch partnership',
  '"tokenized" OR "tokenised" financial institution partner OR integrate OR agreement OR mou',
  '"blockchain" OR "distributed ledger" bank OR "asset manager" OR custodian announcement',
  '"digital asset" standard regulation framework institutional fintech',
  '"on-chain" OR "onchain" institutional bank OR "hedge fund" OR "asset manager" launch OR pilot',
  '"Open USD" OR "OpenUSD" OR "usd interoperability" institutional blockchain stablecoin bank',
];
let QUERIES_SERPER = [
  "tokenization tokenisation bank executive appointment hire 2026",
  "digital assets head of managing director bank joins named appointed 2026",
  "blockchain fintech executive new role joins hire 2026",
  "digital assets tokenization stablecoin bank consortium launch initiative pilot 2026",
  "stablecoin CBDC digital dollar institutional bank launch announcement 2026",
  "real world assets RWA institutional launch partnership 2026",
  "tokenized tokenised financial institution partner integrate agreement MOU 2026",
  "blockchain distributed ledger bank asset manager custodian announcement 2026",
  "digital asset standard regulation framework institutional fintech 2026",
  "on-chain onchain institutional bank hedge fund asset manager launch pilot 2026",
  "Open USD OpenUSD USD interoperability institutional blockchain stablecoin bank 2026",
];

async function batchedParallel<T>(
  items: T[], batchSize: number, fn: (item: T) => Promise<unknown>
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

let SNOV_TOKEN = "";
async function findEmail(name: string, company: string): Promise<{email: string; src: string; verified: boolean}> {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ");
  const co = company.toLowerCase()
    .replace(/\b(?:inc|llc|ltd|corp|group|bank|financial|capital|management|co\.?)$/gi, "")
    .trim().replace(/[^a-z0-9]/g, "");

  if (co) {
    try {
      const r = await brains.http_fetch({ url: `https://api.hunter.io/v2/email-finder?api_key={{hunter_api_key}}&domain=${co}.com&first_name=${encodeURIComponent(firstName)}&last_name=${encodeURIComponent(lastName)}`, method: "GET" });
      if (r.ok) { const d = r.json as {data?:{email?:string;score?:number}}; if (d.data?.email && (d.data.score ?? 0) >= 60) return {email: d.data.email, src: "hunter", verified: (d.data.score ?? 0) >= 90}; }
    } catch {}
  }
  try {
    const r = await brains.http_fetch({ url: "https://api.apollo.io/api/v1/people/match", method: "POST", headers: {"Content-Type":"application/json","Cache-Control":"no-cache"}, body: JSON.stringify({api_key:"{{apollo_api_key}}",first_name:firstName,last_name:lastName,organization_name:company,reveal_personal_emails:false}) });
    if (r.ok) { const d = r.json as {person?:{email?:string;email_status?:string}}; if (d.person?.email && d.person.email_status !== "invalid") return {email: d.person.email, src: "apollo", verified: d.person.email_status === "verified"}; }
  } catch {}
  if (co) {
    try {
      const r = await brains.http_fetch({ url: "https://app.findymail.com/api/find", method: "POST", headers: {"Authorization":`Bearer {{findymail_api_key}}`,"Content-Type":"application/json"}, body: JSON.stringify({name, domain:`${co}.com`}) });
      if (r.ok) { const d = r.json as {email?:string}; if (d.email) return {email: d.email, src: "findymail", verified: false}; }
    } catch {}
  }
  try {
    const r = await brains.http_fetch({ url: `https://gateway.datagma.net/api/ingress/v2/findEmail?apiId={{datagma_api_key}}&fullName=${encodeURIComponent(name)}&company=${encodeURIComponent(company)}`, method: "GET" });
    if (r.ok) { const d = r.json as {email?:string}; if (d.email) return {email: d.email, src: "datagma", verified: false}; }
  } catch {}
  if (co) {
    try {
      const r = await brains.http_fetch({ url: "https://api.prospeo.io/email-finder", method: "POST", headers: {"Content-Type":"application/json","X-KEY":"{{prospeo_api_key}}"}, body: JSON.stringify({first_name:firstName,last_name:lastName,domain:`${co}.com`}) });
      if (r.ok) { const d = r.json as {response?:{email?:string;confidence?:string}}; if (d.response?.email) return {email: d.response.email, src: "prospeo", verified: d.response.confidence === "VERIFIED"}; }
    } catch {}
  }
  if (co && SNOV_TOKEN) {
    try {
      const r = await brains.http_fetch({ url: "https://api.snov.io/v1/get-emails-from-name", method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({access_token:SNOV_TOKEN,firstName,lastName,domain:`${co}.com`}) });
      if (r.ok) {
        const d = r.json as {success?:boolean;data?:{email?:string;emailStatus?:string}[]};
        if (d.success && d.data && d.data.length > 0) {
          const verified = d.data.find(e => e.email && e.emailStatus === "verified");
          const pick = verified ?? d.data[0];
          if (pick?.email) return {email: pick.email, src: "snov", verified: pick.emailStatus === "verified"};
        }
      }
    } catch {}
  }
  return {email: "", src: "none", verified: false};
}

async function fetchInstRSS(url: string, name: string): Promise<{title:string;description:string;url:string;source:string}[]> {
  try {
    const r = await brains.http_fetch({url,method:"GET",headers:{"User-Agent":"Mozilla/5.0 (compatible; BDSuiteBot/1.0)","Accept":"application/rss+xml, application/xml, text/xml, */*"}});
    if (!r.ok) return [];
    const xml = String(r.text ?? "");
    const items: {title:string;description:string;url:string;source:string}[] = [];
    for (const m of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20)) {
      const block = m[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ?? block.match(/<title>([^<]*)<\/title>/))?.[1]?.trim() ?? "";
      const rawDesc = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ?? block.match(/<description>([\s\S]*?)<\/description>/))?.[1] ?? "";
      const desc = rawDesc.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,400);
      const link = (block.match(/<link>([^<]+)<\/link>/) ?? block.match(/<guid[^>]*>([^<]+)<\/guid>/))?.[1]?.trim() ?? "";
      if (title && link) items.push({title,description:desc,url:link,source:name});
    }
    return items;
  } catch { return []; }
}

async function main() {
  const startTime = Date.now();
  const DEADLINE_MS = 255_000;
  let BOARD_ID        = "95dcb668-e2d9-4093-9a3e-3200901846fa";
  let CRM_BOARD_ID    = "1de2a9f5-03cd-427e-9bb4-9198ed336f62";
  let OWNER_ID        = "";
  const VERSION       = "v194";
  const today         = new Date().toISOString().slice(0, 10);

  // Campaign config -- read from Control Centre board, fallback to hardcoded defaults
  const _ccSecret   = "{{cc_board_id}}";
  const CC_BOARD_ID = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, {dataset:"meta", limit:10});
    const ccRows = ((ccBoard?.datasets?.meta?.rows ?? ccBoard?.data?.datasets?.meta?.rows ?? []) as Record<string, unknown>[]);
    if (!_ccSecret.startsWith("{{")) {
      const setupRow = ccRows.find((r: Record<string, unknown>) => r.key === "cc_setup");
      if (setupRow) {
        try {
          const setup = JSON.parse(String(setupRow.value ?? "{}")) as Record<string, unknown>;
          if (setup.prospector_id) BOARD_ID     = String(setup.prospector_id);
          if (setup.crm_id)       CRM_BOARD_ID = String(setup.crm_id);
          if (setup.owner_id)     OWNER_ID     = String(setup.owner_id);
        } catch {}
      }
    }
    const configRow = ccRows.find((r: Record<string, unknown>) => r.key === "agent_config");
    if (configRow) {
      const config = JSON.parse(String(configRow.value ?? "{}")) as Record<string, unknown>;
      const campaigns = (config.campaigns as {id:string;discovery_queries?:string[];topic_signals?:string[];institution_signals?:string[];target_titles?:string[];prospector_board_id?:string}[] ?? []);
      const activeCampaignId = String(config.active_campaign_id ?? "");
      const campaign = campaigns.find(c => c.id === activeCampaignId) ?? null;
      if (campaign) {
        if ((campaign.prospector_board_id ?? "").length > 0) BOARD_ID = String(campaign.prospector_board_id);
        if ((campaign.discovery_queries ?? []).length > 0) {
          QUERIES_NEWSAPI = campaign.discovery_queries as string[];
          QUERIES_SERPER = (campaign.discovery_queries as string[]).map(q => q.replace(/"/g, "") + " 2026");
        }
        if ((campaign.topic_signals ?? []).length > 0) BLOCKCHAIN_TERMS = (campaign.topic_signals as string[]).map(t => t.toLowerCase());
        if ((campaign.institution_signals ?? []).length > 0) FI_TERMS = (campaign.institution_signals as string[]).map(t => t.toLowerCase());
        if ((campaign.target_titles ?? []).length > 0) DA_TITLES = campaign.target_titles as string[];
        console.log(`Campaign: ${campaign.id} loaded (${QUERIES_NEWSAPI.length}q, ${BLOCKCHAIN_TERMS.length} topic, ${FI_TERMS.length} inst)`);
      } else {
        console.log("Campaign config: no active campaign -- using hardcoded defaults");
      }
    }
  } catch (e) { console.log(`Campaign config: ${String(e).slice(0, 80)} -- using hardcoded defaults`); }

  type SignalEntry = {domain:string;title:string;leads:string[];hasDup:boolean};
  const signalMap = new Map<string, SignalEntry>();
  const allMentions: string[] = [];
  const perSource: Record<string, {raw:number;rel:number}> = {};

  let dupeCount = 0;
  let naOk = 0, na429 = 0, naErr = 0;
  let srOk = 0, srErr = 0, srLastStatus = 0;
  let fcOk = 0, fcErr = 0;
  let srcFollowed = 0, apolloSearches = 0;
  let menTotal = 0;
  let signalLeads = 0, newsLeads = 0, partnerLeads = 0, apptLeads = 0;
  let emailBackfill = 0, emailBfTried = 0;
  let verifiedCount = 0;
  let crmSyncCount = 0;
  const emailSrcs: Record<string, number> = {hunter:0,apollo:0,findymail:0,datagma:0,prospeo:0,snov:0};
  let deadlineHit = false;


  function elapsed() { return Date.now() - startTime; }
  function overDeadline() { return elapsed() > DEADLINE_MS; }

  // Firecrawl fetch -- handles JS-rendered pages and blocked sites (swift.com etc.)
  async function firecrawlFetch(url: string): Promise<string> {
    try {
      const r = await brains.http_fetch({
        url: "https://api.firecrawl.dev/v1/scrape",
        method: "POST",
        headers: {"Authorization": "Bearer {{firecrawl_api_key}}", "Content-Type": "application/json"},
        body: JSON.stringify({url, formats: ["markdown"], onlyMainContent: true})
      });
      if (!r.ok) { fcErr++; return ""; }
      const d = r.json as {success?: boolean; data?: {markdown?: string}};
      if (d.success && d.data?.markdown) { fcOk++; return d.data.markdown.slice(0, 4000); }
      fcErr++;
      return "";
    } catch { fcErr++; return ""; }
  }

  async function sendSummary(newLeads: Record<string, unknown>[], newWithEmailCount: number, partial: boolean) {
    const runtimeSec = Math.round(elapsed() / 1000);
    const rssLine = Object.entries(perSource).filter(([,v]) => v.raw > 0).sort((a,b) => b[1].raw - a[1].raw).slice(0, 8).map(([dom,v]) => `${dom.split(".")[0]}:${v.raw}->${v.rel}`).join(" ");
    const menLine = allMentions.slice(0, 10).join(", ");
    const allSignals = Array.from(signalMap.values());
    const signalLines = allSignals.slice(0, 8).map(s => {
      const prefix = `- (${s.domain}) ${s.title.slice(0, 68)}`;
      if (s.leads.length > 0) return `${prefix}\n  -> ${s.leads.join(", ")}`;
      if (s.hasDup) return `${prefix}\n  -> (dup)`;
      return prefix;
    }).join("\n");
    const srcLine = Object.entries(emailSrcs).filter(([,v]) => v > 0).map(([k,v]) => `${k}:${v}`).join(" ");

    const diagParts = [
      partial ? `[PARTIAL -- deadline hit at ${runtimeSec}s]` : "",
      `NA: ${naOk}ok ${na429}x429 ${naErr}err | Serper: ${srOk}ok ${srErr}err${srErr > 0 ? ` (HTTP ${srLastStatus})` : ""}`,
      `Firecrawl: ${fcOk}ok ${fcErr}err | SrcFollow: ${srcFollowed} | ApolloSearch: ${apolloSearches}`,
      `Snov.io token: ${SNOV_TOKEN ? "ok" : "FAILED"}`,
      emailBfTried > 0 ? `Board BF: ${emailBfTried} tried -> ${emailBackfill} found` : "",
      `CRM: ${crmLeads.length} read | sync: +${crmSyncCount} to Prospector`,
      srcLine ? `Email srcs: ${srcLine} | verified: ${verifiedCount}` : "",
      menLine ? `Men: ${menLine}` : "",
      rssLine ? `RSS: ${rssLine}` : "",
    ].filter(Boolean);

    const leadLines = newLeads.slice(0, 12).map(l => `- ${l.name} @ ${l.company} -- ${l.position}${l.email !== "pending" ? " (email)" : ""}`).join("\n");
    const more = newLeads.length > 12 ? `\n...+${newLeads.length - 12} more` : "";

    const msg = [
      `Prospector ${VERSION} -- ${today}`,
      ``,
      `New leads: ${newLeads.length} (${newWithEmailCount} w/ email, ${verifiedCount} verified)`,
      `Dupes skipped: ${dupeCount}`,
      emailBackfill > 0 ? `Board BF: ${emailBackfill}` : "",
      newLeads.length > 0 ? `\n${leadLines}${more}` : "",
      ``,
      `Signals: ${signalLeads} | News: ${newsLeads}`,
      `Partnerships: ${partnerLeads} | Appts: ${apptLeads}`,
      `Runtime: ${runtimeSec}s`,
      ``,
      ...diagParts,
      ``,
      allSignals.length > 0 ? `Signals:\n${signalLines}` : `Signals: none`,
    ].filter(s => s !== "").join("\n");

    const truncated = msg.length > 3900 ? msg.slice(0, 3900) + "\n...(truncated)" : msg;
    try {
      await brains.telegram_push({text: truncated});
    } catch (e) {
      console.log(`telegram_push (summary) failed: ${String(e).slice(0, 120)}`);
    }
  }

  // 0. Snov.io OAuth token
  try {
    const sr = await brains.http_fetch({
      url: "https://api.snov.io/v1/oauth/access_token?grant_type=client_credentials&client_id={{snov_client_id}}&client_secret={{snov_client_secret}}",
      method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: ""
    });
    if (sr.ok) { const sd = sr.json as {access_token?:string}; SNOV_TOKEN = sd.access_token ?? ""; }
    console.log(`Snov: ${SNOV_TOKEN ? "ok" : "FAILED"}`);
  } catch {}
  try {
    await brains.telegram_push({text: `Prospector ${VERSION} started -- Snov: ${SNOV_TOKEN ? "ok" : "FAILED"}`});
  } catch (e) {
    console.log(`telegram_push (startup) failed: ${String(e).slice(0, 120)}`);
  }

  // 1. Board dedup
  const existingLeads: Record<string, unknown>[] = [];
  let dedupOffset = 0;
  while (true) {
    const board = await brains.boards.get(BOARD_ID, {dataset:"leads",offset:dedupOffset,limit:1000});
    const rows = (board?.datasets?.leads?.rows ?? board?.data?.datasets?.leads?.rows ?? []) as Record<string, unknown>[];
    existingLeads.push(...rows);
    if (rows.length < 1000) break;
    dedupOffset += rows.length;
    if (dedupOffset > 10000) break;
  }
  const activeLeads = existingLeads.filter(l => !l._deleted_at);
  const existingKeys = new Set<string>(
    activeLeads.map(l => `${String(l.name ?? "").toLowerCase().trim()}|${String(l.company ?? "").toLowerCase().trim()}`)
  );
  console.log(`Dedup: ${existingKeys.size} | ${Math.round(elapsed()/1000)}s`);

  // 1b. CRM dedup -- read CRM board leads via REST API (cross-brain: brains.boards.get won't work)
  let crmLeads: Record<string, unknown>[] = [];
  try {
    let crmOffset = 0;
    while (true) {
      const r = await brains.http_fetch({
        url: `https://app.mybrains.ai/api/v1/boards/${CRM_BOARD_ID}/rows?dataset=leads&limit=1000&offset=${crmOffset}`,
        method: "GET",
        headers: {"Authorization": "Bearer {{brains_user_token}}"}
      });
      if (!r.ok) { console.log(`CRM read failed: HTTP ${r.status}`); break; }
      const d = r.json as {items?: Record<string, unknown>[], page?: {returned: number}};
      const items = d.items ?? [];
      crmLeads.push(...items);
      if (items.length < 1000) break;
      crmOffset += items.length;
      if (crmOffset > 5000) break;
    }
    for (const l of crmLeads) existingKeys.add(`${String(l.name ?? "").toLowerCase().trim()}|${String(l.company ?? "").toLowerCase().trim()}`);
    console.log(`CRM dedup: ${crmLeads.length} leads added to existingKeys`);
  } catch (e) { console.log(`CRM read failed: ${String(e).slice(0, 80)}`); }

  // 2. Board email backfill -- 45s
  const boardNeedsEmail = activeLeads.filter(l => !l.email || l.email === "" || l.email === "pending");
  const bfBoardStart = Date.now();
  for (const lead of boardNeedsEmail) {
    if (Date.now() - bfBoardStart > 45000 || overDeadline()) break;
    emailBfTried++;
    const {email, src, verified} = await findEmail(String(lead.name ?? ""), String(lead.company ?? ""));
    if (email && lead.row_id) {
      try {
        await brains.update_board_row({board_id:BOARD_ID, row_id:String(lead.row_id), dataset:"leads", patch:{email, email_source: src, confidence: verified ? "High" : "Medium", updatedAt:new Date().toISOString()}});
        emailBackfill++; emailSrcs[src] = (emailSrcs[src] ?? 0) + 1;
        if (verified) verifiedCount++;
      } catch {}
    }
  }
  if (overDeadline()) { deadlineHit = true; await sendSummary([], 0, true); return; }

  // 4. NewsAPI -- 11 queries, 72h window
  const fromDate = new Date(Date.now() - 72 * 3600 * 1000).toISOString().slice(0, 10);
  const seenUrls = new Set<string>();
  type Article = {title:string;description:string;url:string;source:string};
  const rawArticles: Article[] = [];

  for (const q of QUERIES_NEWSAPI) {
    if (overDeadline()) { deadlineHit = true; break; }
    try {
      const r = await brains.http_fetch({url:"https://newsapi.org/v2/everything",method:"GET",headers:{"X-Api-Key":"{{newsapi_key}}"},query:{q,language:"en",sortBy:"publishedAt",pageSize:20,from:fromDate}});
      if (r.status === 429) { na429++; continue; }
      if (!r.ok) { naErr++; continue; }
      naOk++;
      const d = r.json as {articles?:{title:string;description:string;url:string;source:{name:string}}[]};
      for (const a of d.articles ?? []) {
        if (!a.url || seenUrls.has(a.url)) continue;
        seenUrls.add(a.url);
        const dom = getDomain(a.url);
        perSource[dom] = perSource[dom] ?? {raw:0,rel:0};
        perSource[dom].raw++;
        rawArticles.push({title:a.title??"",description:a.description??"",url:a.url,source:a.source?.name??""});
      }
    } catch { naErr++; }
  }
  console.log(`NA: ${naOk}ok pool=${rawArticles.length} | ${Math.round(elapsed()/1000)}s`);

  // 6. The Defiant RSS
  if (!deadlineHit) {
    try {
      const q = encodeURIComponent("site:thedefiant.io");
      const r = await brains.http_fetch({url:`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,method:"GET",headers:{"User-Agent":"Mozilla/5.0","Accept":"application/rss+xml,*/*"}});
      if (r.ok) {
        for (const m of [...String(r.text ?? "").matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 30)) {
          const b = m[1];
          const title = (b.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ?? b.match(/<title>([^<]*)<\/title>/))?.[1]?.trim() ?? "";
          const link = (b.match(/<link>([^<]+)<\/link>/) ?? b.match(/<guid[^>]*>([^<]+)<\/guid>/))?.[1]?.trim() ?? "";
          if (!title || !link || seenUrls.has(link)) continue;
          seenUrls.add(link);
          perSource["thedefiant.io"] = perSource["thedefiant.io"] ?? {raw:0,rel:0};
          perSource["thedefiant.io"].raw++;
          rawArticles.push({title,description:"",url:link,source:"The Defiant"});
        }
      }
    } catch {}
  }

  // 6b. Serper -- batches of 3
  if (!deadlineHit) {
    const serperBatchResults = await batchedParallel(QUERIES_SERPER, 3, async (q: unknown) => {
      if (overDeadline()) return [];
      try {
        const r = await brains.http_fetch({
          url: "https://google.serper.dev/search", method: "POST",
          headers: {"Content-Type": "application/json", "X-API-KEY": "{{serper_api_key}}"},
          body: JSON.stringify({q: q as string, num: 10, tbs: "qdr:w"})
        });
        if (!r.ok) { srErr++; srLastStatus = r.status; if (srErr === 1) console.log(`Serper err #1: HTTP ${r.status}`); return []; }
        srOk++;
        const _sd = r.json as {organic?: {title:string;link:string;snippet:string}[]};
        return (_sd.organic ?? []).map(item => ({title: item.title, url: item.link, content: item.snippet}));
      } catch { srErr++; return []; }
    });
    for (const results of serperBatchResults as {title:string;url:string;content:string}[][]) {
      for (const result of (results ?? [])) {
        if (!result.url || seenUrls.has(result.url)) continue;
        seenUrls.add(result.url);
        const dom = getDomain(result.url);
        perSource[dom] = perSource[dom] ?? {raw:0,rel:0};
        perSource[dom].raw++;
        rawArticles.push({title:result.title??"",description:result.content??"",url:result.url,source:dom});
      }
    }
    console.log(`Serper: ${srOk}ok ${srErr}err pool=${rawArticles.length} | ${Math.round(elapsed()/1000)}s`);
  }

  // 6c. Institutional RSS -- fully parallel
  if (!deadlineHit) {
    const INST_RSS = [
      {url:"https://www.swift.com/rss.xml",name:"SWIFT"},
      {url:"https://www.bis.org/rss/index.htm",name:"BIS"},
      {url:"https://news.google.com/rss/search?q=site:prnewswire.com+tokenization+OR+tokenisation+blockchain+bank&hl=en-US&gl=US&ceid=US:en",name:"PRNewswire"},
      {url:"https://news.google.com/rss/search?q=site:businesswire.com+tokenization+OR+tokenisation+blockchain+bank&hl=en-US&gl=US&ceid=US:en",name:"BusinessWire"},
      {url:"https://news.google.com/rss/search?q=site:globenewswire.com+tokenization+OR+tokenisation+blockchain+bank&hl=en-US&gl=US&ceid=US:en",name:"GlobeNewsWire"},
    ];
    const rssResults = await Promise.all(INST_RSS.map(feed => fetchInstRSS(feed.url, feed.name)));
    for (const items of rssResults) {
      for (const a of items) {
        if (seenUrls.has(a.url)) continue;
        seenUrls.add(a.url);
        const dom = getDomain(a.url);
        perSource[dom] = perSource[dom] ?? {raw:0,rel:0};
        perSource[dom].raw++;
        rawArticles.push(a);
      }
    }
    console.log(`InstRSS done pool=${rawArticles.length} | ${Math.round(elapsed()/1000)}s`);
  }
  if (deadlineHit) { await sendSummary([], 0, true); return; }

  // 7. Relevance gate
  const relevant = rawArticles.filter(a => isRelevantArticle(a.title, a.description));
  for (const a of relevant) {
    const dom = getDomain(a.url);
    if (perSource[dom]) perSource[dom].rel++;
    signalMap.set(a.url, {domain:a.source==="The Defiant"?"thedefiant.io":dom,title:a.title,leads:[],hasDup:false});
  }
  console.log(`Gate: ${relevant.length} passed | ${Math.round(elapsed()/1000)}s`);

  // 8. Extract leads
  const newLeads: Record<string, unknown>[] = [];

  // Regex to find institutional URLs in any text (markdown or raw)
  const instUrlPattern = new RegExp(
    `https?://(?:www\\.)?(?:${INST_LINK_DOMAINS.map(d => d.replace(/\./g, "\\.")).join("|")})[^\\s)"'<>{}\\],]{0,300}`,
    "gi"
  );

  for (const article of relevant) {
    if (overDeadline()) { deadlineHit = true; break; }
    const category = classifyArticle(article.title, article.description);
    const headlineName = extractNameFromHeadline(article.title);

    // Fetch article body
    let rawHtml = "";
    let bodyText = `${article.title}. ${article.description}`;
    const domain = getDomain(article.url);

    if (CONTENT_DOMAINS.has(domain)) {
      if (JS_DOMAINS.has(domain)) {
        // JS-rendered: Firecrawl returns real article body
        const fc = await firecrawlFetch(article.url);
        if (fc) bodyText = fc;
        // Also try raw fetch for Option A HTML link scanning
        try {
          const pr = await brains.http_fetch({url:article.url,method:"GET",headers:{"User-Agent":"Mozilla/5.0 (compatible; BDSuiteBot/1.0)"}});
          if (pr.ok) rawHtml = String(pr.text ?? "");
        } catch {}
      } else {
        // Static HTML: raw fetch for body + Option A scanning
        try {
          const pr = await brains.http_fetch({url:article.url,method:"GET",headers:{"User-Agent":"Mozilla/5.0 (compatible; BDSuiteBot/1.0)"}});
          if (pr.ok) {
            rawHtml = String(pr.text ?? JSON.stringify(pr.json ?? ""));
            bodyText = stripHtml(rawHtml).slice(0, 3000);
          }
        } catch {}
      }
    }

    // OPTION A: Find and follow institutional source links
    // Scans both raw HTML hrefs AND Firecrawl markdown text for institutional URLs
    if (!overDeadline()) {
      const hrefRe = new RegExp(
        `href=["'](https?://(?:www\\.)?(?:${INST_LINK_DOMAINS.map(d => d.replace(/\./g, "\\.")).join("|")})[^"'<>\\s]{0,300})`,
        "gi"
      );
      const htmlLinks = rawHtml ? [...rawHtml.matchAll(hrefRe)].map(m => m[1]) : [];
      const textLinks = [...bodyText.matchAll(instUrlPattern)].map(m => m[0]);
      const sourceLinks = [...new Set([...htmlLinks, ...textLinks])]
        .filter(u => !seenUrls.has(u) && u.length > 20)
        .slice(0, 2);

      for (const srcUrl of sourceLinks) {
        if (overDeadline()) break;
        // Use Firecrawl -- handles swift.com and other sites that block raw HTTP
        const srcContent = await firecrawlFetch(srcUrl);
        if (srcContent) {
          seenUrls.add(srcUrl);
          srcFollowed++;
          bodyText += `\n\n[SOURCE PRESS RELEASE -- ${getDomain(srcUrl)}]:\n${srcContent.slice(0, 2000)}`;
        }
      }
    }

    // LLM extraction -- people named in article + source press release
    const headlineHint = headlineName ? `\n CRITICAL: This article is a profile piece about "${headlineName}". They MUST appear in your output.` : "";
    const prompt = `You are a lead extractor for a B2B sales team.\n${headlineHint}\n\nARTICLE:\nHeadline: "${article.title}"\nBody: ${bodyText.slice(0, 3000)}\n\nFind ALL people mentioned who are senior executives or decision-makers at companies directly involved in the story.\n\nReturn JSON array (max 12):\n[{"name":"First Last","company":"Employer","position":"Exact title","signal":"One sentence why relevant"}]\n\nRules: only real human names with a known employer, return [] if none. Output ONLY JSON.`;

    let extracted: {name:string;company:string;position:string;signal:string}[] = [];
    try {
      const resp = await brains.llm({messages:[{role:"user",content:prompt}],max_tokens:1200});
      const respObj = resp as Record<string, unknown>;
      const llmText = String(respObj?.text ?? respObj?.content?.[0]?.text ?? resp ?? "");
      extracted = extractJsonArray(llmText) as {name:string;company:string;position:string;signal:string}[];
    } catch {
      if (headlineName) extracted = [{name:headlineName,company:"",position:"",signal:"headline name fallback"}];
    }

    // OPTION B: Company->contact pipeline -- runs for ALL signal/partner articles.
    if ((category === "signal" || category === "partner") && !overDeadline()) {
      try {
        const coveredCompanies = new Set(extracted.map(e => (e.company ?? "").toLowerCase().trim()));
        const compResp = await brains.llm({
          messages:[{role:"user",content:`List up to 8 companies or organizations that are DIRECTLY PARTICIPATING in the initiative described in this article -- not just mentioned in passing.\n\nHeadline: "${article.title}"\nBody: ${bodyText.slice(0, 1500)}\n\nReturn JSON array of company names ONLY: ["Company Name", ...]\nIf none clearly participating, return []. Output ONLY JSON.`}],
          max_tokens:300
        });
        const compObj = compResp as Record<string, unknown>;
        const compText = String(compObj?.text ?? compObj?.content?.[0]?.text ?? compResp ?? "");
        const allCompanies: string[] = (extractJsonArray(compText) as string[]).filter(c => typeof c === "string" && c.length > 1);
        const companies = allCompanies.filter(c => !coveredCompanies.has(c.toLowerCase().trim())).slice(0, 6);

        console.log(`Option B: ${allCompanies.length} total companies, ${companies.length} uncovered from "${article.title.slice(0,50)}"`);

        for (const company of companies) {
          if (overDeadline()) break;
          apolloSearches++;
          try {
            const apolloR = await brains.http_fetch({
              url: "https://api.apollo.io/api/v1/mixed_people/search",
              method: "POST",
              headers: {"Content-Type":"application/json","Cache-Control":"no-cache"},
              body: JSON.stringify({
                api_key: "{{apollo_api_key}}",
                person_titles: DA_TITLES,
                organization_names: [company],
                page: 1,
                per_page: 3,
              })
            });
            if (apolloR.ok) {
              const apolloD = apolloR.json as {people?: {name?:string;title?:string;organization?:{name?:string};email?:string;email_status?:string}[]};
              for (const p of (apolloD.people ?? []).slice(0, 3)) {
                if (!p.name || !isValidHumanName(p.name)) continue;
                extracted.push({
                  name: p.name,
                  company: p.organization?.name ?? company,
                  position: p.title ?? "",
                  signal: `Digital assets executive at ${company} -- participating in: ${article.title.slice(0,80)}`,
                });
              }
            }
          } catch {}
        }
      } catch {}
    }

    // Process extracted leads
    const sig = signalMap.get(article.url)!;
    menTotal += extracted.length;

    for (const lead of extracted) {
      if (!lead.name || !isValidHumanName(lead.name) || !lead.company?.trim()) continue;
      const key = `${lead.name.toLowerCase().trim()}|${(lead.company ?? "").toLowerCase().trim()}`;
      if (existingKeys.has(key)) { dupeCount++; sig.hasDup = true; allMentions.push(`${lead.name}(dup)`); continue; }
      existingKeys.add(key);
      sig.leads.push(lead.name);
      allMentions.push(`${lead.name}@${lead.company ?? ""}`);
      if (category === "signal") signalLeads++;
      else if (category === "partner") partnerLeads++;
      else if (category === "appt") apptLeads++;
      else newsLeads++;
      newLeads.push({
        name: lead.name,
        company: lead.company ?? "",
        position: lead.position ?? "",
        email: "pending",
        linkedIn: "",
        outreach_status: "linkedin_pending",
        signal: `${lead.signal ?? ""} | ${article.source} -- ${article.url}`,
        confidence: "Medium",
        notes: `Auto-discovered ${today}. "${article.title}"`,
        owner: OWNER_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        updates: [],
        source_url: article.url,
        source_name: article.source,
      });
    }

    // Headline fallback if still no leads
    if (sig.leads.length === 0 && headlineName) {
      const key = `${headlineName.toLowerCase()}|`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        sig.leads.push(headlineName);
        allMentions.push(`${headlineName}@(headline)`);
        if (category === "signal") signalLeads++; else newsLeads++;
        newLeads.push({name:headlineName,company:"",position:"",email:"pending",linkedIn:"",outreach_status:"linkedin_pending",confidence:"Medium",notes:`Auto-discovered ${today}. "${article.title}"`,owner:OWNER_ID,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),updates:[],source_url:article.url,source_name:article.source});
      } else { sig.hasDup = true; }
    }
  }
  console.log(`Extracted ${newLeads.length} leads | SrcFollow: ${srcFollowed} | ApolloSearch: ${apolloSearches} | FC: ${fcOk}ok ${fcErr}err | ${Math.round(elapsed()/1000)}s`);

  // 9. Email enrichment
  let newWithEmailCount = 0;
  for (const lead of newLeads) {
    if (overDeadline()) { deadlineHit = true; break; }
    if (lead.email && lead.email !== "pending") { newWithEmailCount++; continue; }
    const {email, src, verified} = await findEmail(String(lead.name), String(lead.company ?? ""));
    if (email) {
      lead.email = email;
      lead.email_source = src;
      lead.confidence = verified ? "High" : "Medium";
      newWithEmailCount++;
      emailSrcs[src] = (emailSrcs[src] ?? 0) + 1;
      if (verified) verifiedCount++;
    }
  }

  // 10. Board write
  if (newLeads.length > 0 && !deadlineHit) {
    const rows = newLeads.map((lead, i) => ({...lead, row_id:`LD-${Date.now()}-${i}`}));
    await brains.append_board_rows({board_id:BOARD_ID,dataset:"leads",rows});
    console.log(`Board: +${rows.length} rows`);
  }

  // 11. CRM sync -- add CRM leads not yet in Prospector board
  if (crmLeads.length > 0 && !deadlineHit) {
    const prospectorKeys = new Set<string>(
      activeLeads.map(l => `${String(l.name ?? "").toLowerCase().trim()}|${String(l.company ?? "").toLowerCase().trim()}`)
    );
    const toSync = crmLeads.filter(l => {
      const k = `${String(l.name ?? "").toLowerCase().trim()}|${String(l.company ?? "").toLowerCase().trim()}`;
      return k.length > 1 && !prospectorKeys.has(k);
    });
    if (toSync.length > 0) {
      const rows = toSync.map((l, i) => ({
        row_id: `CRM-${String(l.row_id ?? i)}`,
        name: String(l.name ?? ""),
        company: String(l.company ?? ""),
        position: String(l.role ?? l.position ?? ""),
        email: String(l.email ?? "pending"),
        owner: String(l.assigned_to ?? OWNER_ID),
        status: "Viable lead",
        source: "crm_sync",
        created_at: new Date().toISOString(),
      }));
      try {
        await brains.append_board_rows({board_id:BOARD_ID, dataset:"leads", rows});
        crmSyncCount = rows.length;
        console.log(`CRM sync: +${crmSyncCount} leads added to Prospector`);
      } catch (e) { console.log(`CRM sync write failed: ${String(e).slice(0, 80)}`); }
    }
  }

  await sendSummary(newLeads, newWithEmailCount, deadlineHit);
}

await main();