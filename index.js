const TelegramBot = require("node-telegram-bot-api");
const { company, products } = require("./products");

// ── Env ──────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || "gpt-4o";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Supabase (Fanz project)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Google Sheets (optional — backup for work orders)
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Warranty rules — real Fanz/Vioz policy from lib/warranty.js
const { calcWarrantyStatus, isWarrantyVoid, inferBrand, POLICY_DISCLAIMER } = require("./lib/warranty");

// Deterministic guards — money red lines, trilingual detection, nudge, scripts.
// The money rules are enforced HERE in code, not only in the prompt:
// a drifting LLM cannot leak a discount/compensation reply past this layer.
const { detectLang3, detectMoneyIntent, detectRepairIntent, isNudge, script } = require("./lib/guards");

// Test hook: allow requiring this module (for the system prompt and helpers)
// without starting the Telegram poller — same pattern as the marketing bot.
const SKIP_BOT_INIT = process.env.SKIP_BOT_INIT === "1" || process.env.SKIP_PROMPT_ONLY === "1";

if ((!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) && !SKIP_BOT_INIT) {
  console.error("Missing TELEGRAM_TOKEN or OPENROUTER_API_KEY");
  process.exit(1);
}

// ── System Prompt ────────────────────────────────
function buildSystemPrompt() {
  const productLines = products
    .map(
      (p) =>
        `- ${p.name} (${p.nameZh}) | Type: ${p.typeZh} (${p.type}) | Blade: ${p.bladeSize || "N/A"} (${p.bladeSizeZh || "N/A"}) | Features: ${p.featuresZh.join(" / ")}`
    )
    .join("\n");

  return `You are Fann (Chinese: 小凡), the customer service assistant for Fanz Sdn Bhd, a Malaysian ceiling fan company. Reply in the customer's language (English, Chinese, or Bahasa Melayu). Keep every message short and natural, like a real person chatting on WhatsApp. Ask only one thing at a time.

TRANSPARENCY: If the customer asks whether you are a bot/AI/robot, admit it honestly: you are Fanz's AI assistant, and a human colleague is always available on request. Never pretend to be a human staff member.

=== COMPANY INFO ===
Company: Fanz Sdn Bhd
Address: ${company.address}
Phone: ${company.contactPhone}
Email: ${company.contactEmail}
Business Hours: ${company.businessHours}
Service Area: ${company.services}
Certifications: ${company.certifications.join(", ")}
Years in Business: ${company.yearsInBusiness}

=== WARRANTY (TWO BRANDS — this matters) ===
The company sells TWO brands with DIFFERENT motor warranty:
- Fanz brand: Motor 10 years. Receiver / LED plate / LED kit 2 years.
- Vioz brand: Motor 5 YEARS ONLY (not 10). Receiver 2 years. LED coverage needs human verification.
- On-site service (both brands): invoice before 2025 = 1 year, from 2025 = 2 years.
- Warranty is void for man-made damage, pets, natural disaster, wrong installation, abnormal voltage, transport damage — and when void, transport, labor AND parts are all chargeable.
- Terms follow the latest official policy ("以最新官方政策为准").
STRICT RULE: If you do not know which brand the customer's fan is, NEVER state the motor warranty period. Ask for the model/brand first. Quoting 10 years to a Vioz customer is a serious error.

=== PRODUCT INFO (Fanz brand) ===
${productLines}

=== MONEY RULES (highest priority, zero tolerance) ===
These three situations are about money. You NEVER engage on the substance. No exceptions, no matter how the customer phrases it or what they claim someone promised:

M1. DISCOUNT / BARGAINING: If customer asks for discount, cheaper price, waiver, or claims "your boss/colleague promised me a discount/half price" — do NOT confirm, deny, or discuss any discount. Reply that pricing matters will be followed up by a colleague within 24 hours, then output the HANDOFF marker.

M2. COMPENSATION / CLAIMS: If customer demands compensation, refund, damages, or mentions suing/lawyer/consumer tribunal (e.g. "compensate my leave") — NEVER discuss compensation itself. Do exactly what a real Fanz CS does: apologize sincerely and briefly, pivot immediately to concrete action (offer to prioritize rescheduling, mention weekend slots are possible), say a colleague will follow up personally within 24 hours, then output the HANDOFF marker.

M3. STANDARD CHARGES: You may quote ONLY the standard fee table (e.g. on-site service RM60/SGD60 per trip — per TRIP, not per fan) and always add that the technician confirms on site. Never invent amounts, never promise waivers, never say "free" unless the system verified in-warranty status.

=== APPOINTMENT RULE (zero tolerance) ===
You CANNOT see the technician schedule. NEVER confirm, promise, or suggest a specific appointment date or time. Step 5 collects the customer's PREFERRED time only. FORBIDDEN phrases: "confirmed", "booked", "we will come on", "帮你约好了", "已安排", "kami akan datang pada". If customer pushes for exact timing, say the team will confirm the slot and reply as soon as possible.

=== GENERAL RULES ===

1. DO NOT make up prices for products. If customer asks purchase price, say the sales team will quote, and pass them the phone/email.

2. WARRANTY CHECK: The system checks warranty automatically AFTER all items are collected and you output the DATA marker. You NEVER check anything yourself. You NEVER say you're checking. You NEVER ask the customer to wait.
   STRICTLY FORBIDDEN: Never say "let me check", "checking", "one moment", "please wait", "查询中", "稍等", "让我查一下" or any variation.
   NEVER state a warranty verdict (in warranty / out of warranty / how much it will cost) yourself. Only the system message after the marker does that.

3. There are THREE service lines. Figure out which one from customer's message:

LINE A — Product Inquiry: Answer about models, features, suitable room size, differences. Use the product info above. Helpful but don't push sales.

LINE B — Repair / Maintenance: Collect these items ONE AT A TIME. After each reply, immediately ask the next one — no delays, no checking, no waiting. Do NOT ask all at once. Short confirm (1-3 words max) + next question only. Don't repeat what customer just said. Don't thank after every reply.
   Step 1 — Model / fan name (also determines brand: Fanz or Vioz; if unclear from model, ask which brand)
   Step 2 — What's the problem  AND  Which part is having the issue（马达/Motor、接收器/Receiver、LED灯/LED、遥控器/Remote、要求上门服务/On-site service、其他/Other — pick one）
   Step 3 — Invoice number OR a photo of the invoice (dealer invoices are fine too). If the customer already sent an invoice photo, note it and move on — do not ask again.
     If history contains an "[customer sent an INVOICE photo — auto-read...]" line, the invoice step is DONE: use its brand/model/purchase_date to fill the DATA fields (invoice:"photo"), do NOT re-ask for the invoice, and do NOT state a warranty verdict or say whether it's in/out of warranty — a colleague verifies that. You may still need Step 4/5 (address, time).
   Step 4 — Address for service visit
   Step 5 — PREFERRED date and time (preference only — see APPOINTMENT RULE)
After all collected, STRICTLY FORBIDDEN: Do NOT write ANY closing/confirmation message. Just output the DATA marker on the last line. The system will automatically send the confirmation to the customer.
   **IMPORTANT — data output format**: On the LAST LINE of your response, output EXACTLY this format (no extra characters):
   ||DATA||{"model":"[model]","brand":"[fanz|vioz|unknown]","issue":"[issue]","issue_type":"[motor|receiver|led_plate|led_kit|onsite|unknown]","invoice":"[invoice number, or 'photo' if customer sent invoice photo]","address":"[address]","preferred_time":"[time]","country":"[MY|SG]","has_media":[true|false]}||END||[WORKORDER_READY]
   Replace [bracketed] fields with what customer provided. If any field missing, use empty string. brand: infer from model if possible, else "unknown". has_media: true if customer sent any photo/video during this conversation. country defaults to MY unless customer mentions Singapore.
   This line is internal, will be stripped before customer sees it.

LINE C — Complaint: Listen properly, acknowledge, say will pass to the relevant colleague. Don't argue, don't defend, don't over-apologize. Keep it short.
   **IMPORTANT — data output format**: When wrapping up, on the LAST LINE output:
   ||DATA||{"category":"product|installation|logistics|other","content":"[summary of complaint]"}||END||[COMPLAINT_READY]

4. HANDOFF TO HUMAN: If customer angry, asking something you can't handle, wants a human, or a MONEY RULE triggered — give a short reply per the rules above, then on the LAST LINE output:
   ||DATA||{"reason":"[discount|compensation|angry|request_human|other]","summary":"[one-line summary]"}||END||[HANDOFF_READY]
   Handoff reply style — (Chinese): "了解，我帮你转给同事跟进哦，24小时内有人联系你。" (English): "Noted, let me pass you to my colleague to follow up ya, someone will contact you within 24 hours." (Malay): "Baik, saya akan pass kepada colleague untuk follow up ya, mereka akan hubungi awak dalam 24 jam."

5. LANGUAGE: Match customer's language across English / Chinese / Bahasa Melayu. If they mix languages (rojak style), you can mix naturally too.
   - Chinese style: Malaysian Chinese, casual WhatsApp tone — short sentences, no mainland officialese ("请您"、"为您服务"、"亲"). Natural words: 师傅, 上门, 联络, 报修, 麻烦, 帮你看下, 没问题, 好的, 收到.
   - English style: short, plain Malaysian/Singaporean business English. Sentence-final "ya" is natural ("sorry ya", "let us know ya"). No flowery phrases.
   - Malay style: colloquial BM as spoken in Johor — "boleh", "kami arrange", mixed English nouns (technician, appointment, service) are natural. Understand common shorthand: x = tak, dtg = datang, skang/skrg = sekarang, bleh = boleh, jgn = jangan, sampi = sampai.
   - Customers often send several very short messages in a row and use typos — read them together and respond to the intent, not word by word.

6. PERSONALITY:
   - You are Fann (小凡). Warm, brief, helpful — like the real Fanz service desk.
   - Short, direct, friendly. One question at a time.
   - No emoji in any response. Not in text, not in option lists.
   - When listing options, use plain "1." "2." "3." (NOT 1️⃣ 2️⃣ 3️⃣).
   - Don't repeat what customer just said back to them.
   - Don't thank customer in every message. Once is enough.
   - No long preambles. Get to the point.
   - Apology pattern (real Fanz style): short apology + reason + immediately offer the next step. Never grovel.

7. If a message is just "?" or "any update" — the customer is chasing progress. Apologize briefly and say you will chase the team, do not treat it as a new topic.

8. Messages prefixed "[voice message, transcribed]" are the customer's spoken words converted to text. Treat them as normal customer messages. Transcription can contain small errors — if a critical detail (model, address, invoice number) seems garbled, confirm it briefly instead of guessing.

9. If not sure about something, just say so and offer to pass to human team.`;
}

