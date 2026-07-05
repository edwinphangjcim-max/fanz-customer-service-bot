// ============================================
// guards.js — 确定性防线（不依赖 LLM 自觉）
//
// 1. detectLang3: zh/en/ms 三语检测（含 BM 口语缩写）
// 2. detectMoneyIntent: 折扣/砍价、赔偿/索赔 —— 钱红线的代码层兜底，
//    命中即强制走固定话术转人工，即使 LLM 跑偏也不会说错话
// 3. detectRepairIntent: 报修意图（欠款门用）
// 4. isNudge: 孤立 "?"/催进度消息
//
// 词表来源：五段真实 WhatsApp 客服记录中的真实表达（已匿名化提炼）
// ============================================

// ── 三语检测 ─────────────────────────────────

// BM 口语词表（含真实记录中的缩写变体：x=tak, dtg=datang, skang=sekarang...）
const MS_WORDS = new Set([
  'boleh', 'bleh', 'tak', 'nak', 'kipas', 'rosak', 'esok', 'pergi', 'gi',
  'datang', 'dtg', 'bising', 'saya', 'awak', 'kami', 'kita', 'ni', 'tu',
  'dah', 'sudah', 'mcm', 'macam', 'la', 'lah', 'ke', 'kat', 'rumah',
  'balik', 'lagi', 'sikit', 'cepat', 'lambat', 'lewat', 'pukul', 'hari',
  'minggu', 'bulan', 'sampai', 'sampi', 'tolong', 'terima', 'kasih',
  'selamat', 'pagi', 'malam', 'petang', 'tengah', 'buat', 'betul',
  'salah', 'ada', 'tiada', 'xde', 'takde', 'jangan', 'jgn', 'sekarang',
  'skang', 'skrg', 'kena', 'masalah', 'baik', 'okey', 'ye', 'ya', 'tak',
  'apa', 'bila', 'mana', 'siapa', 'berapa', 'bunyi', 'pasang', 'tukar',
  'baru', 'lama', 'panas', 'angin', 'laju', 'perlahan', 'mati', 'hidup',
  'x', 'nk', 'ambil', 'anak', 'sekolah', 'hantar', 'kerja', 'cuti', 'saja', 'je',
]);

// en 里也常见的弱信号词，不单独计分（ya/la 在 Manglish 里到处都是；
// x/je 单独出现太模糊；ada 是英文人名/单词同形词——只与其他强信号组合时起作用）
const MS_WEAK = new Set(['ya', 'la', 'lah', 'ke', 'ni', 'tu', 'ok', 'okey', 'x', 'je', 'saja', 'ada']);

/**
 * 三语检测：'zh' | 'ms' | 'en'
 * 汉字 → zh；BM 强信号词 >= 2 或占比高 → ms；否则 en
 */
function detectLang3(text) {
  const t = (text || '').trim();
  if (!t) return 'en';
  if (/[一-鿿]/.test(t)) return 'zh';
  const words = t.toLowerCase().split(/[^a-z0-9²]+/).filter(Boolean);
  if (words.length === 0) return 'en';
  let strong = 0;
  for (const w of words) {
    if (MS_WORDS.has(w) && !MS_WEAK.has(w)) strong++;
  }
  // 短消息一个强信号词就够（真实消息经常只有两三个词："kipas rosak"）
  if (strong >= 2 || (strong >= 1 && words.length <= 4)) return 'ms';
  return 'en';
}

// ── 钱红线检测 ────────────────────────────────

