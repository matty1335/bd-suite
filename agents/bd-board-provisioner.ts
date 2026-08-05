// bd-board-provisioner v4
// Checks for newly created campaigns without a prospector board and provisions one.
// Runs every 5 minutes. Board creation tried via TS API first, then REST fallback.

const VERSION = "v2";
const CC_BOARD_ID = "{{cc_board_id}}";
const BRAIN_ID = "{{brain_id}}";

async function main() {
  console.log(`[bd-board-provisioner ${VERSION}] starting`);

  let ccRows: Record<string, any>[] = [];
  try {
    const ccBoard = await brains.boards.get(CC_BOARD_ID, {dataset: "meta", limit: 20});
    ccRows = (ccBoard?.datasets?.meta?.rows ?? ccBoard?.data?.datasets?.meta?.rows ?? []) as Record<string, any>[];
  } catch (e) {
    console.log(`Failed to read CC board: ${String(e).slice(0, 80)}`);
    return;
  }

  const configRow = ccRows.find((r: Record<string, any>) => String(r.key) === "agent_config");
  if (!configRow) {
    console.log("agent_config row not found -- nothing to do");
    return;
  }

  let agentConfig: {campaigns?: Record<string, any>[]; active_campaign_id?: string} = {};
  try {
    agentConfig = JSON.parse(String(configRow.value ?? "{}"));
  } catch {
    console.log("Failed to parse agent_config JSON");
    return;
  }

  const campaigns = agentConfig.campaigns ?? [];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const needsBoard = campaigns.filter((c: Record<string, any>) => {
    if (c.prospector_board_id && String(c.prospector_board_id).trim()) return false;
    const created = c.created_at ? String(c.created_at) : "";
    return !created || created >= sevenDaysAgo;
  });

  if (needsBoard.length === 0) {
    console.log("No campaigns need provisioning");
    return;
  }

  console.log(`Provisioning boards for ${needsBoard.length} campaign(s)`);
  let changed = false;

  for (const campaign of needsBoard) {
    const name = String(campaign.name ?? "Campaign");
    console.log(`Provisioning: ${name}`);
    let boardId = "";

    // Attempt 1: brains TS API (works if install_recipe is exposed in automation context)
    try {
      const r = await (brains as any).install_recipe({slug: "bd-prospector-board", brain_id: BRAIN_ID});
      boardId = String(r?.board_id ?? r?.id ?? r?.result?.board_id ?? "");
      if (boardId) console.log(`TS install_recipe ok: ${boardId}`);
    } catch (e1) {
      console.log(`TS install_recipe unavailable: ${String(e1).slice(0, 80)}`);

      // Attempt 2: REST API with user token
      try {
        const r = await brains.http_fetch({
          url: "https://app.mybrains.ai/api/v1/recipes/bd-prospector-board/install",
          method: "POST",
          headers: {"Authorization": "Bearer {{brains_user_token}}", "Content-Type": "application/json"},
          body: JSON.stringify({brain_id: BRAIN_ID})
        });
        if (r.ok) {
          const d = r.json as Record<string, any>;
          boardId = String(d?.board_id ?? d?.id ?? d?.result?.board_id ?? "");
          if (boardId) console.log(`REST install_recipe ok: ${boardId}`);
          else console.log(`REST unexpected response: ${JSON.stringify(r.json)}`);
        } else {
          console.log(`REST install_recipe HTTP ${r.status}: ${JSON.stringify(r.json)}`);
        }
      } catch (e2) {
        console.log(`REST error: ${String(e2).slice(0, 80)}`);
      }
    }

    if (!boardId) {
      console.log(`Skipping "${name}" -- board creation failed, will retry next run`);
      continue;
    }

    campaign.prospector_board_id = boardId;
    changed = true;
    console.log(`[OK] "${name}" -> ${boardId}`);
    try {
      await brains.telegram_push({text: `[BD Suite] Prospector board provisioned for campaign "${name}": ${boardId}`});
    } catch {}
  }

  if (changed) {
    const rowId = String(configRow.row_id ?? configRow.id ?? "");
    if (!rowId) {
      console.log("Could not get agent_config row_id -- cannot save");
      return;
    }
    await brains.update_board_row({
      board_id: CC_BOARD_ID,
      dataset: "meta",
      row_id: rowId,
      patch: {value: JSON.stringify(agentConfig)}
    });
    console.log("Saved updated agent_config");
  }
}

await main();