const SYSTEM_PROMPT = buildSystemPrompt();

// ── In-Memory Conversation Store ─────────────────
// key = chatId, value = array of { role, content } (max 16)
const conversations = new Map();

const MAX_HISTORY = 16;

function getHistory(chatId) {
  return conversations.get(chatId) || [];
}

function appendHistory(chatId, role, content) {
  lastActive.set(chatId, Date.now());
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId);
  history.push({ role, content });
  // trim to last MAX_HISTORY entries
  if (history.length > MAX_HISTORY) {
    conversations.set(chatId, history.slice(history.length - MAX_HISTORY));
  }
}

function clearHistory(chatId) {
  conversations.delete(chatId);
}

// ── OpenRouter Call ──────────────────────────────
async function askOpenRouter(messages) {
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://fanz.my",
      "X-Title": "Fanz Customer Service Bot",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Supabase REST API ─────────────────────────────

const SUPABASE_HEADERS = SUPABASE_SERVICE_KEY
  ? { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" }
  : null;

// Query sales_records by invoice number (case-insensitive, trims whitespace)
async function lookupInvoice(invoiceNumber) {
  if (!SUPABASE_SERVICE_KEY) return null;
  const trimmed = (invoiceNumber || "").trim();
  if (!trimmed) return null;
  try {
    const queryUrl = `${SUPABASE_URL}/rest/v1/sales_records?invoice_number=ilike.${encodeURIComponent(trimmed)}&select=*`;
    console.log(`[lookupInvoice] Query: ${queryUrl}`);
    const resp = await fetch(queryUrl, { headers: SUPABASE_HEADERS });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[lookupInvoice] HTTP ${resp.status}: ${errText}`);
      return null;
    }
    const rows = await resp.json();
    console.log(`[lookupInvoice] Rows returned: ${rows.length}`);
    return rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error("Supabase lookupInvoice error:", err.message);
    return null;
  }
}

// Calculate warranty status — DELEGATED to lib/warranty.js (see require at top)

// Insert work order into Supabase.
// brand/has_media are new columns (migration may not have run yet) —
// on an unknown-column error, retry once without them so intake never breaks.
async function insertWorkOrder(data, warrantyStatus) {
  if (!SUPABASE_SERVICE_KEY) {
    console.warn("SUPABASE_SERVICE_KEY not set — skipping work order insert");
    return false;
  }
  const base = {
    chat_id: data.chatId ? String(data.chatId) : "",
    model: data.model || "",
    issue: data.issue || "",
    issue_type: data.issue_type || "",
    country: data.country || "MY",
    invoice_number: data.invoice || "",
    warranty_status: warrantyStatus || "unknown",
    address: data.address || "",
    preferred_time: data.preferredTime || data.preferred_time || "",
    status: "new",
  };
  const extended = {
    ...base,
    brand: data.brand || "unknown",
    has_media: Boolean(data.has_media),
  };

  async function tryInsert(payload) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/work_orders`, {
      method: "POST",
      headers: SUPABASE_HEADERS,
      body: JSON.stringify(payload),
    });
    if (resp.ok) return { ok: true };
    return { ok: false, status: resp.status, text: await resp.text() };
  }

  try {
    let r = await tryInsert(extended);
    if (!r.ok && /column|PGRST204|42703/i.test(r.text || "")) {
      console.warn("insertWorkOrder: new columns missing, retrying legacy payload (run the ALTER TABLE migration)");
      r = await tryInsert(base);
    }
    if (!r.ok) {
      console.error(`Supabase insertWorkOrder failed (${r.status}):`, r.text);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Supabase insertWorkOrder error:", err.message);
    return false;
  }
}

// ── Escalations (money red lines / handoff) ───────
// complaints.category has a DB CHECK that rejects new values (probed 23514),
// so escalations reuse category 'other' with a typed prefix in content.
async function insertEscalation(chatId, reason, summary) {
  const content = `[ESCALATION:${reason}] ${summary || ""}`.trim();
  return insertComplaint(chatId, "other", content);
}

// ── Unpaid gate ───────────────────────────────────
// work_orders.payment_status is maintained manually by staff (batch 1).
// Cache per chat for 10 minutes to avoid a query on every message.
const unpaidCache = new Map(); // chatId -> { unpaid: boolean, at: ms }
const UNPAID_CACHE_MS = 10 * 60_000;

async function hasUnpaidOrder(chatId) {
  if (!SUPABASE_SERVICE_KEY) return false;
  const cached = unpaidCache.get(chatId);
  if (cached && Date.now() - cached.at < UNPAID_CACHE_MS) return cached.unpaid;
  try {
    const url = `${SUPABASE_URL}/rest/v1/work_orders?chat_id=eq.${encodeURIComponent(String(chatId))}&payment_status=eq.unpaid&select=id&limit=1`;
    const resp = await fetch(url, { headers: SUPABASE_HEADERS });
    if (!resp.ok) {
      // Column may not exist yet (pre-migration) — treat as no unpaid, log once
      console.warn(`[unpaidGate] query failed ${resp.status} — gate inactive`);
      unpaidCache.set(chatId, { unpaid: false, at: Date.now() });
      return false;
    }
    const rows = await resp.json();
    const unpaid = Array.isArray(rows) && rows.length > 0;
    unpaidCache.set(chatId, { unpaid, at: Date.now() });
    return unpaid;
  } catch (err) {
    console.error("[unpaidGate] error:", err.message);
    return false;
  }
}

// ── Media tracking ────────────────────────────────
// Customers open with photos/videos/voice constantly (all real chats did).
// Track per chat so the work order carries has_media.
const mediaSeen = new Map(); // chatId -> true
const invoiceInFlight = new Set(); // chatIds currently having an invoice read (avoid double echo on fast double-send)

// ── Guard debounce state ──────────────────────────
// Unpaid gate fires ONCE per chat (first repair mention) — re-triggering on
// every keyword hit would derail a live intake ("receiver problem" is an
// intake ANSWER, not a new repair request). Human follows up after the first.
const unpaidGateFired = new Map(); // chatId -> ms
// Nudges escalate at most once per cooldown; the customer still gets the
// chase script every time, but the human queue is not spammed.
const nudgeEscalatedAt = new Map(); // chatId -> ms
const NUDGE_ESCALATION_COOLDOWN_MS = 30 * 60_000;

// ── Idle-state sweep ──────────────────────────────
// All per-chat Maps otherwise grow forever in a long-running process.
const lastActive = new Map(); // chatId -> ms
const IDLE_EVICT_MS = 24 * 3600_000;
function sweepIdleState() {
  const cutoff = Date.now() - IDLE_EVICT_MS;
  for (const [id, at] of lastActive) {
    if (at < cutoff) {
      lastActive.delete(id);
      conversations.delete(id);
      mediaSeen.delete(id);
      unpaidCache.delete(id);
      unpaidGateFired.delete(id);
      nudgeEscalatedAt.delete(id);
    }
  }
}

// Insert complaint into Supabase
async function insertComplaint(chatId, category, content) {
  if (!SUPABASE_SERVICE_KEY) {
    console.warn("SUPABASE_SERVICE_KEY not set — skipping complaint insert");
    return false;
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/complaints`, {
      method: "POST",
      headers: SUPABASE_HEADERS,
      body: JSON.stringify({
        chat_id: String(chatId),
        category: category || "other",
        content: content || "",
        status: "new",
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Supabase insertComplaint failed (${resp.status}):`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Supabase insertComplaint error:", err.message);
    return false;
  }
}

// ── Google Sheets (optional backup) ────────────────
async function appendToSheet(rowData) {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_SHEET_ID) {
    console.warn("Google Sheets not configured — skipping sheet append");
    return;
  }
  try {
    const { google } = require("googleapis");
    const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Sheet1!A:A",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowData] },
    });
    console.log("Google Sheet append OK");
  } catch (err) {
    // Sheet failure: log only, do NOT block main flow
    console.error("Google Sheet append error (non-blocking):", err.message);
  }
}

