// ============================================================
// Agent 4: CRM Updater (Brains Automation)
// Brains automation ID: b6de2d3f-fa89-4f3c-87df-24b4c2219f91
// Version: 15 — multi-tenant: SENDER_NAME/PRODUCT_NAME/PRODUCT_CONTEXT read from CC board; no hardcoded identity
// Cron: */5 * * * * Asia/Singapore (every 5 min)
// Description: Processes Granola transcripts queued by local script.
//              Phase 1: transcript -> detect doc commitments -> generate mini-sites
//                       -> share with attendees -> email with links -> Gmail draft -> OQ FU10
//              Phase 1.5: sent OQ-10 rows -> LLM CRM log -> crm_draft + Telegram
//              Phase 2: detect "crm approve/skip CD-xxxx" -> update crm_draft status
//              Phase 3: approved -> write meeting/company/lead to CRM board directly
//              Phase 4: FU chain (FU11/12/13 at 3/5/7 days)
// COMPANION: agent4-local.mjs (local pm2 script handles Granola polling only)
// ============================================================

// agent4-crm-updater v13 — Phase 3 writes CRM directly (cross-brain write now supported)
// Phase 3: approved -> brains.append/update on CRM_BOARD_ID directly -> synced

const _ccSecret    = "{{cc_board_id}}";
const CC_BOARD_ID  = _ccSecret.startsWith("{{") ? "2907a47b-b179-452e-b9de-042367012bf0" : _ccSecret;
const _gmailSecret = "{{gmail_install_id}}";

