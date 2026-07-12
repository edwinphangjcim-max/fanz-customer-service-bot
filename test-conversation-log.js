// test-conversation-log.js — REAL DB probe for logConversation().
// Inserts a user+assistant pair into the real conversations table via the
// exported writer, reads them back, verifies fields, then DELETES them.
// Uses a sentinel chat_id so nothing real is touched. Self-cleaning.
//
// Run: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node test-conversation-log.js
process.env.SKIP_BOT_INIT = "1";
const bot = require("./index.js");

const SU = process.env.SUPABASE_URL;
const SK = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: SK, Authorization: `Bearer ${SK}`, "Content-Type": "application/json" };
const CHAT = "TEST_CONVLOG_" + "sentinel"; // sentinel; deleted at end

async function q(path, opts = {}) {
  const r = await fetch(`${SU}/rest/v1/${path}`, { headers: H, ...opts });
  const t = await r.text();
  return { status: r.status, body: t ? JSON.parse(t) : null };
}

(async () => {
  if (!SU || !SK) { console.error("need SUPABASE_URL + SUPABASE_SERVICE_KEY"); process.exit(1); }
  console.log("cleanup any stale sentinel rows...");
  await q(`conversations?chat_id=eq.${CHAT}`, { method: "DELETE" });

  console.log("writing user + assistant via logConversation()...");
  await bot.logConversation(CHAT, "user", "hi my Fanz fan motor not working can claim warranty?", {
    intent: "repair", messageType: "text", senderName: "Test Customer",
  });
  await bot.logConversation(CHAT, "assistant", "Sure, could you share the invoice number or a photo of the invoice?", {
    aiModel: "gpt-4o", intent: "WORKORDER_READY",
  });

  // small wait for fire-and-forget inserts to land
  await new Promise((r) => setTimeout(r, 1500));

  const { body: rows } = await q(`conversations?chat_id=eq.${CHAT}&order=created_at.asc&select=*`);
  console.log(`\nrows read back: ${rows ? rows.length : 0}`);
  let pass = 0, fail = 0;
  const t = (c, m) => c ? (pass++, console.log("  PASS:", m)) : (fail++, console.error("  FAIL:", m));

  t(Array.isArray(rows) && rows.length === 2, "exactly 2 rows inserted (user + assistant)");
  if (rows && rows.length === 2) {
    const [u, a] = rows;
    console.log("\n  USER row:", JSON.stringify(u));
    console.log("  ASSISTANT row:", JSON.stringify(a));
    t(u.role === "user" && a.role === "assistant", "roles: user then assistant");
    t(u.content.includes("motor not working"), "user content = full original text (not a summary)");
    t(a.content.includes("invoice number"), "assistant content = full reply text");
    t(!!u.chat_id && u.chat_id === CHAT, "chat_id present + correct");
    t(!!u.created_at && !!a.created_at, "created_at present on both");
    t(u.intent === "repair", "user intent recorded");
    // Extended columns: present only after the ALTER TABLE migration ran.
    const hasExtended = "platform" in u;
    if (hasExtended) {
      t(u.platform === "telegram", "platform=telegram (extended cols LIVE)");
      t(u.sender_name === "Test Customer", "user sender_name recorded");
      t(a.ai_model_used === "gpt-4o", "assistant ai_model_used recorded");
      t(u.message_type === "text", "message_type recorded");
    } else {
      console.log("  NOTE: extended columns (platform/sender_name/message_type/ai_model_used) NOT present yet");
      console.log("        -> writer correctly fell back to base columns. Run the ALTER TABLE, re-run to verify full fields.");
    }
  }

  console.log("\ncleaning up sentinel rows...");
  const del = await q(`conversations?chat_id=eq.${CHAT}`, { method: "DELETE" });
  const { body: after } = await q(`conversations?chat_id=eq.${CHAT}&select=id`);
  t(Array.isArray(after) && after.length === 0, `cleanup complete (0 rows remain, delete status ${del.status})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
