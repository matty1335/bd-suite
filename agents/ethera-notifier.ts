// ============================================================
// Ethera Notifier
// Brains automation ID: 2329780a-7df5-4cca-be17-20eb9e773001
// Version: 1 (frozen)
// Cron: * * * * * (every minute)
// Description: Reads notification_queue meta row, fires telegram_push for each message.
//              Bridge for local scripts (agent4-local.mjs) that cannot call telegram_push directly.
// ============================================================

// ETHERA NOTIFIER v1
// Cron: every minute
// Reads notification_queue from board meta, fires telegram_push for each message, clears queue.
// Used by local scripts (agent4-crm-updater.mjs) that cannot call telegram_push directly
// (telegram_push is restricted to brains automation sandboxes).

const BOARD_ID = "95dcb668-e2d9-4093-9a3e-3200901846fa";

function getBoardRows(board: unknown, dataset: string): Record<string, unknown>[] {
  if (!board || typeof board !== "object") return [];
  const b = board as Record<string, unknown>;
  const data = b.data as Record<string, unknown> | undefined;
  const datasets = data?.datasets as Record<string, unknown> | undefined;
  const ds = datasets?.[dataset] as Record<string, unknown> | undefined;
  return (ds?.rows as Record<string, unknown>[]) ?? [];
}

async function main() {
  const metaBoard = await brains.boards.get(BOARD_ID, { dataset: "meta", limit: 200 });
  const metaRows = getBoardRows(metaBoard, "meta");

  const queueRow = metaRows.find(r => String(r.key ?? "") === "notification_queue");
  if (!queueRow) {
    console.log("No notification_queue row — nothing to do.");
    return;
  }

  let queue: string[] = [];
  try {
    const val = queueRow.value;
    if (typeof val === "string") {
      queue = JSON.parse(val);
    } else if (Array.isArray(val)) {
      queue = (val as unknown[]).map(String);
    }
  } catch {
    console.log("Failed to parse notification_queue — skipping.");
    return;
  }

  if (queue.length === 0) return;

  console.log(`${queue.length} notification(s) queued.`);

  // Clear queue BEFORE sending — prevents double-send if telegram_push errors mid-loop
  await brains.update_board_row({
    board_id: BOARD_ID,
    dataset: "meta",
    row_id: String(queueRow.row_id),
    patch: { value: "[]" },
  });

  for (const msg of queue) {
    try {
      await brains.telegram_push({ text: String(msg).slice(0, 4096) });
      console.log(`Sent: ${String(msg).slice(0, 60)}`);
    } catch (e) {
      console.log(`telegram_push error: ${String(e).slice(0, 80)}`);
    }
  }

  console.log("Ethera Notifier v1 done.");
}

await main();
