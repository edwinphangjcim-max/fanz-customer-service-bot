// ============================================
// test-warranty-verdict.js — 端到端：发票号 → 保修判定到客户面（钱路径）
//
// 这是最关键的钱路径:客户给发票号 → lookupInvoice 命中 sales_records →
// calcWarrantyStatus → bot 真的跟客户说"在保/过保 + 收费" + 免责。
//
// 做法:种 2 条划痕 sales_record(一近一远)→ 走完整 LINE B 对话让 LLM
// 出 DATA marker → 捕获判定消息断言 → 清理划痕(sales_record + work_order)。
//
// 需要 OPENROUTER_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY。
// 划痕数据零真实 PII(地址填假的)。跑完自清理。
// ============================================

process.env.SKIP_BOT_INIT = "1";
const bot = require("./index.js");

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}`, "Content-Type": "application/json" };

let pass = 0, fail = 0;
const t = (cond, msg) => { cond ? (pass++, console.log(`  PASS: ${msg}`)) : (fail++, console.error(`  FAIL: ${msg}`)); };

async function seedRecord(rec) {
  const r = await fetch(`${U}/rest/v1/sales_records`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(rec) });
  if (!r.ok) throw new Error(`seed failed ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json())[0];
}
async function del(table, col, val) {
  await fetch(`${U}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`, { method: "DELETE", headers: H }).catch(() => {});
}

// 走 LINE B:逐条给足 5 项,让 LLM 收齐后出 marker。返回捕获的全部消息文本。
async function runIntake(chatId, invoiceNo) {
  bot.__clearSent();
  const turns = [
    "Hi, my Fanz FS 563L ceiling fan is not working",
    "the motor is not spinning at all",
    `invoice number ${invoiceNo}`,
    "12 Test Street, Johor Bahru",   // 假地址,无真实 PII
    "this Saturday morning please",
  ];
  for (const msg of turns) await bot.processCustomerText(chatId, msg);
  // 若还没出判定,补几句推动
  for (let i = 0; i < 4; i++) {
    const joined = bot.__getSent().map((s) => s.text).join("\n");
    if (/保修|warranty|在保|过|expired|in warranty/i.test(joined)) break;
    await bot.processCustomerText(chatId, "yes please arrange for me");
  }
  return bot.__getSent().map((s) => s.text).join("\n===\n");
}

(async () => {
  if (!process.env.OPENROUTER_API_KEY || !U || !K) {
    console.log("SKIP: need OPENROUTER_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_KEY");
    process.exit(0);
  }

  const IN_INV = "SCRATCH-WARR-IN-001";
  const OUT_INV = "SCRATCH-WARR-OUT-001";
  const inChat = 970001, outChat = 970002;

  try {
    // 近期购买(Fanz 马达 10 年 → 在保)
    await seedRecord({ invoice_number: IN_INV, model: "FS 563L", purchase_date: "2024-06-01", customer_name: "TESTONLY", onsite_warranty_years: 2 });
    // 早年购买(2013 → 10 年已过)
    await seedRecord({ invoice_number: OUT_INV, model: "FS 563L", purchase_date: "2013-01-01", customer_name: "TESTONLY", onsite_warranty_years: 1 });

    console.log("[IN-WARRANTY] Fanz FS563L bought 2024, motor issue");
    const rIn = await runIntake(inChat, IN_INV);
    t(/在保|10\s*年|in warranty|still|covered/i.test(rIn) && !/5\s*年|vioz/i.test(rIn), "IN: 判为在保、10年、非 Vioz");
    t(/以最新官方政策为准|师傅上门确认/.test(rIn), "IN: 带政策免责/师傅上门确认");

    console.log("[OUT-OF-WARRANTY] Fanz FS563L bought 2013, motor issue");
    const rOut = await runIntake(outChat, OUT_INV);
    t(/过了|已经过|expired|out of warranty|过保/i.test(rOut), "OUT: 判为过保");
    t(/以最新官方政策为准|师傅上门确认/.test(rOut), "OUT: 带政策免责");

    // ── 欠款门:上次服务未清款 → 报修先拦(确定性,无 LLM)──
    console.log("[UNPAID-GATE] previous unpaid order + repair intent -> settle first");
    const upChat = 970003;
    const wo = await fetch(`${U}/rest/v1/work_orders`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify({ chat_id: String(upChat), payment_status: "unpaid", model: "TESTONLY", issue: "TESTONLY" }) });
    if (wo.ok) {
      bot.__clearSent();
      await bot.processCustomerText(upChat, "my fan is spoilt, can you send technician to repair?");
      const up = bot.__getSent().map((s) => s.text).join("\n");
      t(/settle|pending|还没结清|belum selesai|清一下/i.test(up), "UNPAID: 报修被拦、要求先清款");
      await del("work_orders", "chat_id", String(upChat));
    } else {
      console.log("  SKIP unpaid gate: could not seed work_order:", (await wo.text()).slice(0, 100));
    }
  } catch (e) {
    console.error("  FAIL(setup):", e.message); fail++;
  } finally {
    // 清理划痕
    await del("sales_records", "invoice_number", IN_INV);
    await del("sales_records", "invoice_number", OUT_INV);
    await del("work_orders", "chat_id", String(inChat));
    await del("work_orders", "chat_id", String(outChat));
    // 校验清理
    const chk = await fetch(`${U}/rest/v1/sales_records?invoice_number=in.(${IN_INV},${OUT_INV})&select=invoice_number`, { headers: H });
    const left = chk.ok ? (await chk.json()).length : "?";
    console.log(`  cleanup: scratch sales_records remaining = ${left}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
