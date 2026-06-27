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

// Warranty rules — real Fanz policy from lib/warranty.js
const { calcWarrantyStatus, isWarrantyVoid } = require("./lib/warranty");

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
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

  return `You are the customer service assistant for Fanz Sdn Bhd, a Malaysian ceiling fan company. Reply in the customer's language (Chinese or English). Keep every message short and natural, like a real person chatting on WhatsApp. Ask only one thing at a time.

=== COMPANY INFO ===
Company: Fanz Sdn Bhd
Address: ${company.address}
Phone: ${company.contactPhone}
Email: ${company.contactEmail}
Business Hours: ${company.businessHours}
Service Area: ${company.services}
Certifications: ${company.certifications.join(", ")}
Years in Business: ${company.yearsInBusiness}
Motor Warranty: ${company.warrantyNote}

=== PRODUCT INFO ===
${productLines}

=== RULES ===

1. DO NOT make up prices. If customer asks price, just say need our sales team quote, and pass them the phone/email.

2. WARRANTY CHECK: The system checks warranty automatically AFTER all 5 items are collected and you output the DATA marker. You NEVER check anything yourself. You NEVER say you're checking. You NEVER ask the customer to wait.
   STRICTLY FORBIDDEN: Never say "let me check", "checking", "one moment", "please wait", "查询中", "稍等", "让我查一下" or any variation.
   Your ONLY job regarding warranty: ask for the invoice number in Step 3, note it down, and move to Step 4. That's it.

3. There are THREE service lines. Figure out which one from customer's message:

LINE A — Product Inquiry: Answer about models, features, suitable room size, differences. Use the product info above. Helpful but don't push sales.

LINE B — Repair / Maintenance: Collect these SIX things ONE AT A TIME. After each reply, immediately ask the next one — no delays, no checking, no waiting. Do NOT ask all six at once. Short confirm (1-3 words max) + next question only. Don't repeat what customer just said. Don't thank after every reply.
   Step 1 — Model / fan name
   Step 2 — What's the problem  AND  Which part is having the issue（马达/Motor、接收器/Receiver、LED灯/LED、遥控器/Remote、要求上门服务/On-site service、其他/Other — pick one）
   Step 3 — Invoice number (just ask for it, no explanation)
   Step 4 — Address for service visit
   Step 5 — Preferred date and time
After all 6 collected, STRICTLY FORBIDDEN: Do NOT write ANY closing/confirmation message. Just output the DATA marker on the last line. The system will automatically send the confirmation to the customer.
   **IMPORTANT — data output format**: On the LAST LINE of your response, output EXACTLY this format (no extra characters):
   ||DATA||{"model":"[model]","issue":"[issue]","issue_type":"[motor|receiver|led_plate|led_kit|onsite|unknown]","invoice":"[invoice]","address":"[address]","preferred_time":"[time]","country":"[MY|SG]"}||END||[WORKORDER_READY]
   Replace [bracketed] fields with what customer provided. If any field missing, use empty string. issue_type should be one of: motor, receiver, led_plate, led_kit, onsite, unknown. country defaults to MY unless customer mentions Singapore.
   This line is internal, will be stripped before customer sees it.

LINE C — Complaint: Listen properly, acknowledge, say will pass to the relevant colleague. Don't argue, don't defend, don't over-apologize. Keep it short.
   **IMPORTANT — data output format**: When wrapping up, on the LAST LINE output:
   ||DATA||{"category":"product|installation|logistics|other","content":"[summary of complaint]"}||END||[COMPLAINT_READY]

4. HANDOFF TO HUMAN: If customer angry, asking something you can't handle, or wants human, reply (Chinese): "了解，我帮你转给同事跟进。麻烦留个联络号码，24小时内有人联系你。" / (English): "Noted, let me pass you to a human colleague. Drop your contact number, someone will reach out within 24 hours."

5. LANGUAGE: Match customer's language. If they mix Chinese and English (rojak style), you can mix naturally too. Chinese style: Malaysian Chinese, casual WhatsApp tone — short sentences, no mainland Chinese officialese ("请您"、"为您服务"、"亲"). Use natural words like 师傅, 上门, 联络, 报修, 麻烦, 帮你看下, 没问题, 好的, 收到. English style: short, plain Malaysian business English. No flowery phrases.

6. PERSONALITY:
   - Short, direct, friendly. One question at a time.
   - No emoji in any response. Not in text, not in option lists.
   - When listing options, use plain "1." "2." "3." (NOT 1️⃣ 2️⃣ 3️⃣).
   - Don't repeat what customer just said back to them.
   - Don't thank customer in every message. Once is enough.
   - No long preambles. Get to the point.

7. If not sure about something, just say so and offer to pass to human team.`;
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