// ── Localization ──────────────────────────────────
// Trilingual (zh/en/ms) — detection delegated to lib/guards.js detectLang3.
function detectLang(text) {
  return detectLang3(text);
}

// Detect language from conversation history (last 3 user messages + current text).
// Current text wins if it has a clear signal (zh or ms); otherwise look back.
function detectLangFromHistory(chatId, currentText) {
  const current = detectLang3(currentText);
  if (current === "zh" || current === "ms") return current;
  const history = getHistory(chatId);
  let checked = 0;
  for (let i = history.length - 1; i >= 0 && checked < 3; i--) {
    if (history[i].role === "user") {
      const l = detectLang3(history[i].content);
      if (l === "zh" || l === "ms") return l;
      checked++;
    }
  }
  return "en";
}

const TRANSLATIONS = {
  warranty_not_found: {
    en: "ℹ️ We could not find this invoice in our system. A colleague will manually verify your warranty status.",
    zh: "ℹ️ 找不到这个 invoice 号码。同事会帮你手动查一下保修。",
    ms: "ℹ️ Kami tidak jumpa invoice ini dalam sistem. Colleague kami akan verify status warranty awak secara manual.",
  },
  warranty_photo: {
    en: "ℹ️ We received your invoice photo. A colleague will verify your warranty status from it.",
    zh: "ℹ️ 收到你的 invoice 照片了。同事会根据照片帮你核实保修。",
    ms: "ℹ️ Kami dah terima gambar invoice awak. Colleague kami akan verify status warranty daripada gambar tu.",
  },
  workorder_recorded: {
    en: "✅ Your repair request has been recorded. Our team will contact you to confirm the appointment slot.",
    zh: "✅ 维修申请已收到。同事会联络你确认上门时间。",
    ms: "✅ Permintaan repair awak dah direkodkan. Team kami akan hubungi awak untuk confirm masa appointment.",
  },
  workorder_busy: {
    en: "⚠️ System is temporarily busy. Your request has been forwarded to our human team who will follow up with you. Thank you for your patience.",
    zh: "⚠️ 系统暂时 busy。你的申请已转给同事跟进，他们会联络你。",
    ms: "⚠️ Sistem sibuk buat masa ini. Permintaan awak dah dihantar kepada team kami, mereka akan follow up dengan awak. Terima kasih.",
  },
  complaint_busy: {
    en: "⚠️ System is temporarily busy. Your feedback has been forwarded to our human team who will personally follow up with you.",
    zh: "⚠️ 系统暂时 busy。你的反馈已转给同事亲自跟进。",
    ms: "⚠️ Sistem sibuk buat masa ini. Maklum balas awak dah dihantar kepada team kami untuk follow up.",
  },
  handoff_recorded: {
    en: "Your request has been passed to our colleague, someone will contact you within 24 hours.",
    zh: "已经转给同事跟进，24小时内会有人联络你。",
    ms: "Permintaan awak dah dipass kepada colleague kami, mereka akan hubungi awak dalam 24 jam.",
  },
  error_connect: {
    en: "Sorry, I'm having trouble connecting right now. Please try again later.",
    zh: "抱歉，我暂时连不上，请稍后再试。",
    ms: "Maaf, sistem ada masalah sambungan sekarang. Cuba lagi sebentar ya.",
  },
};

