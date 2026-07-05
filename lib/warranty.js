// ============================================
// warranty.js — Fanz/Vioz 真实保修规则
//
// 依据：官方 Warranty Policy 文件（docs/warranty-policy.pdf，2026-07 比对）
//
// 两个品牌，保修期不同（这是关键——报错品牌就是报错保修期）：
// - Fanz 品牌：马达 10 年
// - Vioz 品牌：马达 5 年，且政策未列 LED 条目（LED 类问题按人工核实处理）
//
// 共同部分（从 invoice 购买日期起算）：
// - 接收器(Receiver)：2年，过保收费 RM 120 / SGD 60
// - LED板(Led Plate)：2年，过保收费 RM 35 / SGD 15（仅 Fanz）
// - LED套件(Led Kit)：2年，过保收费 RM 100 / SGD 35（仅 Fanz）
// - 上门服务(On Site)：2025年前发票 1 年、2025 起 2 年，过保收费 RM 60 / SGD 60
//
// 政策要点：
// - 授权经销商开具的发票即为有效购买凭证（经销商渠道购买同样保修）
// - 保修失效（人为/天灾/宠物等）时：运费、人工、配件全部收费
// - Fanz 保留修改条款的权利——对客户话术须带"以最新官方政策为准"
// ============================================

const BRANDS = ['fanz', 'vioz'];

// 过保收费（马来西亚 MY / 新加坡 SG）——两品牌同价，Vioz 无 LED 条目
const CHARGES = {
  MY: {
    receiver: { amount: 120, currency: 'RM' },
    led_plate: { amount: 35, currency: 'RM' },
    led_kit: { amount: 100, currency: 'RM' },
    onsite: { amount: 60, currency: 'RM' },
  },
  SG: {
    receiver: { amount: 60, currency: 'SGD' },
    led_plate: { amount: 15, currency: 'SGD' },
    led_kit: { amount: 35, currency: 'SGD' },
    onsite: { amount: 60, currency: 'SGD' },
  },
};

// 各部件保修期限（年），按品牌
const WARRANTY_PERIODS = {
  fanz: {
    motor: 10,
    receiver: 2,
    led_plate: 2,
    led_kit: 2,
  },
  vioz: {
    motor: 5,
    receiver: 2,
    // 政策未列 Vioz 的 LED 条目——LED 问题不给自动判定，走人工
  },
};

// 上门服务保修年限由购买年份决定（两品牌相同）
// 2025年前购买 → 1年；2025年起购买 → 2年
const ONSITE_START_YEAR = 2025;

// ============================================
// 型号 → 品牌映射
// 客户报型号的写法非常乱（真实记录：g45x3 / GRANDE 45 & 52 / GRANDE523），
// 这里只做品牌归属判断。清单待 Fanz 确认后填充——
// 在此之前宁可返回 unknown（bot 会先问品牌，不下保修结论）。
// ============================================
const MODEL_BRAND_MAP = {
  // 待 Fanz 确认后填充，例如：
  // 'v605': 'vioz',
  // 'axel': 'fanz',
  // 'fs563l': 'fanz',
  // 'grande': 'fanz',
  // 'aura': 'fanz',
};

// 型号前缀规则（比精确映射优先级低）——同样待确认，先留空
const MODEL_BRAND_PREFIXES = [
  // { prefix: 'v', brand: 'vioz' },  // 待确认 V 系列是否全部属 Vioz
];

/**
 * 从客户报的型号文本推断品牌。
 * @param {string} modelText - 客户输入的型号（大小写/空格/写法混乱）
 * @returns {'fanz'|'vioz'|'unknown'}
 */
