// test-preliminary-warranty.js — 发票日期确认后的确定性保修预判
//
// 判定是纯代码算的（不是 LLM），所以核心断言不需要 key：
//   - 确认日期 → 预判消息（在保/过保、三语、带免责、不报金额）
//   - 回别的（改日期等）→ 不预判，pending 清空（保守走人工）
//   - pending 过期(TTL) → 不预判
// 有 OPENROUTER_API_KEY 时再跑真实 LLM 续聊：预判后 LLM 不复述、继续收资料。
//
// 跑法: node test-preliminary-warranty.js            （确定性）
//       OPENROUTER_API_KEY=... node test-preliminary-warranty.js （含 LLM 续聊）
process.env.SKIP_BOT_INIT = "1";
const bot = require("./index.js");

let pass = 0, fail = 0, idx = 0;
const t = (c, m) => c ? (pass++, console.log("  PASS:", m)) : (fail++, console.error("  FAIL:", m));
const chat = () => 810000 + (idx++);

async function turn(chatId, text) {
  bot.__clearSent();
  await bot.processCustomerText(chatId, text);
  return bot.__getSent()
    .map((s) => s.text.split("\n").filter((l) => !l.includes("||DATA||")).join("\n").trim())
    .filter(Boolean).join("\n");
}

(async () => {
  // ── 1. 在保（Fanz 10 年，日期近）──
  console.log("\n[1] Fanz 在保 — 'yes correct' → 预判(在保)");
  {
    const c = chat();
    bot.__setPendingInvoice(c, { brand: "fanz", dateIso: "2024-01-10", at: Date.now() });
    const r = await turn(c, "yes correct");
    console.log("  Fann:", r, "\n");
    t(/10 years.*2034-01-10|until 2034-01-10/i.test(r), "算对年限+到期日(10年→2034-01-10)");
    t(/still be under warranty/i.test(r), "报在保");
    t(/preliminary|colleague will verify/i.test(r), "带免责(初步+同事核实)");
    t(!/RM\s?\d|SGD\s?\d|free\b/i.test(r), "不报金额不说free");
    t(!bot.__getPendingInvoice(c), "pending 已清(一次性)");
  }

  // ── 2. 过保（Vioz 5 年，日期久）──
  console.log("[2] Vioz 过保 — '对的' → 中文预判(过保)");
  {
    const c = chat();
    bot.__setPendingInvoice(c, { brand: "vioz", dateIso: "2019-03-15", at: Date.now() });
    // 先塞条中文历史让语言检测走中文
    await turn(c, "我的风扇坏了");
    bot.__setPendingInvoice(c, { brand: "vioz", dateIso: "2019-03-15", at: Date.now() });
    const r = await turn(c, "对的");
    console.log("  Fann:", r, "\n");
    t(/5年.*2024-03-15/.test(r), "算对 Vioz 5年→2024-03-15");
    t(/已经过了/.test(r), "报过保");
    t(/初步判断/.test(r) && /核实发票/.test(r), "带中文免责");
    t(/费用方面同事会跟你确认/.test(r), "过保→费用整体交同事(含LED)");
  }

  // ── 2b. Vioz 在保 → LED 提示走人工 ──
  console.log("[2b] Vioz 在保 — LED 提示同事确认");
  {
    const c = chat();
    bot.__setPendingInvoice(c, { brand: "vioz", dateIso: "2024-06-01", at: Date.now() });
    const r = await turn(c, "yes");
    console.log("  Fann:", r, "\n");
    t(/5 years.*2029-06-01/i.test(r) && /still be under warranty/i.test(r), "Vioz 5年在保算对");
    t(/LED coverage my colleague will confirm/i.test(r), "Vioz LED 走人工确认(在保消息)");
  }

  // ── 3. 回别的 → 不预判，走保守路 ──
  console.log("[3] 客户改日期 — 不预判, pending 清空");
  {
    const c = chat();
    bot.__setPendingInvoice(c, { brand: "fanz", dateIso: "2024-01-10", at: Date.now() });
    // 不真调 LLM：只验证 pending 被消费 + 没发确定性预判。
    // (无 key 时 LLM 调用会失败发 error 话术——不断言其内容)
    const r = await turn(c, "actually the date is 05/06/2023");
    t(!bot.__getPendingInvoice(c), "pending 已清");
    t(!/preliminary|初步判断|still be under warranty|已经过了/i.test(r), "没发预判(交人工)");
  }

  // ── 4. TTL 过期 → 不预判 ──
  console.log("[4] pending 超10分钟 — 'yes' 不再触发预判");
  {
    const c = chat();
    bot.__setPendingInvoice(c, { brand: "fanz", dateIso: "2024-01-10", at: Date.now() - 11 * 60_000 });
    const r = await turn(c, "yes");
    t(!/preliminary|still be under warranty/i.test(r), "过期不预判");
  }

  // ── 5. BM 确认词 ──
  console.log("[5] BM — 'betul' → BM 预判");
  {
    const c = chat();
    await turn(c, "kipas saya rosak tak boleh pusing");
    bot.__setPendingInvoice(c, { brand: "fanz", dateIso: "2023-08-01", at: Date.now() });
    const r = await turn(c, "betul");
    console.log("  Fann:", r, "\n");
    t(/10 tahun.*2033-08-01/i.test(r) && /masih dalam warranty/i.test(r), "BM 在保预判");
    t(/preliminary check ya|verify invoice/i.test(r), "BM 免责");
  }

  // ── 6. 真实 LLM 续聊（需 key）──
  if (process.env.OPENROUTER_API_KEY) {
    console.log("[6] 真实 LLM — 预判后继续收资料, 不复述不矛盾");
    const c = chat();
    await turn(c, "my Fanz fan motor not spinning");
    bot.__setPendingInvoice(c, { brand: "fanz", dateIso: "2024-01-10", at: Date.now() });
    const prelim = await turn(c, "yes date is correct");
    console.log("  Fann(预判):", prelim, "\n");
    const next = await turn(c, "so what now?");
    console.log("  Fann(续聊):", next, "\n");
    t(/address|地址|alamat|part|which|preferred|time/i.test(next), "继续收资料(地址/部件/时间)");
    t(!/expired|已经过了|not under warranty/i.test(next), "不与预判矛盾");
  } else {
    console.log("[6] SKIP: 设 OPENROUTER_API_KEY 跑真实 LLM 续聊");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