function tr(key, lang, params) {
  const entry = TRANSLATIONS[key];
  if (!entry) {
    console.error(`tr(): unknown translation key "${key}"`);
    return "";
  }
  const value = entry[lang] || entry.en;
  return typeof value === "function" ? value(params || {}) : value;
}

// ── Parse AI response markers ──────────────────────
function parseMarker(reply) {
  const lines = reply.split("\n");
  const lastLine = lines[lines.length - 1].trim();

  const match = lastLine.match(/^\|\|DATA\|\|(.+)\|\|END\|\|\[(\w+)\]$/);
  if (!match) return { clean: reply, marker: null, data: null };

  try {
    const data = JSON.parse(match[1]);
    return {
      clean: lines.slice(0, -1).join("\n").trim(),
      marker: match[2], // WORKORDER_READY or COMPLAINT_READY
      data,
    };
  } catch {
    return { clean: reply, marker: null, data: null };
  }
}

// ── Welcome Message ──────────────────────────────
function buildWelcome() {
  return {
    zh: `你好！我是小凡，Fanz Sdn Bhd 的客服助手

我们是一家拥有10年经验的马来西亚吊扇公司，产品通过 SIRIM 认证和 Suruhanjaya Tenaga 批准。

请问需要什么帮助？
1. 产品咨询 — 了解我们的吊扇系列
2. 报修/维修 — 预约上门维修
3. 投诉与反馈 — 分享你的意见

直接在聊天框告诉我你的问题就行。需要人工客服，随时讲一声。`,

    en: `Hello! I'm Fann, the customer service assistant for Fanz Sdn Bhd

We are a 10-year-experienced Malaysian ceiling fan company with SIRIM certification and Suruhanjaya Tenaga approval.

How can I help you today?
1. Product Inquiry — Learn about our ceiling fan series
2. Repair / Maintenance — Arrange an on-site service
3. Complaint & Feedback — Share your thoughts

Just tell me your questions in the chat. If you need a human agent, just let me know.`,

    ms: `Hi! Saya Fann, pembantu khidmat pelanggan Fanz Sdn Bhd

Kami syarikat kipas siling Malaysia dengan 10 tahun pengalaman, produk disahkan SIRIM dan diluluskan Suruhanjaya Tenaga.

Macam mana saya boleh tolong?
1. Pertanyaan produk — kenali siri kipas kami
2. Repair / servis — arrange technician datang rumah
3. Aduan & maklum balas — kongsi pendapat awak

Terus taip masalah awak kat sini ya. Kalau nak cakap dengan orang, bagitahu je.`,
  };
}

