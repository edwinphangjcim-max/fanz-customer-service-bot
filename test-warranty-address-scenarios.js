// test-warranty-address-scenarios.js — REAL LLM test of the two fixes.
// Drives the actual processCustomerText pipeline with the real OpenRouter model
// and real system prompt (same path a live Telegram message takes), capturing
// what the bot actually replies. No SUPABASE set → no DB writes, no conversation
// logging, no work-order insert; pure conversation behaviour.
//
// Run: OPENROUTER_API_KEY=... node test-warranty-address-scenarios.js
process.env.SKIP_BOT_INIT = "1";
const bot = require("./index.js");

async function turn(chatId, text) {
  bot.__clearSent();
  await bot.processCustomerText(chatId, text);
  const replies = bot.__getSent()
    .map((s) => s.text.split("\n").filter((l) => !l.includes("||DATA||")).join("\n").trim())
    .filter(Boolean)
    .join("\n");
  console.log(`  Customer: ${text}`);
  console.log(`  Fann    : ${replies || "(no reply)"}\n`);
  return replies;
}

(async () => {
  if (!process.env.OPENROUTER_API_KEY) { console.error("need OPENROUTER_API_KEY"); process.exit(1); }
  let pass = 0, fail = 0;
  const t = (c, m) => c ? (pass++, console.log("  PASS:", m)) : (fail++, console.error("  FAIL:", m));

  // ── Scenario 1: customer guesses their own warranty status ──
  console.log("============================================");
  console.log("SCENARIO 1 — customer guesses 'still under warranty' (fix #1)");
  console.log("============================================");
  const c1 = 700001;
  await turn(c1, "hi, my Fanz fan motor not spinning");
  const r1 = await turn(c1, "i think i still under warranty");
  const low1 = r1.toLowerCase();
  t(/verify|confirm.*invoice|核实|核对|发票|check on site|technician.*check|verify invoice/i.test(r1),
    "reply decouples: warranty only confirmed after invoice verified");
  t(!/let'?s proceed|proceed with|arrange the free|since you'?re under warranty|按保修安排|好的.*安排/i.test(low1),
    "reply does NOT imply warranty accepted (no 'proceed'/'free'/default-approve wording)");

  // ── Scenario 2: customer says the address is on the invoice ──
  console.log("============================================");
  console.log("SCENARIO 2 — 'follow the invoice, got my address' (fix #2)");
  console.log("============================================");
  const c2 = 700002;
  await turn(c2, "my Fanz Inno fan remote not working");
  await turn(c2, "the remote cannot control the fan");
  await turn(c2, "invoice number FZ12345");
  const r2 = await turn(c2, "follow the invoice, got my address");
  t(/address|type|alamat|地址/i.test(r2) && !/^okay,? let'?s proceed/i.test(r2.trim()),
    "bot asks the customer to type the full address (does not accept 'on the invoice')");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