async function main() {
  let PROSPECTOR      = '95dcb668-e2d9-4093-9a3e-3200901846fa';
  let CRM_BOARD_ID    = '1de2a9f5-03cd-427e-9bb4-9198ed336f62';
  let GMAIL_INSTALL_ID: string = _gmailSecret.startsWith("{{") ? '' : _gmailSecret;
  let SENDER_NAME     = '';
  let SENDER_IDENTITY = '';
  let PRODUCT_NAME    = '';
  let PRODUCT_CONTEXT = '';
  let TEST_EMAIL      = '';
  try {
    const ccB = await brains.get_board({ board_id: CC_BOARD_ID, dataset: 'meta', limit: 50 });
    const ccRows = (ccB as any)?.data?.datasets?.meta?.rows ?? [];
    const setupRow = ccRows.find((r: any) => String(r.key ?? '') === 'cc_setup');
    if (setupRow) {
      const setup = JSON.parse(String(setupRow.value ?? '{}'));
      if (setup.prospector_id) PROSPECTOR    = setup.prospector_id;
      if (setup.crm_id)        CRM_BOARD_ID  = setup.crm_id;
      if (setup.sender_name)   { SENDER_NAME = String(setup.sender_name); SENDER_IDENTITY = SENDER_NAME; }
      if (setup.sender_title)  SENDER_IDENTITY = `${SENDER_NAME}, ${String(setup.sender_title)}`;
      if (setup.test_email)    TEST_EMAIL = String(setup.test_email);
    }
    const configRow = ccRows.find((r: any) => String(r.key ?? '') === 'agent_config');
    if (configRow) {
      const cfg = JSON.parse(String(configRow.value ?? '{}'));
      const campaigns = Array.isArray(cfg.campaigns) ? cfg.campaigns : [];
      const active = campaigns.find((c: any) => c.id === cfg.active_campaign_id);
      if (active) {
        if (active.sender_name)         { SENDER_NAME = String(active.sender_name); SENDER_IDENTITY = SENDER_NAME; }
        if (active.sender_title)        {
          SENDER_IDENTITY = `${SENDER_NAME}, ${String(active.sender_title)}`;
          const pn = String(active.sender_title).split(/,\s*at\s*/i)[1]?.split(/[,\s]/)[0]?.trim();
          if (pn) PRODUCT_NAME = pn;
        }
        if (active.product_description) PRODUCT_CONTEXT = String(active.product_description);
      }
    }
  } catch (e) { console.log(`cc_setup read: ${e}`); }
  console.log(`Config: PROSPECTOR=${PROSPECTOR.slice(0,8)} CRM=${CRM_BOARD_ID.slice(0,8)} SENDER=${SENDER_NAME} PRODUCT=${PRODUCT_NAME}`);
  const FU_DAYS: Record<number, number> = { 11: 3, 12: 5, 13: 7 };
  const CMD_WINDOW_MS = 2 * 60 * 60 * 1000;

  const [queueB, crmDraftB, oqB, metaB, boardLeadsB] = await Promise.all([
    brains.get_board({ board_id: PROSPECTOR, dataset: 'transcript_queue', limit: 50 }),
    brains.get_board({ board_id: PROSPECTOR, dataset: 'crm_draft', limit: 100 }),
    brains.get_board({ board_id: PROSPECTOR, dataset: 'outreach_queue', limit: 2000 }),
    brains.get_board({ board_id: PROSPECTOR, dataset: 'meta', limit: 200 }),
    brains.get_board({ board_id: PROSPECTOR, dataset: 'leads', limit: 500 }),
  ]);

  const queueRows    = (queueB as any)?.data?.datasets?.transcript_queue?.rows ?? [];
  const crmDraftRows = (crmDraftB as any)?.data?.datasets?.crm_draft?.rows ?? [];
  const oqRows       = (oqB as any)?.data?.datasets?.outreach_queue?.rows ?? [];;
  const metaRows     = (metaB as any)?.data?.datasets?.meta?.rows ?? [];
  const boardLeads   = (boardLeadsB as any)?.data?.datasets?.leads?.rows ?? [];

  const counterRow    = metaRows.find((r: any) => String(r.key ?? '') === 'outreach_queue_counter');
  const draftCountRow = metaRows.find((r: any) => String(r.key ?? '') === 'crm_draft_counter');
  const fuChainsRow   = metaRows.find((r: any) => String(r.key ?? '') === 'pending_fu_chains');

  console.log(`Board leads loaded: ${boardLeads.length}`);

  function getOqCounter(): number {
    const maxOQ = oqRows.reduce((max: number, r: any) => {
      const n = parseInt(String(r.id ?? '').replace('OQ-', ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    return Math.max(maxOQ, parseInt(String(counterRow?.value ?? '0'), 10));
  }

  function getDraftCounter(): number {
    const maxCD = crmDraftRows.reduce((max: number, r: any) => {
      const n = parseInt(String(r.draft_id ?? '').replace('CD-', ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    return Math.max(maxCD, parseInt(String(draftCountRow?.value ?? '0'), 10));
  }

  function findBoardLead(companyName: string): any {
    const nl = companyName.toLowerCase().trim();
    const withResearch = boardLeads.filter((l: any) => String(l.da_research ?? '').length > 50);
    const match = withResearch.find((l: any) => {
      const co = String(l.company ?? '').toLowerCase().trim();
      return co && (co.includes(nl) || nl.includes(co));
    });
    if (match) return match;
    return boardLeads.find((l: any) => {
      const co = String(l.company ?? '').toLowerCase().trim();
      return co && (co.includes(nl) || nl.includes(co));
    });
  }

  async function updateOqCounter(val: number) {
    if (counterRow?.row_id) {
      await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'meta', row_id: String(counterRow.row_id), patch: { value: String(val) } });
    } else {
      await brains.append_board_rows({ board_id: PROSPECTOR, dataset: 'meta', rows: [{ key: 'outreach_queue_counter', value: String(val) }] });
    }
  }

  async function updateDraftCounter(val: number) {
    if (draftCountRow?.row_id) {
      await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'meta', row_id: String(draftCountRow.row_id), patch: { value: String(val) } });
    } else {
      await brains.append_board_rows({ board_id: PROSPECTOR, dataset: 'meta', rows: [{ key: 'crm_draft_counter', value: String(val) }] });
    }
  }

  let oqCounter    = getOqCounter();
  let draftCounter = getDraftCounter();

  // ── PHASE 1: detect docs -> generate mini-sites -> share -> email with links -> Gmail draft -> OQ FU10 ──

  const pending = queueRows.filter((r: any) => r.processed === 'false');
  console.log(`Phase 1: ${pending.length} pending transcript(s).`);

  for (const row of pending) {
    const meeting_title      = String(row.meeting_title ?? '');
    const tqDate             = String(row.tq_date ?? row.date ?? '');
    const company            = String(row.company ?? '');
    const external_attendees = String(row.external_attendees ?? '');
    const transcript         = String(row.transcript ?? '');
    const notes_source       = String(row.notes_source ?? 'unknown');
    const isTest             = String(row.test_mode ?? '') === 'true';
    const queueRowId         = String(row.row_id ?? '');

    const boardLead    = findBoardLead(company);
    const daResearch   = String(boardLead?.da_research ?? '').trim();
    const productCases = String(boardLead?.product_use_cases ?? boardLead?.ethera_use_cases ?? '').trim();
    console.log(`  Research for "${company}": ${daResearch ? `${daResearch.length} chars` : 'none'}`);

    const firstAttendee = external_attendees.split(',')[0].trim();
    const firstName = firstAttendee.replace(/\s*\(.*\)/, '').trim().split(/\s+/)[0] || 'there';

    // STEP A: Detect document commitments from transcript
    let docCommitments: Array<{type: string, title: string, context: string}> = [];
    try {
      const docDetectOut = await brains.llm({
        prompt: `Review this meeting transcript and identify materials, documents, or resources that were promised to be sent OR would clearly strengthen the follow-up email as an attachment link.\n\nMeeting: ${meeting_title}\nCompany: ${company}\nDate: ${tqDate}\nAttendees: ${external_attendees}\n\nTranscript:\n${transcript.slice(0, 3000)}\n\nReturn ONLY valid JSON (no preamble):\n{\n  "documents": [\n    {\n      "type": "fund_flow" | "one_pager" | "technical_overview" | "use_case_brief",\n      "title": "Specific descriptive title for this document based on what was discussed in the meeting",\n      "context": "What was discussed that motivates this document — 1-2 sentences referencing the actual conversation"\n    }\n  ]\n}\n\nType guide:\n- fund_flow: any mention of process flows, diagrams, how something works step by step, movement of assets or data\n- one_pager: request for overview, intro material, send us something, what does your product do\n- technical_overview: architecture questions, how does it work technically, integration details\n- use_case_brief: specific use case discussion for this company's context\n\nReturn empty array if no documents are clearly warranted. Maximum 2 documents. Be conservative — only include docs that are genuinely relevant to what was discussed.`,
        max_tokens: 300,
      });
      const docTxt = String((docDetectOut as any)?.text ?? docDetectOut ?? '');
      const docMatch = docTxt.match(/\{[\s\S]*\}/);
      if (docMatch) {
        const parsed = JSON.parse(docMatch[0]);
        docCommitments = (Array.isArray(parsed.documents) ? parsed.documents : []).slice(0, 2);
      }
    } catch (e) {
      console.log(`  Doc detection skipped (will continue without docs): ${e}`);
    }
    console.log(`  Documents to generate: ${docCommitments.length}${docCommitments.map((d: any) => ` [${d.type}: ${d.title}]`).join('')}`);

    // STEP B: Generate each document as a mini-site and share with attendees
    const generatedDocs: Array<{title: string, url: string, type: string}> = [];

    // Parse attendee emails once for sharing
    const attendeeEmails: string[] = (external_attendees.match(/[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/g) ?? []);

    for (const doc of docCommitments) {
      try {
        const prod = PRODUCT_NAME || 'the product';
        const typeGuide: Record<string, string> = {
          fund_flow: `A visual step-by-step flow diagram showing how funds/settlement works with ${prod}. Include: source institution -> ${prod} -> settlement -> destination. Use an SVG or CSS-only diagram. Show the key steps clearly.`,
          one_pager: `A two-section overview: left/top = what ${prod} is and the core value prop, right/bottom = 3-4 specific use cases relevant to this company. Clean executive summary format.`,
          technical_overview: `Architecture overview with clear sections: (1) How it works, (2) Key components, (3) Integration approach. Use headers and short paragraphs. Focus on what makes ${prod} relevant to this company.`,
          use_case_brief: `Problem -> Solution (${prod}) -> Benefits format. Focus tightly on the specific use case discussed. Include concrete metrics or outcomes where possible.`,
        };
        const docGuide = typeGuide[doc.type] ?? typeGuide.one_pager;

        const productLabel = PRODUCT_NAME || 'Product';
        const productAbout = PRODUCT_CONTEXT ? `About ${productLabel}:\n${PRODUCT_CONTEXT}\n\n` : '';
        const casesBlock   = productCases ? `${productLabel} use cases for ${company}:\n${productCases.slice(0, 600)}\n\n` : '';
        const footerText   = SENDER_IDENTITY || productLabel;
        const htmlOut = await brains.llm({
          prompt: `Generate a complete, professional, self-contained HTML page — materials to share with ${company} after a meeting.\n\nDocument type: ${doc.type}\nTitle: ${doc.title}\nWhy this was created: ${doc.context}\n\nCompany research:\n${daResearch.slice(0, 1200)}\n\n${casesBlock}${productAbout}Content structure for ${doc.type}:\n${docGuide}\n\nHTML design requirements:\n- Complete self-contained HTML document (<!DOCTYPE html> through </html>)\n- Dark professional theme: body background #0a0e1a, primary text #e8eaf6, accent #4FBBEF\n- No external CSS, JS, or fonts — fully inline\n- IMPORTANT: Keep CSS minimal and compact — no redundant properties, short class names, avoid long animations or decorative CSS\n- Clean minimal layout, max-width 860px centered, padding 40px 24px\n- Page title tag: "${doc.title}"\n- H1: the document title\n- Small subheading: "Prepared for ${company} | ${tqDate}"\n- Content tailored specifically to ${company} based on the research above\n- Footer: small text "${footerText}"\n- Responsive (works on mobile)\n- For fund_flow: use a simple inline SVG diagram (keep SVG compact, no decorative gradients)\n\nReturn ONLY the complete HTML starting with <!DOCTYPE html>. No preamble or explanation.`,
          max_tokens: 6000,
        });

        const htmlTxt = String((htmlOut as any)?.text ?? htmlOut ?? '').trim();
        const htmlStart = htmlTxt.indexOf('<!DOCTYPE');
        const html = htmlStart >= 0 ? htmlTxt.slice(htmlStart) : htmlTxt;

        if (html.length < 200) {
          console.log(`  HTML generation empty for "${doc.title}" — skipping.`);
          continue;
        }

        const site = await brains.create_mini_site({
          name: doc.title,
          html,
          description: `${doc.type} for ${company} — ${meeting_title} (${tqDate})`,
          favicon: '📄',
          context: `Created after meeting: ${meeting_title} on ${tqDate}. Context: ${doc.context}. Company research summary: ${daResearch.slice(0, 400)}`,
        });

        const siteId  = String((site as any)?.id ?? (site as any)?.mini_site_id ?? '').trim();
        const siteUrl = String((site as any)?.url ?? '').trim() || (siteId ? `https://app.mybrains.ai/m/${siteId}` : '');

        if (siteUrl) {
          generatedDocs.push({ title: doc.title, url: siteUrl, type: doc.type });
          console.log(`  Mini-site created: "${doc.title}" -> ${siteUrl}`);
        } else {
          console.log(`  Mini-site created but no URL in response: ${JSON.stringify(site).slice(0, 150)}`);
        }

        // Share with all external attendees so the link is accessible when they receive it
        if (siteId && attendeeEmails.length > 0) {
          for (const email of attendeeEmails) {
            try {
              await (brains as any).share_mini_site({ mini_site_id: siteId, role: 'viewer', scope: 'user', email });
              console.log(`  Shared "${doc.title}" with ${email}`);
            } catch (shareErr) {
              console.log(`  Share failed for ${email}: ${shareErr}`);
            }
          }
        }

      } catch (e) {
        console.log(`  Mini-site generation failed for "${doc.title}": ${e} — continuing without it.`);
      }
    }

    // STEP C: Generate follow-up email (with document links injected if any)
    let emailResult: any = null;
    try {
      const researchBlock = [
        daResearch    ? `Company research (from our analyst):\n${daResearch.slice(0, 2000)}`                                          : '',
        productCases  ? `${PRODUCT_NAME ? PRODUCT_NAME + ' relevance' : 'Product relevance'} for ${company}:\n${productCases.slice(0, 1000)}` : '',
      ].filter(Boolean).join('\n\n');

      const docBlock = generatedDocs.length > 0
        ? `\nMaterials prepared for this email (include each link naturally in the body — not as a list at the end):\n${generatedDocs.map(d => `- ${d.title}: ${d.url}`).join('\n')}`
        : '';

      const identityCtx = SENDER_IDENTITY ? `You are ${SENDER_IDENTITY}${PRODUCT_CONTEXT ? ` (${PRODUCT_CONTEXT})` : ''}.` : PRODUCT_CONTEXT ? `You are a BD professional (${PRODUCT_CONTEXT}).` : 'You are a BD professional.';
      const signOff = SENDER_NAME ? `Best,\\n${SENDER_NAME}` : 'Best,\\n[Your name]';
      const llmOut = await brains.llm({
        prompt: `${identityCtx}\n\nWrite a follow-up email after this meeting.\n\nMeeting: ${meeting_title}\nDate: ${tqDate}\nCompany: ${company}\nAttendees: ${external_attendees}\nNotes source: ${notes_source}\n\nMeeting transcript/notes:\n${transcript.slice(0, 4000)}\n\n${researchBlock}\n${docBlock}\n\nInstructions:\n- Reference specific things discussed in this meeting (not generic)\n- Use the company research to ground the value prop in their actual business\n- If materials links are provided above, weave them in naturally (e.g. "as discussed, here's the fund flow: [URL]" or "I've put together a quick overview: [URL]")\n- 100-160 words total. No em dashes. No bullet points.\n- Start: Hi ${firstName},\n- End: ${signOff}\n\nReturn ONLY valid JSON (no preamble):\n{\n  "emailSubject": "Subject line",\n  "emailBody": "Full email body including greeting and sign-off"\n}`,
        max_tokens: 600,
      });
      const txt = String((llmOut as any)?.text ?? llmOut ?? '');
      const match = txt.match(/\{[\s\S]*\}/);
      if (match) emailResult = JSON.parse(match[0]);
    } catch (e) {
      console.log(`LLM error for "${meeting_title}": ${e} -- will retry.`);
      continue;
    }
    if (!emailResult) { console.log(`LLM parse failed for "${meeting_title}" -- will retry.`); continue; }

    const emailBody    = String(emailResult.emailBody ?? '').trim();
    const emailSubject = String(emailResult.emailSubject ?? `Following up: ${PRODUCT_NAME ? PRODUCT_NAME + ' x ' : ''}${company}`);

    const effectiveEmail   = isTest ? TEST_EMAIL : String(boardLead?.email ?? '').trim();
    const effectiveName    = isTest ? `TEST-${String(boardLead?.name ?? firstAttendee)}` : String(boardLead?.name ?? firstAttendee);
    const effectiveLeadId  = isTest ? `TEST-${String(boardLead?.row_id ?? '')}` : String(boardLead?.row_id ?? '');
    const effectiveCompany = isTest ? `TEST-${company}` : company;

    oqCounter++;
    const newOqId = `OQ-${String(oqCounter).padStart(4, '0')}`;
    const now = new Date().toISOString();

    // Create Gmail draft so Agent 2B can preview it
    let gmailDraftId = '';
    if (emailBody && effectiveEmail) {
      try {
        const bodyForDraft = emailBody.trim();
        const dr = await brains.act_on_integration({
          source: 'gmail',
          install_id: GMAIL_INSTALL_ID,
          action_name: 'send_email',
          input: { to: [effectiveEmail], subject: emailSubject, body: bodyForDraft },
        });
        gmailDraftId = String((dr as any)?.draft_id ?? '').trim();
        console.log(`  Gmail draft created: ${gmailDraftId}`);
      } catch (e) { console.log(`  Gmail draft error: ${e}`); }
    }

    const docLinksJson = generatedDocs.length > 0 ? JSON.stringify(generatedDocs) : '';

    await brains.append_board_rows({
      board_id: PROSPECTOR, dataset: 'outreach_queue',
      rows: [{
        id: newOqId, lead_id: effectiveLeadId, lead_name: effectiveName,
        company: effectiveCompany, channel: 'email', lead_linkedin_id: '',
        lead_email: effectiveEmail, follow_up_number: '10', status: 'pending_approval',
        body: emailBody, subject: emailSubject, original_body: emailBody,
        draft_id: gmailDraftId, approval_outcome: '', edit_instruction: '',
        got_response: '', response_days: '', response_channel: '',
        gmail_thread_id: '', telegram_msg_id: '',
        tq_row_id: queueRowId,
        doc_links: docLinksJson,
        created_at: now,
      }],
    });
    await updateOqCounter(oqCounter);

    // Seed FU chain
    let fuChains: any[] = [];
    try { fuChains = JSON.parse(String(fuChainsRow?.value ?? '[]')); } catch {}
    if (!Array.isArray(fuChains)) fuChains = [];
    fuChains.push({
      oqId: newOqId, leadId: effectiveLeadId, leadName: effectiveName,
      leadEmail: effectiveEmail, company, nextFuNumber: 11,
      testMode: isTest, createdAt: now,
    });
    if (fuChainsRow?.row_id) {
      await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'meta', row_id: String(fuChainsRow.row_id), patch: { value: JSON.stringify(fuChains) } });
    } else {
      await brains.append_board_rows({ board_id: PROSPECTOR, dataset: 'meta', rows: [{ key: 'pending_fu_chains', value: JSON.stringify(fuChains) }] });
    }

    await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'transcript_queue', row_id: queueRowId, patch: { processed: 'staged', processed_at: now } });
    console.log(`Phase 1 done: "${meeting_title}" -> ${newOqId} (${generatedDocs.length} doc(s))${gmailDraftId ? ` (draft: ${gmailDraftId.slice(0,8)}...)` : ' (no draft)'}${isTest ? ' [TEST]' : ''}`);
  }

  // ── PHASE 1.5: sent OQ-10 rows -> CRM log -> crm_draft + Telegram ──

  const freshOqB = await brains.get_board({ board_id: PROSPECTOR, dataset: 'outreach_queue', limit: 2000 });
  const freshOqRows = (freshOqB as any)?.data?.datasets?.outreach_queue?.rows ?? [];

  const sentFu10 = freshOqRows.filter((r: any) =>
    String(r.follow_up_number ?? '') === '10' &&
    r.status === 'sent' &&
    String(r.tq_row_id ?? '').length > 0
  );

  const draftedOqIds = new Set(crmDraftRows.map((d: any) => String(d.follow_up_oq_id ?? '')));
  const needsDraft = sentFu10.filter((r: any) => !draftedOqIds.has(String(r.id ?? '')));

  console.log(`Phase 1.5: ${sentFu10.length} sent OQ-10 rows, ${needsDraft.length} need CRM draft.`);

  for (const oq of needsDraft) {
    const oqId         = String(oq.id ?? '');
    const tqRowId      = String(oq.tq_row_id ?? '');
    const oqCompany    = String(oq.company ?? '').replace(/^TEST-/, '');
    const emailBody    = String(oq.body ?? '');
    const emailSubject = String(oq.subject ?? '');
    const docLinks     = String(oq.doc_links ?? '');
    const isTest       = String(oq.lead_name ?? '').startsWith('TEST-');
    const now          = new Date().toISOString();

    const tqRow = queueRows.find((r: any) => String(r.row_id ?? '') === tqRowId);
    if (!tqRow) { console.log(`Phase 1.5: transcript row ${tqRowId} not found for ${oqId} -- skipping.`); continue; }

    const meeting_title      = String(tqRow.meeting_title ?? '');
    const tqDate             = String(tqRow.tq_date ?? '');
    const external_attendees = String(tqRow.external_attendees ?? '');
    const transcript         = String(tqRow.transcript ?? '');

    const boardLead    = findBoardLead(oqCompany);
    const daResearch   = String(boardLead?.da_research ?? '').trim();
    const productCases = String(boardLead?.product_use_cases ?? boardLead?.ethera_use_cases ?? '').trim();

    const researchBlock = [
      daResearch   ? `Company research:\n${daResearch.slice(0, 1500)}`                                                           : '',
      productCases ? `${PRODUCT_NAME ? PRODUCT_NAME + ' use cases' : 'Product use cases'}:\n${productCases.slice(0, 800)}` : '',
    ].filter(Boolean).join('\n\n');

    const docLinksBlock = docLinks ? (() => {
      try {
        const links = JSON.parse(docLinks) as Array<{title: string, url: string}>;
        return links.length > 0 ? `\nMaterials shared in follow-up email:\n${links.map(d => `- ${d.title}: ${d.url}`).join('\n')}` : '';
      } catch { return ''; }
    })() : '';

    let crmUpdate: any = null;
    try {
      const llmOut = await brains.llm({
        prompt: `Generate a CRM activity log for a completed meeting and follow-up email.\n\nMeeting: ${meeting_title}\nDate: ${tqDate}\nCompany: ${oqCompany}\nAttendees: ${external_attendees}\n\nMeeting transcript:\n${transcript.slice(0, 5000)}\n\nFollow-up email sent:\nSubject: ${emailSubject}\nBody: ${emailBody.slice(0, 600)}\n${docLinksBlock}\n\n${researchBlock}\n\nReturn ONLY valid JSON (no preamble):\n{\n  "meetingNotes": "2-4 sentences: what was discussed, key signals, reactions",\n  "outcome": "1-2 sentences: where things stand and that follow-up email was sent${docLinksBlock ? ' with materials' : ''}",\n  "nextSteps": "Specific next steps agreed (include awaiting reply to follow-up email)",\n  "updateText": "Full paragraph for CRM activity log. Include that a follow-up email was sent${docLinksBlock ? ' with [specific materials]' : ''}. No bullet points. No em dashes. Under 200 words.",\n  "suggestedStatus": null or one of: "Viable lead" | "Working on it" | "Contacted" | "Meeting scheduled" | "In negotiation" | "Closed" | "Lost",\n  "telegramSummary": "2-3 sentences starting with company name. No em dashes."\n}`,
        max_tokens: 900,
      });
      const txt = String((llmOut as any)?.text ?? llmOut ?? '');
      const match = txt.match(/\{[\s\S]*\}/);
      if (match) crmUpdate = JSON.parse(match[0]);
    } catch (e) {
      console.log(`Phase 1.5 LLM error for ${oqId}: ${e}`);
      continue;
    }
    if (!crmUpdate) { console.log(`Phase 1.5 LLM parse failed for ${oqId}`); continue; }

    draftCounter++;
    const newDraftId = `CD-${String(draftCounter).padStart(4, '0')}`;

    await brains.append_board_rows({
      board_id: PROSPECTOR, dataset: 'crm_draft',
      rows: [{
        draft_id: newDraftId, cd_meeting_title: meeting_title, cd_date: tqDate,
        cd_company: oqCompany, company_id: '',
        lead_name: String(oq.lead_name ?? '').replace(/^TEST-/, ''),
        lead_id: String(oq.lead_id ?? '').replace(/^TEST-/, ''),
        meeting_notes: String(crmUpdate.meetingNotes ?? ''),
        outcome: String(crmUpdate.outcome ?? ''),
        next_steps: String(crmUpdate.nextSteps ?? ''),
        update_text: String(crmUpdate.updateText ?? ''),
        suggested_status: String(crmUpdate.suggestedStatus ?? ''),
        follow_up_oq_id: oqId, status: 'pending',
        cd_test_mode: isTest ? 'true' : 'false', cd_created_at: now, committed_at: '',
      }],
    });
    await updateDraftCounter(draftCounter);

    const tgMsg = [
      `CRM Draft | ${newDraftId}${isTest ? ' [TEST]' : ''}`,
      `Meeting: ${meeting_title}`,
      `Company: ${oqCompany}`,
      `Follow-up email: ${oqId} (sent)`,
      '',
      String(crmUpdate.telegramSummary ?? ''),
      `Suggested status: ${crmUpdate.suggestedStatus ?? 'no change'}`,
      '', '---',
      `crm approve ${newDraftId} | crm skip ${newDraftId}`,
    ].filter(Boolean).join('\n');
    await brains.telegram_push({ text: tgMsg.slice(0, 4096) });

    console.log(`Phase 1.5: ${oqId} -> ${newDraftId} (${oqCompany})`);
  }

  // ── PHASE 2: detect crm approve/skip from chat_session pages ──

  const freshDraftB2 = await brains.get_board({ board_id: PROSPECTOR, dataset: 'crm_draft', limit: 100 });
  const freshDraftRows2 = (freshDraftB2 as any)?.data?.datasets?.crm_draft?.rows ?? [];
  const pendingDraftCount = freshDraftRows2.filter((r: any) => r.status === 'pending').length;
  console.log(`Phase 2: ${pendingDraftCount} draft(s) awaiting approval.`);

  if (pendingDraftCount > 0) {
    let cmdPages: any[] = [];
    try {
      const cmdSearch = await brains.search({ q: 'crm approve crm skip', type: 'chat_session', limit: 20 });
      cmdPages = (cmdSearch as any)?.results ?? [];
    } catch (e) { console.log(`Phase 2 search error: ${e}`); }

    const windowStart = Date.now() - CMD_WINDOW_MS;
    for (const page of cmdPages) {
      const pageMs = new Date(String(page.updated_at ?? page.created_at ?? '')).getTime();
      if (isNaN(pageMs) || pageMs < windowStart) continue;

      const text = String(page.text ?? page.body ?? page.content ?? page.title ?? '');
      for (const m of [...text.matchAll(/crm\s+approve\s+(CD-\d+)/gi)]) {
        const draftId = m[1].toUpperCase();
        const dr = freshDraftRows2.find((r: any) => String(r.draft_id ?? '') === draftId && r.status === 'pending');
        if (dr?.row_id) {
          await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'crm_draft', row_id: String(dr.row_id), patch: { status: 'approved' } });
          console.log(`Approved: ${draftId}`);
        }
      }
      for (const m of [...text.matchAll(/crm\s+skip\s+(CD-\d+)/gi)]) {
        const draftId = m[1].toUpperCase();
        const dr = freshDraftRows2.find((r: any) => String(r.draft_id ?? '') === draftId && r.status === 'pending');
        if (dr?.row_id) {
          await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'crm_draft', row_id: String(dr.row_id), patch: { status: 'skipped' } });
          console.log(`Skipped: ${draftId}`);
        }
      }
    }
  }

  // ── PHASE 3: write approved drafts directly to CRM board ──

  const freshDraftB3 = await brains.get_board({ board_id: PROSPECTOR, dataset: 'crm_draft', limit: 100 });
  const approvedDrafts = ((freshDraftB3 as any)?.data?.datasets?.crm_draft?.rows ?? []).filter((r: any) => r.status === 'approved');
  console.log(`Phase 3: ${approvedDrafts.length} approved draft(s) to write to CRM.`);

  if (approvedDrafts.length > 0) {
    const [crmCompB, crmLeadsB, crmMeetB] = await Promise.all([
      brains.get_board({ board_id: CRM_BOARD_ID, dataset: 'companies', limit: 200 }),
      brains.get_board({ board_id: CRM_BOARD_ID, dataset: 'leads',     limit: 200 }),
      brains.get_board({ board_id: CRM_BOARD_ID, dataset: 'meetings',  limit: 200 }),
    ]);
    const crmCompanies = ((crmCompB as any)?.data?.datasets?.companies?.rows ?? []) as any[];
    const crmLeads2    = ((crmLeadsB as any)?.data?.datasets?.leads?.rows     ?? []) as any[];
    const crmMeetings  = ((crmMeetB as any)?.data?.datasets?.meetings?.rows   ?? []) as any[];

    let maxMT = crmMeetings.reduce((max: number, r: any) => {
      const n = parseInt(String(r.row_id ?? '').replace('MT-', ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);

    for (const draft of approvedDrafts) {
      const now = new Date().toISOString();
      const { row_id: draftRowId, draft_id, cd_meeting_title, cd_date, cd_company,
              company_id, lead_id, lead_name, meeting_notes, outcome, next_steps,
              update_text, suggested_status, cd_test_mode } = draft;
      const isTest = String(cd_test_mode ?? '') === 'true';

      // Match company: by ID first, then fuzzy name
      let crmCo = company_id
        ? crmCompanies.find((c: any) => String(c.row_id ?? '') === String(company_id ?? ''))
        : null;
      if (!crmCo) {
        const nl = String(cd_company ?? '').toLowerCase().trim().replace(/^test-/i, '');
        crmCo = nl ? crmCompanies.find((c: any) => {
          const cn = String(c.name ?? '').toLowerCase().trim();
          return cn && (cn.includes(nl) || nl.includes(cn));
        }) : null;
      }
      if (!crmCo) {
        console.log(`  ${draft_id}: no company match for "${cd_company}" — skipping.`);
        await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'crm_draft', row_id: String(draftRowId),
          patch: { status: 'error', error: `no CRM company match: ${cd_company}` } });
        continue;
      }

      // Match lead: by ID first, then fuzzy name
      let crmLead2 = lead_id
        ? crmLeads2.find((l: any) => String(l.row_id ?? '') === String(lead_id ?? ''))
        : null;
      if (!crmLead2 && lead_name) {
        const nl = String(lead_name ?? '').toLowerCase().trim().replace(/^test-/i, '');
        crmLead2 = nl ? crmLeads2.find((l: any) => {
          const ln = String(l.name ?? '').toLowerCase().trim();
          return ln && (ln.includes(nl) || nl.includes(ln));
        }) : null;
      }

      // Dedup meeting by title + date
      const existing = crmMeetings.find((m: any) =>
        String(m.title ?? '').toLowerCase().trim() === String(cd_meeting_title ?? '').toLowerCase().trim() &&
        String(m.date  ?? '').slice(0, 10) === String(cd_date ?? '').slice(0, 10)
      );

      let meetingId = existing?.row_id ?? '';

      if (existing) {
        console.log(`  ${draft_id}: meeting already exists (${meetingId}) — skipping write.`);
      } else {
        maxMT++;
        meetingId = `MT-${String(maxMT).padStart(4, '0')}`;
        try {
          await brains.append_board_rows({
            board_id: CRM_BOARD_ID, dataset: 'meetings',
            rows: [{
              row_id: meetingId,
              title: cd_meeting_title, date: cd_date, company: cd_company,
              format: 'Video', attendees: crmLead2 ? [crmLead2.name] : [],
              notes: String(meeting_notes ?? ''), outcome: String(outcome ?? ''),
              next_steps: String(next_steps ?? ''), company_id: String(crmCo.row_id ?? ''),
            }],
          });
          console.log(`  ${draft_id}: meeting ${meetingId} written to CRM.`);
        } catch (e) {
          console.log(`  ${draft_id}: meeting write error: ${e} — skipping.`);
          continue;
        }
      }

      // Update company notes + status
      try {
        const existingNotes = String(crmCo.notes ?? '').trim();
        const compPatch: any = {
          notes: (existingNotes ? `${existingNotes}\n\n[${cd_date}] ${update_text}` : `[${cd_date}] ${update_text}`).slice(0, 10000),
          last_meeting: cd_date,
        };
        if (suggested_status) compPatch.status = suggested_status;
        await brains.update_board_row({ board_id: CRM_BOARD_ID, dataset: 'companies', row_id: String(crmCo.row_id), patch: compPatch });
        console.log(`  ${draft_id}: company updated.`);
      } catch (e) { console.log(`  ${draft_id}: company update error: ${e}`); }

      // Update lead notes + last_contact
      if (crmLead2?.row_id) {
        try {
          const leadNotes = String(crmLead2.notes ?? '').trim();
          await brains.update_board_row({
            board_id: CRM_BOARD_ID, dataset: 'leads', row_id: String(crmLead2.row_id),
            patch: {
              notes: (leadNotes ? `${leadNotes}\n\n[${cd_date}] ${update_text}` : `[${cd_date}] ${update_text}`).slice(0, 10000),
              last_contact: cd_date,
            },
          });
          console.log(`  ${draft_id}: lead updated.`);
        } catch (e) { console.log(`  ${draft_id}: lead update error: ${e}`); }
      }

      // Mark synced immediately (no local runner needed)
      await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'crm_draft', row_id: String(draftRowId),
        patch: { status: 'synced', meeting_id: meetingId, synced_at: now } });
      await brains.telegram_push({ text: `CRM Updated | ${draft_id}${isTest ? ' [TEST]' : ''}\n${cd_meeting_title}\n${cd_company} -> ${meetingId}` });
      console.log(`  ${draft_id} -> ${meetingId} synced.`);
    }
  }

  // ── PHASE 4: FU chain (FU11/12/13 at 3/5/7 days) ──

  let fuChains2: any[] = [];
  try { fuChains2 = JSON.parse(String(fuChainsRow?.value ?? '[]')); } catch {}
  if (!Array.isArray(fuChains2) || fuChains2.length === 0) {
    console.log('Phase 4: No FU chains pending.');
    return;
  }

  console.log(`Phase 4: ${fuChains2.length} FU chain(s).`);
  const nowMs = Date.now();
  const updatedChains: any[] = [];

  for (const entry of fuChains2) {
    const { oqId, leadId, leadName, leadEmail, company, nextFuNumber, testMode: entryTest } = entry;
    if (nextFuNumber > 13) continue;

    const prevRow = freshOqRows.find((r: any) => String(r.id ?? '') === oqId);
    if (!prevRow) continue;
    if (prevRow.status === 'discarded') continue;
    if (prevRow.status !== 'sent') { updatedChains.push(entry); continue; }

    const daysElapsed = (nowMs - new Date(String(prevRow.created_at ?? '')).getTime()) / 86400000;
    const required = FU_DAYS[nextFuNumber] ?? 3;
    if (daysElapsed < required) { updatedChains.push(entry); continue; }

    const existing = freshOqRows.find((r: any) =>
      String(r.company ?? '').replace(/^TEST-/, '').toLowerCase() === String(company ?? '').toLowerCase() &&
      String(r.follow_up_number ?? '') === String(nextFuNumber) &&
      r.status !== 'discarded'
    );
    if (existing) {
      updatedChains.push({ ...entry, oqId: existing.id, nextFuNumber: nextFuNumber + 1 }); continue;
    }

    const linkedDraft = crmDraftRows.find((d: any) => String(d.follow_up_oq_id ?? '') === oqId);
    const meetingNotes = String(linkedDraft?.meeting_notes ?? '');
    const outcome      = String(linkedDraft?.outcome ?? '');
    const nextSteps    = String(linkedDraft?.next_steps ?? '');

    const fuLabel = nextFuNumber === 11 ? 'first' : nextFuNumber === 12 ? 'second' : 'third and final';
    const firstName = String(leadName ?? '').trim().replace(/^TEST-/, '').split(/\s+/)[0];

    let fuBody = '';
    try {
      const fuIdentityCtx = SENDER_IDENTITY ? `You are ${SENDER_IDENTITY}${PRODUCT_CONTEXT ? ` (${PRODUCT_CONTEXT})` : ''}.` : PRODUCT_CONTEXT ? `You are a BD professional (${PRODUCT_CONTEXT}).` : 'You are a BD professional.';
      const fuSignOff = SENDER_NAME ? `Best,\\n${SENDER_NAME}` : 'Best,\\n[Your name]';
      const fuOut = await brains.llm({
        prompt: `${fuIdentityCtx} Write a ${fuLabel} follow-up email to ${leadName} at ${company}.${meetingNotes ? ` Context from meeting: ${meetingNotes}` : ''}${outcome ? ` Outcome: ${outcome}` : ''}${nextSteps ? ` Next steps: ${nextSteps}` : ''} ${nextFuNumber === 13 ? 'This is the final touch -- very short, warm, no pressure.' : 'Keep it short and warm.'} Start: Hi ${firstName}, End: ${fuSignOff}. 60-100 words. No em dashes. No bullet points.`,
        max_tokens: 200,
      });
      fuBody = String((fuOut as any)?.text ?? fuOut ?? '').trim();
    } catch (e) { updatedChains.push(entry); continue; }
    if (!fuBody) { updatedChains.push(entry); continue; }

    oqCounter++;
    const fuOqId = `OQ-${String(oqCounter).padStart(4, '0')}`;
    const effectiveEmail2   = entryTest ? TEST_EMAIL : leadEmail;
    const effectiveName2    = entryTest ? `TEST-${leadName}` : leadName;
    const effectiveCompany2 = entryTest ? `TEST-${company}` : company;

    const threadId = String(
      freshOqRows
        .filter((r: any) => String(r.lead_email ?? '') === String(leadEmail ?? '') && r.status === 'sent' && String(r.gmail_thread_id ?? '').trim().length > 5)
        .sort((a: any, b: any) => new Date(String(b.created_at ?? 0)).getTime() - new Date(String(a.created_at ?? 0)).getTime())
        [0]?.gmail_thread_id ?? ''
    ).trim();

    await brains.append_board_rows({
      board_id: PROSPECTOR, dataset: 'outreach_queue',
      rows: [{
        id: fuOqId, lead_id: entryTest ? `TEST-${leadId}` : leadId,
        lead_name: effectiveName2, company: effectiveCompany2,
        channel: 'email', lead_linkedin_id: '',
        lead_email: effectiveEmail2, follow_up_number: String(nextFuNumber),
        status: 'pending_approval', body: fuBody,
        subject: threadId ? '' : `Re: Following up: ${PRODUCT_NAME ? PRODUCT_NAME + ' x ' : ''}${company}`,
        original_body: fuBody, draft_id: '',
        approval_outcome: '', edit_instruction: '', got_response: '',
        response_days: '', response_channel: '',
        gmail_thread_id: threadId, telegram_msg_id: '', tq_row_id: '',
        created_at: new Date().toISOString(),
      }],
    });
    await updateOqCounter(oqCounter);
    console.log(`FU${nextFuNumber - 10} created: ${fuOqId} for ${company}.`);

    if (nextFuNumber < 13) updatedChains.push({ ...entry, oqId: fuOqId, nextFuNumber: nextFuNumber + 1 });
  }

  if (fuChainsRow?.row_id) {
    await brains.update_board_row({ board_id: PROSPECTOR, dataset: 'meta', row_id: String(fuChainsRow.row_id), patch: { value: JSON.stringify(updatedChains) } });
  }

  console.log('agent4-crm-updater v8 complete.');
}
await main();