// Insert work order into Supabase
async function insertWorkOrder(data, warrantyStatus) {
  if (!SUPABASE_SERVICE_KEY) {
    console.warn("SUPABASE_SERVICE_KEY not set — skipping work order insert");
    return false;
  }
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/work_orders`, {
      method: "POST",
      headers: SUPABASE_HEADERS,
      body: JSON.stringify({
        chat_id: data.chatId ? String(data.chatId) : "",
        model: data.model || "",
        issue: data.issue || "",
        issue_type: data.issue_type || "",
        country: data.country || "MY",
        invoice_number: data.invoice || "",
        warranty_status: warrantyStatus || "unknown",
        address: data.address || "",
        preferred_time: data.preferredTime || "",
        status: "new",
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`Supabase insertWorkOrder failed (${resp.status}):`, errText);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Supabase insertWorkOrder error:", err.message);
    return false;
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
function detectLang(text) {
  return /[一-鿿]/.test(text || "") ? "zh" : "en";
}

// Detect language from conversation history (last 3 user messages + current text)
function detectLangFromHistory(chatId, currentText) {
  // Check current text first
  if (detectLang(currentText) === "zh") return "zh";
  // Check last 3 user messages in history
  const history = getHistory(chatId);
  let checked = 0;
  for (let i = history.length - 1; i >= 0 && checked < 3; i--) {
    if (history[i].role === "user") {
      if (detectLang(history[i].content) === "zh") return "zh";
      checked++;
    }
  }
  return "en";
}

const TRANSLATIONS = {
  warranty_not_found: {
    en: "ℹ️ We could not find this invoice in our system. A colleague will manually verify your warranty status.",
    zh: "ℹ️ 找不到这个 invoice 号码。同事会帮你手动查一下保修。",
  },
  workorder_recorded: {
    en: "✅ Your repair request has been recorded. Our technician will contact you to arrange the visit.",
    zh: "✅ 维修申请已收到。师傅会联络你安排上门。",
  },
  workorder_busy: {
    en: "⚠️ System is temporarily busy. Your request has been forwarded to our human team who will follow up with you. Thank you for your patience.",
    zh: "⚠️ 系统暂时 busy。你的申请已转给同事跟进，他们会联络你。",
  },
  complaint_busy: {
    en: "⚠️ System is temporarily busy. Your feedback has been forwarded to our human team who will personally follow up with you.",
    zh: "⚠️ 系统暂时 busy。你的反馈已转给同事亲自跟进。",
  },
  error_connect: {
    en: "Sorry, I'm having trouble connecting right now. Please try again later.",
    zh: "抱歉，我暂时连不上，请稍后再试。",
  },
};

function tr(key, lang, params) {
  const entry = TRANSLATIONS[key];
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
    zh: `你好！欢迎来到 Fanz Sdn Bhd 客服中心

我们是一家拥有10年经验的马来西亚吊扇公司，产品通过 SIRIM 认证和 Suruhanjaya Tenaga 批准。

请问需要什么帮助？
1. 产品咨询 — 了解我们的吊扇系列
2. 报修/维修 — 预约上门维修
3. 投诉与反馈 — 分享你的意见

请在聊天框中直接告诉我你的问题，我会尽力协助你！如果需要人工客服，随时告知。`,

    en: `Hello! Welcome to Fanz Sdn Bhd Customer Service

We are a 10-year-experienced Malaysian ceiling fan company with SIRIM certification and Suruhanjaya Tenaga approval.

How can I help you today?
1. Product Inquiry — Learn about our ceiling fan series
2. Repair / Maintenance — Schedule an on-site service
3. Complaint & Feedback — Share your thoughts

Just tell me your questions in the chat and I'll be happy to help! If you need a human agent, just let me know.`,
  };
}

// ── Bot Setup ────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

console.log("Fanz Customer Service Bot starting... (polling mode)");

// ── /start command ───────────────────────────────
bot.onText(/^\/start/, (msg) => {
  const chatId = msg.chat.id;
  clearHistory(chatId);

  const text = msg.text || "";
  // if user sent "/start en", show English only
  const wantsEnglish = text.toLowerCase().includes(" en");
  if (wantsEnglish) {
    bot.sendMessage(chatId, buildWelcome().en);
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

// ── Message Handler ──────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // Skip commands handled above
  if (text.startsWith("/")) return;

  // Ignore empty messages
  if (!text) return;

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");

  try {
    // Build message array: system + history + current message
    const history = getHistory(chatId);
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: text },
    ];

    // Call OpenRouter
    const reply = await askOpenRouter(messages);

    // Save to history (original reply including marker)
    appendHistory(chatId, "user", text);
    appendHistory(chatId, "assistant", reply);

    // Parse marker from response
    const { clean, marker, data } = parseMarker(reply);

    // Detect language from conversation history (not just current message)
    const lang = detectLangFromHistory(chatId, text);

    // ── Process WORKORDER_READY marker ──────────────
    if (marker === "WORKORDER_READY" && data) {
      let warrantyMsg = "";
      let warrantyStatus = "unknown";

      // Look up invoice for warranty check
      if (data.invoice) {
        const record = await lookupInvoice(data.invoice.trim());
        if (record) {
          const wResult = calcWarrantyStatus(
            record.purchase_date,
            data.issue_type || "unknown",
            data.country || "MY"
          );
          warrantyStatus = wResult.inWarranty ? "in_warranty" : "out_of_warranty";

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

          if (wResult.inWarranty) {
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

          // Complex warranty scenario disclaimer
          warrantyMsg += `\n\n*以上是根据 invoice 记录的信息。具体情况以师傅上门后确认为准。*`;
        } else {
          warrantyMsg = tr("warranty_not_found", lang);
        }
      }

      // Insert work order into Supabase
      const orderData = { ...data, chatId: String(chatId) };
      const inserted = await insertWorkOrder(orderData, warrantyStatus);

      // Append to Google Sheet (non-blocking, log-only on failure)
      appendToSheet([String(chatId), data.model, data.issue, data.issue_type, data.country || "MY", data.invoice, warrantyStatus, data.address, data.preferredTime, new Date().toISOString()]);

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

    // ── No marker — send reply as-is ────────────────
    await sendWithSplit(chatId, reply);
  } catch (err) {
    console.error(`[chatId=${chatId}] Error:`, err.message);
    bot.sendMessage(chatId, tr("error_connect", detectLang(text)));
  }
});

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