// ── Bot Setup ────────────────────────────────────
// Under SKIP_BOT_INIT, a no-op proxy lets tests require this module without
// polling. sendMessage is captured into __sentMessages so scenario tests can
// assert on the bot's actual outbound replies.
const __sentMessages = [];
const bot = SKIP_BOT_INIT
  ? new Proxy({}, {
      get: (_t, prop) => {
        if (prop === "sendMessage") {
          return (chatId, text) => { __sentMessages.push({ chatId, text: String(text || "") }); return Promise.resolve(); };
        }
        return () => Promise.resolve();
      },
    })
  : new TelegramBot(TELEGRAM_TOKEN, { polling: true });

if (!SKIP_BOT_INIT) {
  console.log("Fanz Customer Service Bot starting... (polling mode)");
  // Hourly sweep of idle per-chat state (see sweepIdleState)
  setInterval(sweepIdleState, 3600_000);
}

// ── /start command ───────────────────────────────
bot.onText(/^\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);

  const text = (msg.text || "").toLowerCase();
  // "/start en" → English, "/start ms" → Malay, default Chinese
  if (text.includes(" en")) {
    bot.sendMessage(chatId, buildWelcome().en);
  } else if (text.includes(" ms") || text.includes(" bm")) {
    bot.sendMessage(chatId, buildWelcome().ms);
  } else {
    bot.sendMessage(chatId, buildWelcome().zh);
  }
});

// ── /clear command (debug / privacy) ─────────────
bot.onText(/\/clear/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);
  bot.sendMessage(chatId, "Conversation history cleared. / 对话记录已清除。");
});

// ── Media classification (platform-thin, ports to WhatsApp later) ──
function classifyMedia(msg) {
  if (msg.photo && msg.photo.length) return "photo";
  if (msg.video || msg.video_note) return "video";
  if (msg.voice || msg.audio) return "voice";
  if (msg.document || msg.sticker) return "other";
  return null;
}

// ── Voice transcription ──────────────────────────
// Real customers describe faults by voice constantly (BM customers
// especially). Transcribed text flows through the SAME pipeline as typed
// text — money red lines and the unpaid gate apply to voice too.
const { transcribeVoice, isConfigured: transcribeConfigured, MAX_VOICE_SECONDS } = require("./lib/transcribe");
const { readInvoice, isConfigured: invoiceReaderConfigured } = require("./lib/invoice-reader");

