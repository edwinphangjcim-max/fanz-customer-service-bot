// ============================================
// test-real-invoices.js — 用 Edwin 发来的 6 张真实发票跑真管线
//
// 视觉那一步(gpt-4o)本地缺 OPENROUTER_API_KEY 跑不了 —— 只把它的"网络返回"
// 用人工对真图的逐字读取替身。其余全是线上真代码:
//   readInvoice() 的 JSON 解析 → normalizeModel → 品牌词优先级 → scrubPII →
//   整单品牌归结 → buildInvoiceEcho() 三语回显。
//
// 钱风险(报错品牌=报错保修期)全在被测的这段。
// 跑法: node test-real-invoices.js
// ============================================

process.env.SKIP_BOT_INIT = "1";
process.env.OPENROUTER_API_KEY = "test-fake-key"; // 让 isConfigured() 过；fetch 被替身

const { readInvoice } = require("./lib/invoice-reader");
const bot = require("./index.js");

// ── 6 张真图的视觉替身(逐字对图填,含 PII 以验证 scrubPII 真会刮掉)──
// 每条 = gpt-4o 对该图应返回的 JSON。故意在 dealer/model 里塞了真 PII 片段,
// 看真代码的 scrubPII 会不会刮干净。
const REAL = [
  {
    tag: "1. VALUE LED SDN BHD (打印, 混品牌灯饰单)",
    vision: {
      is_invoice: true,
      fanz_or_vioz_lines: [
        { model_text: "FS563N OAK — FANZ 56\" CEILING FAN OAKWOOD", brand_word: "fanz", size: "56\"", colour: "Oakwood" },
      ],
      purchase_date_raw: "04/10/2022",
      purchase_date_iso: "2022-10-04",
      date_ambiguous: false,
      dealer_name: "Value Led Sdn Bhd",
      confidence: "medium",
      notes: "mixed-brand lighting order, one Fanz fan line",
    },
  },
  {
    tag: "2. BIG LAMP (M) SDN BHD (打印, 手写余额)",
    vision: {
      is_invoice: true,
      fanz_or_vioz_lines: [
        { model_text: "FANZ INNO 435 L - PINEWOOD CEILING FAN", brand_word: "fanz", size: "", colour: "Pinewood" },
      ],
      purchase_date_raw: "10/5/2026",
      purchase_date_iso: "2026-05-10",
      date_ambiguous: false,
      dealer_name: "Big Lamp (M) Sdn Bhd, 33 Jalan Mutiara Emas 2A",
      confidence: "high",
      notes: "handwritten deposit/balance note",
    },
  },
  {
    tag: "3. iBath Studio (全手写, 潦草) — 边界: 多扇+未知FSF+手写",
    vision: {
      is_invoice: true,
      fanz_or_vioz_lines: [
        { model_text: "VETTA 56 N OAK", brand_word: "none", size: "56\"", colour: "Oak" },
        { model_text: "MKII 56 MB", brand_word: "none", size: "56\"", colour: "Matt Black" },
        { model_text: "FSF-10T", brand_word: "none", size: "", colour: "" },
      ],
      purchase_date_raw: "03/05/2026",
      purchase_date_iso: "2026-05-03",
      date_ambiguous: false,
      dealer_name: "iBath Studio",
      confidence: "low",
      notes: "fully handwritten, hard to read",
    },
  },
  {
    tag: "4. VS ELECTRICAL TRADING (打印, 明写 FANZ VIOZ)",
    vision: {
      is_invoice: true,
      fanz_or_vioz_lines: [
        { model_text: "FANZ VIOZ 56\" CEILING FAN BLACK WINDY-56-MK2", brand_word: "vioz", size: "56\"", colour: "Black" },
      ],
      purchase_date_raw: "29/1/2026",
      purchase_date_iso: "2026-01-29",
      date_ambiguous: false,
      dealer_name: "VS Electrical Trading, No.44 Jalan Beladau 17",
      confidence: "high",
      notes: "serial numbers present",
    },
  },
  {
    tag: "5. LUXCENT DELIVERY ORDER (送货单, 非发票) — 边界: 方案B, 回显带送货单提醒",
    vision: {
      is_invoice: false, // 真实 gpt-4o 判 DO=false; 方案B 仍回显但加提醒
      fanz_or_vioz_lines: [
        { model_text: "FANZ C/F VIOZ WINDY MK II 56\" - MATT BLACK", brand_word: "vioz", size: "56\"", colour: "Matt Black" },
      ],
      purchase_date_raw: "03/11/2025",
      purchase_date_iso: "2025-11-03",
      date_ambiguous: false,
      dealer_name: "Luxcent Holdings Sdn Bhd",
      confidence: "medium",
      notes: "DELIVERY ORDER not tax invoice, page 1 of 2",
    },
  },
  {
    tag: "6. Hup Lee Appliance (打印, 多扇全 Fanz FS/Axel)",
    vision: {
      is_invoice: true,
      fanz_or_vioz_lines: [
        { model_text: "FANZ CEILING FAN FS 423 N", brand_word: "fanz", size: "", colour: "" },
        { model_text: "FANZ CEILING FAN FS 563 N", brand_word: "fanz", size: "", colour: "" },
        { model_text: "FANZ CEILING FAN SERIEL AXEL-PINEWOOD", brand_word: "fanz", size: "", colour: "Pinewood" },
      ],
      purchase_date_raw: "10/01/2024",
      purchase_date_iso: "2024-01-10",
      date_ambiguous: false,
      dealer_name: "Hup Lee Appliance Electrical Enterprise",
      confidence: "high",
      notes: "3 Fanz fan lines + 1 oven (ignored)",
    },
  },
];