// 折扣/砍价（en/zh/ms）
const DISCOUNT_PATTERNS = [
  // en / Manglish
  /\bdiscount\b/i, /\bcheaper\b/i, /\bcheap\s*(er|a bit|abit)?\b/i,
  /\bhalf\s*price\b/i, /\bless(er)?\s*(price|charge)\b/i,
  /\bnego(tiate|tiable)?\b/i, /\bwaive\b/i, /\bfoc\b/i, /\bfree\s*of\s*charge\b/i,
  /\bboss\s+(said|say|told|promised)\b/i, // "your boss said half price" 真实纠纷句式
  /\bbest\s*price\b/i, /\boffer\s*price\b/i,
  // zh
  /便宜/, /折扣/, /打折/, /优惠/, /减价/, /砍价/, /半价/, /免费(换|修|做)?/, /算便宜/, /老板(说|讲|答应)/, /少收/, /免掉/, /不用钱/,
  // ms
  /\bmurah\b/i, /\bdiskaun\b/i, /\bharga\s*(baik|special|runding)\b/i, /\bpercuma\b/i, /\bfree\b.*\b(ke|boleh)\b/i, /\bkurang(kan)?\s*(harga|bayar)\b/i,
];

// 赔偿/索赔（en/zh/ms）
const COMPENSATION_PATTERNS = [
  // en
  /\bcompensat(e|ion)\b/i, /\brefund\b/i, /\bclaim\b/i, /\bpay\s*(me\s*)?back\b/i,
  /\bmy\s*(annual\s*)?leave\b/i, // "compensate my leave" 真实句式
  /\breimburse\b/i, /\bmoney\s*back\b/i, /\bliab(le|ility)\b/i, /\bsue\b/i, /\blawyer\b/i, /\breport\s*(to\s*)?(case|consumer|tribunal)\b/i,
  // zh
  /赔偿/, /赔钱/, /赔我/, /退款/, /退钱/, /索赔/, /投诉到/, /消协/, /告你们/, /法律/, /律师/,
  // ms
  /\bganti\s*rugi\b/i, /\bpampasan\b/i, /\brefund\b/i, /\btuntut\b/i, /\bsaman\b/i,
];

/**
 * 钱红线检测：'discount' | 'compensation' | null
 * 命中即强制转人工，代码层保证不接话。
 */
function detectMoneyIntent(text) {
  const t = (text || '').trim();
  if (!t) return null;
  for (const p of COMPENSATION_PATTERNS) {
    if (p.test(t)) return 'compensation';
  }
  for (const p of DISCOUNT_PATTERNS) {
    if (p.test(t)) return 'discount';
  }
  return null;
}

// ── 报修意图（欠款门用）─────────────────────────