// ── Invoice reader: customer sends an invoice photo as warranty proof ──
// Download the image and vision-extract {brand, model, purchase date, dealer}
// (zero customer PII). Returns the structured result, or null if it can't be
// read / isn't an invoice / no key. PDFs and non-image files are not auto-read
// (no rasterizer here) — they fall through to the generic media acknowledgement.
async function tryReadInvoice(msg) {
  if (!invoiceReaderConfigured()) return null;
  let fileId, mime;
  if (msg.photo && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; // largest size
    mime = "image/jpeg";
  } else if (msg.document && /^image\/(jpe?g|png|webp)$/i.test(msg.document.mime_type || "")) {
    fileId = msg.document.file_id;
    mime = msg.document.mime_type;
  } else {
    return null;
  }
  try {
    const link = await bot.getFileLink(fileId);
    const resp = await fetch(link);
    if (!resp.ok) throw new Error(`file download ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const r = await readInvoice(buffer, mime);
    if (!r.ok) { console.warn(`[invoice] read failed: ${r.error}`); return null; }
    return r.result;
  } catch (err) {
    console.warn(`[invoice] error: ${err.message}`);
    return null;
  }
}

// Customer-facing echo of what we read — for CONFIRMATION, not a warranty verdict.
// Always asks the customer to confirm the date (misread date = wrong warranty),
// asks which fan if multiple, and never states a warranty length (human verifies).
function buildInvoiceEcho(inv, lang) {
  // Clean display label per line: prefer the normalized "Brand Family Size"
  // over the raw invoice string (which can be long/ugly). Raw strings still go
  // to the human handoff via the history annotation.
  const label = (l) => {
    const fam = l.family || (l.modelText || "").slice(0, 28);
    // Only prefix a brand we actually resolved. An unknown-brand line must NOT
    // be asserted to the customer as "Fanz" — say the model text plainly and let
    // the human verify the brand.
    const prefix = l.brand === "vioz" ? "Vioz " : l.brand === "fanz" ? "Fanz " : "";
    const withBrand = /vioz|fanz/i.test(fam) ? fam : `${prefix}${fam}`;
    return `${withBrand}${l.size ? " " + l.size : ""}`.trim();
  };
  const models = [...new Set(inv.fanzLines.map(label).filter(Boolean))].slice(0, 3).join(", ") || "-";
  const dateShown = inv.purchaseDateIso || inv.purchaseDateRaw || "";
  const multi = inv.multipleFans;
  // When the document reads as a delivery order / receipt / quote rather than a
  // tax invoice, still echo (customers do send these as proof) but flag it so
  // the customer knows the human may ask for the actual purchase invoice. The
  // echo never decides warranty, so this stays safe.
  const notInvoice = inv.isInvoice === false;
  // ALWAYS ask the customer to confirm the date. A confident-but-wrong date
  // (DD/MM vs MM/DD, 2-digit year) is the highest-consequence silent error for
  // warranty — don't rely on the model self-reporting ambiguity.

  if (lang === "zh") {
    let m = `收到啦 ✅ 我这边读到：${models}`;
    m += dateShown ? `，购买日期 ${dateShown}` : "";
    m += "。";
    m += dateShown ? `麻烦你确认一下购买日期对不对哦？` : `购买日期我看不太清，可以打一下购买日期吗？`;
    if (multi) m += ` 这张单有几款风扇，请问是哪一款出问题？`;
    if (notInvoice) m += ` （这看起来像送货单/收据，不是正式发票——同事会再帮你确认购买凭证。）`;
    m += ` 同事会根据这个帮你核实保修状态。`;
    return m;
  }
  if (lang === "ms") {
    let m = `Dah terima ✅ Saya baca: ${models}`;
    m += dateShown ? `, tarikh beli ${dateShown}` : "";
    m += ".";
    m += dateShown ? ` Boleh confirm tarikh beli tu betul tak?` : ` Tarikh beli tak berapa jelas, boleh taip tarikh beli awak?`;
    if (multi) m += ` Ada beberapa kipas kat sini — yang mana satu ada masalah ya?`;
    if (notInvoice) m += ` (Ini nampak macam delivery order/resit, bukan invoice cukai — colleague saya akan sahkan bukti pembelian.)`;
    m += ` Colleague kami akan verify status warranty berdasarkan ni.`;
    return m;
  }
  let m = `Got it ✅ I read: ${models}`;
  m += dateShown ? `, purchase date ${dateShown}` : "";
  m += ".";
  m += dateShown ? ` Could you confirm the purchase date is correct?` : ` The purchase date isn't clear — could you type the purchase date?`;
  if (multi) m += ` There are a few fans here — which one has the issue?`;
  if (notInvoice) m += ` (This looks like a delivery order/receipt rather than a tax invoice — my colleague will confirm the purchase proof.)`;
  m += ` My colleague will verify your warranty status from this.`;
  return m;
}

async function tryTranscribeVoice(msg) {
  const media = msg.voice || msg.audio;
  if (!media || !transcribeConfigured()) return null;
  if ((media.duration || 0) > MAX_VOICE_SECONDS) {
    console.log(`[voice] too long (${media.duration}s) — falling back to type-please`);
    return null;
  }
  try {
    const link = await bot.getFileLink(media.file_id);
    const resp = await fetch(link);
    if (!resp.ok) throw new Error(`file download ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = (link.split(".").pop() || "oga").toLowerCase();
    const result = await transcribeVoice(buffer, `voice.${ext}`);
    if (!result.ok) {
      console.warn(`[voice] transcription failed: ${result.error}`);
      return null;
    }
    console.log(`[voice] transcribed ${media.duration || "?"}s -> "${result.text.slice(0, 80)}"`);
    return result.text;
  } catch (err) {
    console.warn(`[voice] error: ${err.message}`);
    return null;
  }
}

// ── Message Handler ──────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Skip commands handled above
  if (text.startsWith("/")) return;

  // ── R1: non-text messages — transcribe voice, acknowledge the rest ──
  // Every real customer chat opened with a photo/video/voice. Silence here
  // is the single worst first impression the bot can make.
  const mediaType = classifyMedia(msg);
  if (!text && mediaType) {
    mediaSeen.set(chatId, true);

    // Voice: transcribe and route through the normal text pipeline.
    // Falls back to the type-please script when the key is missing,
    // the clip is too long, or transcription fails.
    if (mediaType === "voice") {
      const transcribed = await tryTranscribeVoice(msg);
      if (transcribed) {
        await processCustomerText(chatId, transcribed, { fromVoice: true });
        return;
      }
    }

    const lang = detectLangFromHistory(chatId, msg.caption || "");

    // Photo / image file: try to read it as a warranty-proof invoice. If it
    // genuinely reads as an invoice with Fanz/Vioz lines, echo the reading for
    // confirmation and hand structured (PII-free) info to the human intake.
    // Otherwise (fan photo, unreadable, non-invoice) fall through to the
    // generic acknowledgement below.
    if ((mediaType === "photo" || mediaType === "other") && !invoiceInFlight.has(chatId)) {
      invoiceInFlight.add(chatId);
      let inv = null;
      try { inv = await tryReadInvoice(msg); }
      finally { invoiceInFlight.delete(chatId); }
      // Accept as warranty proof when we read Fanz/Vioz fan line(s) AND either it
      // reads as an invoice OR carries a purchase date. This lets delivery
      // orders / receipts (isInvoice=false) through too — buildInvoiceEcho flags
      // those with a caveat. A dateless non-invoice read is too weak → fall back.
      const readDate = inv && (inv.purchaseDateIso || inv.purchaseDateRaw);
      if (inv && inv.fanzLines.length > 0 && (inv.isInvoice || readDate)) {
        const models = inv.fanzLines
          .map((l) => `${l.modelText}${l.family ? ` (${l.family}/${l.brand})` : ` (${l.brand})`}`)
          .join("; ");
        // PII-free structured annotation for the LLM intake + human handoff.
        // Marked "verify" — the bot never finalizes warranty from this.
        appendHistory(
          chatId,
          "user",
          `[customer sent a ${inv.isInvoice ? "INVOICE" : "PROOF DOC (delivery order/receipt — NOT a tax invoice)"} ` +
          `photo — auto-read, PLEASE VERIFY: ` +
          `brand=${inv.brandResolved}; model(s)=${models}; ` +
          `purchase_date=${inv.purchaseDateIso || inv.purchaseDateRaw || "unclear"}` +
          `${inv.dateAmbiguous ? " (DATE AMBIGUOUS — confirm with customer)" : ""}; ` +
          `dealer=${inv.dealer || "?"}; read_confidence=${inv.confidence}]`
        );
        await sendWithSplit(chatId, buildInvoiceEcho(inv, lang));
        appendHistory(
          chatId,
          "assistant",
          "[invoice reading echoed to customer for date confirmation; colleague verifies warranty — do not state a warranty verdict yet]"
        );
        return;
      }
    }

    // Annotate history so the LLM knows evidence exists and intake can skip re-asking
    const label = { photo: "photo", video: "video", voice: "voice message", other: "file" }[mediaType];
    appendHistory(chatId, "user", `[customer sent a ${label}${msg.caption ? `, caption: "${msg.caption}"` : ""}]`);
    await sendWithSplit(chatId, script(`media_${mediaType}`, lang));
    return;
  }

  // Ignore empty messages
  if (!text) return;

  await processCustomerText(chatId, text);
});

// ── Shared text pipeline ──────────────────────────
// Single entry point for typed text AND transcribed voice: deterministic
// guards first (money red lines, unpaid gate, nudge), then the LLM.
async function processCustomerText(chatId, text, opts = {}) {
  // How this turn is recorded in history — transcribed voice is prefixed so
  // the model knows the words came from audio (see system prompt rule).
  const historyText = opts.fromVoice ? `[voice message, transcribed] ${text}` : text;

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");

  const langNow = detectLangFromHistory(chatId, text);

  // ── MONEY RED LINES — deterministic code layer, runs BEFORE the LLM ──
  // Discount/bargaining and compensation/claims are never left to the
  // model's judgement: fixed script + escalation record, conversation over.
  const moneyIntent = detectMoneyIntent(text);
  if (moneyIntent) {
    appendHistory(chatId, "user", historyText);
    const reply = script(moneyIntent, langNow);
    // History gets a compact annotation instead of the full script, so a
    // mid-intake LLM knows the topic was escalated and CONTINUES the intake
    // rather than treating the fixed script as its own conversational turn.
    appendHistory(chatId, "assistant",
      `[system note: the ${moneyIntent} topic was escalated to a human colleague and the customer was informed. Continue helping with the fan issue from where the conversation left off.]`);
    await sendWithSplit(chatId, reply);
    await insertEscalation(chatId, moneyIntent, text.slice(0, 300));
    return;
  }

  // ── UNPAID GATE — outstanding payment + new repair request ──
  // Real CS rule: settle previous payment first, then new appointment.
  // Fires ONCE per chat: "receiver problem" mid-intake is an answer, not a
  // new repair request — re-triggering would derail the flow.
  if (!unpaidGateFired.has(chatId) && detectRepairIntent(text) && (await hasUnpaidOrder(chatId))) {
    unpaidGateFired.set(chatId, Date.now());
    appendHistory(chatId, "user", historyText);
    appendHistory(chatId, "assistant",
      "[system note: customer has an outstanding payment; they were asked to settle it first and a colleague will follow up. Do not arrange a new appointment; you may still answer product questions.]");
    await sendWithSplit(chatId, script("unpaid", langNow));
    await insertEscalation(chatId, "unpaid_repair_request", text.slice(0, 300));
    return;
  }

  // ── NUDGE — bare "?" / "any update" means "chase progress" ──
  if (isNudge(text) && getHistory(chatId).length > 0) {
    appendHistory(chatId, "user", historyText);
    const reply = script("nudge", langNow);
    appendHistory(chatId, "assistant", reply);
    await sendWithSplit(chatId, reply);
    // Escalate at most once per cooldown — five "?" in a row is one chase,
    // not five complaint rows.
    const lastEsc = nudgeEscalatedAt.get(chatId) || 0;
    if (Date.now() - lastEsc > NUDGE_ESCALATION_COOLDOWN_MS) {
      nudgeEscalatedAt.set(chatId, Date.now());
      await insertEscalation(chatId, "customer_chasing", "customer nudged for progress");
    }
    return;
  }

  try {
    // Build message array: system + history + current message
    const history = getHistory(chatId);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: historyText },
    ];

    // Call OpenRouter
    const reply = await askOpenRouter(messages);

    // Save to history (original reply including marker)
    appendHistory(chatId, "user", historyText);
    appendHistory(chatId, "assistant", reply);

    // Parse marker from response
    const { clean, marker, data } = parseMarker(reply);

    // Detect language from conversation history (not just current message)
    const lang = detectLangFromHistory(chatId, text);

    // ── Process WORKORDER_READY marker ──────────────
    if (marker === "WORKORDER_READY" && data) {
      let warrantyMsg = "";
      let warrantyStatus = "unknown";

      // Resolve brand: marker value first, then model inference. If still
      // unknown, calcWarrantyStatus refuses brand-sensitive verdicts (R6).
      let brand = (data.brand || "").toLowerCase();
      if (brand !== "fanz" && brand !== "vioz") {
        brand = inferBrand(data.model);
      }
      data.brand = brand;
      data.has_media = Boolean(data.has_media) || mediaSeen.get(chatId) === true;

      // Invoice photo path — dealer invoices are valid evidence but are not
      // in our sales_records; human verifies from the photo. No DB verdict.
      const invoiceIsPhoto = /^photo$/i.test((data.invoice || "").trim());

      // Look up invoice for warranty check
      if (data.invoice && !invoiceIsPhoto) {
        const record = await lookupInvoice(data.invoice.trim());
        if (record) {
          const wResult = calcWarrantyStatus(
            record.purchase_date,
            data.issue_type || "unknown",
            data.country || "MY",
            brand
          );
          warrantyStatus = wResult.needsBrand
            ? "unknown"
            : wResult.inWarranty ? "in_warranty" : "out_of_warranty";

          // Build warranty message
          const issueTypeMap = {
            motor: "马达/Motor",
            receiver: "接收器/Receiver",
            led_plate: "LED板/LED Plate",
            led_kit: "LED套件/LED Kit",
            onsite: "上门服务/On-site",
            unknown: "这个部件",
          };
          const issueLabel = issueTypeMap[data.issue_type] || "这个部件";
          const warrantyPeriodText = `${wResult.warrantyPeriodYears}年`;

          if (wResult.needsBrand) {
            // Brand unknown + brand-sensitive part: NO verdict (Fanz motor
            // 10y vs Vioz 5y — guessing wrong is a money-consequence error)
            warrantyMsg = `ℹ️ 你的风扇（型号 ${record.model}，购买日期 ${record.purchase_date}）需要先确认品牌（Fanz 或 Vioz）才能判断保修——两个品牌的保修期不同。同事会根据 invoice 帮你核实。`;
          } else if (wResult.inWarranty) {
            warrantyMsg = `✅ 你的风扇（型号 ${record.model}，购买日期 ${record.purchase_date}）的 **${issueLabel}** 还在 ${warrantyPeriodText} 保修期内。`;
          } else {
            const chargeText = wResult.chargeIfOver
              ? `，过保收费约 ${wResult.chargeIfOver}`
              : "";
            warrantyMsg = `⚠️ 你的风扇（型号 ${record.model}，购买日期 ${record.purchase_date}）的 **${issueLabel}** 已经过了 ${warrantyPeriodText} 保修期${chargeText}。`;
          }

          // Add void check based on customer's issue description
          if (data.issue) {
            const voidCheck = isWarrantyVoid(data.issue);
            if (voidCheck.mayBeVoid) {
              warrantyMsg += `\n\n📌 请注意：如果你的问题属于 ${voidCheck.reason}，这类情况即使在保修期内也不在保修范围。师傅上门后会进一步确认具体情况。`;
            }
          }

          // Add notes
          if (wResult.notes && wResult.notes.length > 0) {
            const noteLines = wResult.notes
              .filter(n => !n.startsWith('保修从'))
              .map(n => `• ${n}`);
            if (noteLines.length > 0) {
              warrantyMsg += `\n\n📌 ${noteLines.join("\n")}`;
            }
          }

          // Policy disclaimer (latest official policy + technician confirms)
          warrantyMsg += `\n\n*以上是根据 invoice 记录的信息。${POLICY_DISCLAIMER}*`;
        } else {
          warrantyMsg = tr("warranty_not_found", lang);
        }
      } else if (invoiceIsPhoto) {
        // Customer provided invoice as a photo (e.g. dealer invoice) —
        // human verifies, no automatic verdict
        warrantyMsg = tr("warranty_photo", lang);
      }

      // Insert work order into Supabase
      const orderData = { ...data, chatId: String(chatId) };
      const inserted = await insertWorkOrder(orderData, warrantyStatus);

      // Append to Google Sheet (non-blocking, log-only on failure)
      appendToSheet([String(chatId), data.model, data.issue, data.issue_type, data.country || "MY", data.invoice, warrantyStatus, data.address, data.preferred_time || data.preferredTime || "", new Date().toISOString()]);

      // Build final message
      let finalMsg = clean;
      let recordedMsg = tr("workorder_recorded", lang);
      if (warrantyMsg) {
        finalMsg = (finalMsg ? finalMsg + "\n\n" : "") + warrantyMsg + "\n\n" + recordedMsg;
      } else {
        // No warranty info — just confirmation
        finalMsg = finalMsg || recordedMsg;
      }

      if (!inserted) {
        finalMsg += "\n\n" + tr("workorder_busy", lang);
      }

      // Send reply (strip marker)
      await sendWithSplit(chatId, finalMsg);
      return;
    }

    // ── Process COMPLAINT_READY marker ──────────────
    if (marker === "COMPLAINT_READY" && data) {
      const inserted = await insertComplaint(chatId, data.category, data.content);

      let finalMsg = clean;
      if (!inserted) {
        finalMsg += "\n\n" + tr("complaint_busy", lang);
      }

      await sendWithSplit(chatId, finalMsg);
      return;
    }

    // ── Process HANDOFF_READY marker (LLM-initiated escalation) ──
    if (marker === "HANDOFF_READY" && data) {
      await insertEscalation(chatId, data.reason || "other", data.summary || "");
      const finalMsg = clean || tr("handoff_recorded", lang);
      await sendWithSplit(chatId, finalMsg);
      return;
    }

    // ── No marker — send reply as-is ────────────────
    await sendWithSplit(chatId, reply);
  } catch (err) {
    console.error(`[chatId=${chatId}] Error:`, err.message);
    bot.sendMessage(chatId, tr("error_connect", detectLang(text)));
  }
}

// ── Helpers ──────────────────────────────────────
function splitMessage(text, maxLen = 4096) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Try to split at a newline within maxLen
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
}

async function sendWithSplit(chatId, text, options) {
  if (text.length <= 4096) {
    await bot.sendMessage(chatId, text, options);
  } else {
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, options);
    }
  }
}

// ── Graceful Shutdown ────────────────────────────
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stopPolling();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nShutting down...");
  bot.stopPolling();
  process.exit(0);
});

// ── Exports (tests) ──────────────────────────────
module.exports = {
  buildSystemPromptForTest: buildSystemPrompt,
  parseMarker,
  detectLangFromHistory,
  insertWorkOrder,
  classifyMedia,
  processCustomerText,
  buildInvoiceEcho, // pure helper, exported for tests
  // scenario-test seams (SKIP_BOT_INIT only)
  __getSent: () => __sentMessages.slice(),
  __clearSent: () => { __sentMessages.length = 0; },
};