function inferBrand(modelText) {
  const norm = (modelText || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return 'unknown';
  for (const [key, brand] of Object.entries(MODEL_BRAND_MAP)) {
    if (norm.includes(key)) return brand;
  }
  for (const { prefix, brand } of MODEL_BRAND_PREFIXES) {
    if (norm.startsWith(prefix)) return brand;
  }
  return 'unknown';
}

// 保修失效关键词（注意：目前仅中文——en/BM 关键词是已知缺口，排第二批）
const VOID_REASONS = [
  { keywords: ['天灾', '洪水', '水灾', '淹', '雷击', '闪电', '打雷', '地震', '台风', '火灾', '火烧'], reason: '天灾（洪水、雷击、火灾等）' },
  { keywords: ['人为', '摔', '砸', '撞', '掉下来', '跌', '拆坏', '改装', '自己修'], reason: '人为损坏' },
  { keywords: ['宠物', '狗咬', '猫抓', '老鼠'], reason: '宠物破坏' },
  { keywords: ['安装错', '装错', '没按', '不按', '错误安装', '不正确安装'], reason: '错误安装或不按用户手册使用' },
  { keywords: ['电压', '发电机', '不稳', '过高', '低电压', '高电压'], reason: '异常电压或发电机使用' },
  { keywords: ['化学品', '腐蚀', '化学'], reason: '腐蚀性化学品接触' },
  { keywords: ['运输', '搬运', '搬家'], reason: '运输/搬运损坏' },
];

// 不涵盖配件
const EXCLUDED_PARTS = ['旋钮', '镇流器', '灯泡', '电池', '拉链', '遥控器', '扇叶', '外壳'];

// 政策免责话术（所有保修判定消息末尾统一带上）
const POLICY_DISCLAIMER = '保修条款以最新官方政策为准。具体情况以师傅上门确认为准。';

/**
 * 计算保修状态
 *
 * @param {string} purchaseDate - 购买日期 (YYYY-MM-DD 或 Date string)
 * @param {string} issueType - 问题部件 ('motor' | 'receiver' | 'led_plate' | 'led_kit' | 'onsite' | 'unknown')
 * @param {string} [country='MY'] - 国家 ('MY' | 'SG')
 * @param {string} [brand='fanz'] - 品牌 ('fanz' | 'vioz' | 'unknown')
 * @returns {{ inWarranty: boolean, warrantyPeriodYears: number, chargeIfOver: string|null, needsBrand?: boolean, notes: string[] }}
 */
function calcWarrantyStatus(purchaseDate, issueType, country = 'MY', brand = 'fanz') {
  const purchased = new Date(purchaseDate);
  const now = new Date();
  const notes = [];

  if (isNaN(purchased.getTime())) {
    return {
      inWarranty: false,
      warrantyPeriodYears: 0,
      chargeIfOver: null,
      notes: ['无法识别的购买日期，请联系客服人工核实。'],
    };
  }

  // 品牌未知 + 与品牌相关的部件（马达/LED）——不下结论，要求先确认品牌。
  // Fanz 马达 10 年、Vioz 只有 5 年，猜错就是对客户报错保修期。
  const brandSensitive = ['motor', 'led_plate', 'led_kit', 'unknown'];
  if (!BRANDS.includes(brand) && brandSensitive.includes(issueType || 'unknown')) {
    return {
      inWarranty: false,
      warrantyPeriodYears: 0,
      chargeIfOver: null,
      needsBrand: true,
      notes: [
        '需要先确认风扇品牌（Fanz 或 Vioz）才能判断保修——两个品牌的马达保修期不同。',
        '同事会根据 invoice 核实品牌和保修状态。',
      ],
    };
  }

  const periods = WARRANTY_PERIODS[brand] || WARRANTY_PERIODS.fanz;

  if (issueType === 'unknown' || !issueType) {
    // 不确定哪个部件，给概括信息（此时品牌已知）
    const motorYears = periods.motor;
    const motorExpiry = new Date(purchased);
    motorExpiry.setFullYear(motorExpiry.getFullYear() + motorYears);
    const motorInWarranty = now < motorExpiry;
    return {
      inWarranty: motorInWarranty,
      warrantyPeriodYears: motorYears,
      chargeIfOver: null,
      notes: [
        `不确定具体哪个部件有问题。${brand === 'vioz' ? 'Vioz' : 'Fanz'} 马达${motorYears}年保修` + (motorInWarranty ? '（在保）' : '（已过期）'),
        '其他部件（接收器/LED等）需确认后再查',
        '师傅上门后会进一步确认具体情况',
      ],
    };
  }

  let periodYears;
  let chargeInfo = null;

  if (issueType === 'onsite') {
    // 上门服务：按购买年份（两品牌相同）
    const purchaseYear = purchased.getFullYear();
    periodYears = purchaseYear >= ONSITE_START_YEAR ? 2 : 1;
  } else if (periods[issueType] !== undefined) {
    periodYears = periods[issueType];
  } else if (brand === 'vioz' && (issueType === 'led_plate' || issueType === 'led_kit')) {
    // Vioz 无 LED 保修条目——不自动判定
    return {
      inWarranty: false,
      warrantyPeriodYears: 0,
      chargeIfOver: null,
      notes: ['Vioz 产品的 LED 部件保修需人工核实，同事会跟进确认。'],
    };
  } else {
    return {
      inWarranty: false,
      warrantyPeriodYears: 0,
      chargeIfOver: null,
      notes: ['未知的部件类型，请联系客服。'],
    };
  }

  // 计算到期日
  const expires = new Date(purchased);
  expires.setFullYear(expires.getFullYear() + periodYears);
  const inWarranty = now < expires;

  // 过保收费
  const countryCharges = CHARGES[country] || CHARGES.MY;
  if (countryCharges[issueType]) {
    const c = countryCharges[issueType];
    chargeInfo = `${c.currency} ${c.amount}`;
  }

  // 起算说明
  notes.push(`保修从购买日期（${purchaseDate}）起算`);

  // 额外限制
  if (inWarranty) {
    notes.push('如果属于保修失效情况（如天灾、人为损坏等），即使在期内也不保，且运费、人工、配件均需收费');
  }

  // 12尺以上安装额外收费提醒（仅上门服务类型）
  if (issueType === 'onsite') {
    notes.push('12尺以上安装需额外收服务费');
  }

  return {
    inWarranty,
    warrantyPeriodYears: periodYears,
    chargeIfOver: chargeInfo,
    notes,
  };
}

/**
 * 判断问题描述是否可能属于保修失效情况
 *
 * @param {string} reason - 客户描述的问题文本
 * @returns {{ mayBeVoid: boolean, reason: string|null }}
 */
function isWarrantyVoid(reason) {
  if (!reason || typeof reason !== 'string') {
    return { mayBeVoid: false, reason: null };
  }

  const text = reason.toLowerCase();

  for (const vr of VOID_REASONS) {
    for (const kw of vr.keywords) {
      if (text.includes(kw.toLowerCase())) {
        return { mayBeVoid: true, reason: vr.reason };
      }
    }
  }

  return { mayBeVoid: false, reason: null };
}

/**
 * 获取不涵盖配件列表
 */
function getExcludedParts() {
  return [...EXCLUDED_PARTS];
}

module.exports = {
  calcWarrantyStatus,
  isWarrantyVoid,
  getExcludedParts,
  inferBrand,
  BRANDS,
  MODEL_BRAND_MAP,
  WARRANTY_PERIODS,
  ONSITE_START_YEAR,
  CHARGES,
  VOID_REASONS,
  POLICY_DISCLAIMER,
};