const REPAIR_PATTERNS = [
  // en / Manglish
  /\b(broken|broke|spoil(t|ed)?|faulty|problem|issue|not\s*working|cannot\s*(turn|on|work|move)|can'?t\s*(turn|on|work|move)|no\s*function|repair|fix|service|technician|noisy|noise|clicking|beeping|wobbl|balanc)\b/i,
  // zh
  /坏了?/, /故障/, /修理?/, /维修/, /报修/, /不(能|会)?(转|动|开)/, /开不了/, /有(声音|噪音|杂音)/, /师傅/, /上门/, /问题/,
  // ms
  /\brosak\b/i, /\bmasalah\b/i, /\bbising\b/i, /\btak\s*(boleh|jalan|pusing|hidup)\b/i, /\bx\s*(boleh|jalan|hidup)\b/i, /\bbaiki\b/i, /\bservis\b/i, /\bbunyi\b/i, /\bmati\b/i,
];

function detectRepairIntent(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return REPAIR_PATTERNS.some((p) => p.test(t));
}

// ── 催促识别 ─────────────────────────────────

/**
 * 孤立 "?"/"??" 或催进度短句 —— 真实客户用来催回复，
 * 不是"无法识别的输入"。
 */
function isNudge(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (/^[?？!！.。]{1,5}$/.test(t)) return true;
  if (/^(any\s*update(s)?|update\s*(pls|please)?|so\s*how|how\s*(ah|liao)?|hello+\??|halo+\??|还没(回|好)|怎么样了?|有消息(了)?吗|macam\s*mana|bila\s*(lagi)?|dah\s*ke)\s*[?？]?$/i.test(t)) return true;
  return false;
}

// ── 固定话术（三语）——钱红线与欠款门的出口消息 ─────

const SCRIPTS = {
  discount: {
    en: 'For pricing and any discount, I will pass you to my colleague to follow up ya. Someone will contact you within 24 hours. Anything else about the fan I can help first?',
    zh: '价钱和折扣方面我帮你转给同事跟进哦，24小时内会联络你。风扇其他方面有什么我可以先帮你的吗？',
    ms: 'Pasal harga dan diskaun, saya akan pass kepada colleague untuk follow up ya. Mereka akan hubungi awak dalam 24 jam. Ada apa-apa lagi pasal kipas yang saya boleh tolong dulu?',
  },
  compensation: {
    en: 'So sorry for the trouble caused ya. I will pass this to my colleague to follow up personally, someone will contact you within 24 hours. Meanwhile let me arrange the earliest slot possible for you first.',
    zh: '真的不好意思给你带来麻烦。这个我帮你转给同事亲自跟进，24小时内会联络你。我先尽快帮你安排最早的时间好吗。',
    ms: 'Minta maaf sangat atas kesulitan ya. Saya akan pass kepada colleague untuk follow up, mereka akan hubungi awak dalam 24 jam. Sementara tu saya cuba arrange slot paling awal untuk awak dulu.',
  },
  unpaid: {
    en: 'Hi, our record shows the previous service payment is still pending ya. Please help to settle it first, then we arrange the new appointment for you right away. My colleague will contact you to confirm, thanks for understanding.',
    zh: '这边记录显示上次服务的费用还没结清哦。麻烦先清一下，我们马上帮你排新的。同事会联络你确认，谢谢理解。',
    ms: 'Hi, rekod kami tunjuk bayaran service sebelum ni belum selesai ya. Tolong settle dulu, lepas tu kami terus arrange appointment baru untuk awak. Colleague kami akan hubungi awak untuk confirm, terima kasih.',
  },
  nudge: {
    en: 'Sorry for the wait ya, I will chase my colleague and get back to you as soon as possible.',
    zh: '不好意思让你久等了，我帮你催一下同事，尽快回复你哦。',
    ms: 'Maaf sebab tunggu lama ya, saya akan kejar colleague dan reply awak secepat mungkin.',
  },
  media_photo: {
    en: 'Got it, received your photo ya. Can you describe the problem briefly in text so I can help arrange?',
    zh: '收到你的照片了哦。可以用文字简单讲一下问题吗，我好帮你安排。',
    ms: 'Okay, dah terima gambar awak ya. Boleh describe masalah tu sikit dalam text supaya saya boleh tolong arrange?',
  },
  media_video: {
    en: 'Got it, received your video ya, we will show it to our technician. Can you describe the problem briefly in text as well?',
    zh: '收到你的视频了哦，我们会给师傅看。也可以用文字简单讲一下问题吗？',
    ms: 'Okay, dah terima video awak ya, kami akan tunjuk kepada technician. Boleh describe masalah tu sikit dalam text juga?',
  },
  media_voice: {
    en: 'Sorry ya, I cannot listen to voice messages here. Can you type it out briefly, or send a photo/video of the fan?',
    zh: '不好意思哦，语音我这边听不了。可以打字简单讲一下，或者拍个风扇的照片/视频吗？',
    ms: 'Maaf ya, saya tak boleh dengar voice message kat sini. Boleh taip sikit, atau hantar gambar/video kipas tu?',
  },
  media_other: {
    en: 'Received your file ya. Can you describe the problem briefly in text so I can help arrange?',
    zh: '收到你的文件了哦。可以用文字简单讲一下问题吗，我好帮你安排。',
    ms: 'Dah terima file awak ya. Boleh describe masalah tu sikit dalam text supaya saya boleh tolong arrange?',
  },
};

function script(key, lang) {
  const entry = SCRIPTS[key];
  if (!entry) return '';
  return entry[lang] || entry.en;
}

module.exports = {
  detectLang3,
  detectMoneyIntent,
  detectRepairIntent,
  isNudge,
  script,
  SCRIPTS,
  // exposed for tests
  MS_WORDS,
  DISCOUNT_PATTERNS,
  COMPENSATION_PATTERNS,
};