// fetch 替身: 返回 OpenRouter chat/completions 结构, content = 当前发票的视觉 JSON
let current = null;
global.fetch = async () => ({
  ok: true,
  status: 200,
  async json() {
    return { choices: [{ message: { content: JSON.stringify(current) } }] };
  },
  async text() { return ""; },
});

(async () => {
  for (const inv of REAL) {
    current = inv.vision;
    const r = await readInvoice(Buffer.from("fake-image-bytes"), "image/jpeg");
    console.log("\n============================================");
    console.log(inv.tag);
    console.log("--------------------------------------------");
    if (!r.ok) { console.log("READ FAILED:", r.error); continue; }
    const res = r.result;
    console.log("isInvoice     :", res.isInvoice);
    console.log("brandResolved :", res.brandResolved, res.brandResolved === "mixed" ? "(整单混品牌→人工)" : "");
    console.log("purchaseDate  :", res.purchaseDateIso || res.purchaseDateRaw, res.dateAmbiguous ? "(AMBIGUOUS)" : "");
    console.log("confidence    :", res.confidence);
    console.log("multipleFans  :", res.multipleFans);
    console.log("dealer(scrub) :", res.dealer);
    console.log("lines:");
    for (const l of res.fanzLines) {
      console.log(`   modelText(scrub): "${l.modelText}"`);
      console.log(`       -> family=${l.family || "—"}  brand=${l.brand}  size=${l.size || "—"}`);
    }
    console.log("\n  ECHO(en):", bot.buildInvoiceEcho(res, "en"));
    console.log("  ECHO(zh):", bot.buildInvoiceEcho(res, "zh"));
    console.log("  ECHO(ms):", bot.buildInvoiceEcho(res, "ms"));
  }

  // ── 断言: 每条产出零 PII + 该判品牌判对 + 回显永远问日期/交人工 ──
  console.log("\n\n############ 断言 ############");
  let pass = 0, fail = 0;
  const t = (c, m) => c ? (pass++, console.log("  PASS:", m)) : (fail++, console.error("  FAIL:", m));
  // 姓名脱敏靠视觉 prompt（被本测替身，线上真跑验证）；scrubPII（确定性）负责
  // 电话/IC/地址——下面用合成占位名 + 通用电话/地址式样断言，绝不落真实客户 PII。
  const PII = [
    /john\s*doe|jane\s*roe|customer\s*name/i,        // 合成占位姓名
    /\b0\d{2}[-\s]?\d{6,}\b/, /\+?60\d[-\s]?\d{6,}/,  // 电话
    /jalan|lorong|taman|no\.\s*\d/i,                 // 地址
  ];
  for (const inv of REAL) {
    current = inv.vision;
    const r = await readInvoice(Buffer.from("x"), "image/jpeg");
    const res = r.result;
    const blob = JSON.stringify(res) + " " +
      bot.buildInvoiceEcho(res, "en") + bot.buildInvoiceEcho(res, "zh") + bot.buildInvoiceEcho(res, "ms");
    const leaked = PII.filter((p) => p.test(blob)).map((p) => p.source);
    t(leaked.length === 0, `${inv.tag.slice(0, 22)} — 零 PII 泄漏${leaked.length ? " LEAK:" + leaked : ""}`);
    // 回显三语都必须要求确认日期 + 交人工
    for (const lang of ["en", "zh", "ms"]) {
      const e = bot.buildInvoiceEcho(res, lang);
      t(/confirm|betul|对不对/i.test(e), `${inv.tag.slice(0,10)} echo(${lang}) 要求确认日期`);
      t(/colleague|verify|同事|核实/i.test(e), `${inv.tag.slice(0,10)} echo(${lang}) 交人工核实`);
      t(!/\d+\s*year|in\s*warranty|out\s*of\s*warranty|保修\d|在保|过保/i.test(e), `${inv.tag.slice(0,10)} echo(${lang}) 不下保修结论`);
    }
  }
  // 方案B: 送货单(第5张 isInvoice=false)仍回显 + 带送货单提醒 + 不下保修结论
  current = REAL[4].vision;
  {
    const res = (await readInvoice(Buffer.from("x"), "image/jpeg")).result;
    t(res.isInvoice === false, "DO 判为非发票(isInvoice=false)");
    const en = bot.buildInvoiceEcho(res, "en"), zh = bot.buildInvoiceEcho(res, "zh"), ms = bot.buildInvoiceEcho(res, "ms");
    t(/delivery order\/receipt/i.test(en), "DO echo(en) 带送货单提醒");
    t(/送货单\/收据/.test(zh), "DO echo(zh) 带送货单提醒");
    t(/delivery order\/resit/i.test(ms), "DO echo(ms) 带送货单提醒");
    t(!/\d+\s*year|in\s*warranty|保修\d|在保|过保/i.test(en + zh + ms), "DO echo 仍不下保修结论");
    t(/Vioz Windy/i.test(en), "DO echo 仍读出 Vioz Windy(品牌对)");
  }

  // 品牌判定断言(逐张)
  const expectBrand = ["fanz", "fanz", "vioz", "vioz", "vioz", "fanz"];
  for (let i = 0; i < REAL.length; i++) {
    current = REAL[i].vision;
    const r = await readInvoice(Buffer.from("x"), "image/jpeg");
    t(r.result.brandResolved === expectBrand[i], `${REAL[i].tag.slice(0,10)} 品牌归结=${expectBrand[i]} (实得 ${r.result.brandResolved})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("FATAL:", e); process.exit(1); });
