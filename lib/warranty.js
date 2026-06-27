// ============================================
// warranty.js — Fanz 真实保修规则
//
// 部件保修期（从 invoice 购买日期起算）
// - 马达(Motor)：10年
// - 接收器(Receiver)：2年，过保收费 RM 120 / SGD 60
// - LED板(Led Plate)：2年，过保收费 RM 35 / SGD 15
// - LED套件(Led Kit)：2年，过保收费 RM 100 / SGD 35
// - 上门服务(On Site)：1-2年（视购买年份），过保收费 RM 60 / SGD 60
// ============================================

// 过保收费（马来西亚 MY / 新加坡 SG）
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

// 各部件保修期限（年）
const WARRANTY_PERIODS = {
  motor: 10,
  receiver: 2,
  led_plate: 2,
  led_kit: 2,
};

// 上门服务保修年限由购买年份决定
// 2025年前购买 → 1年；2025年起购买 → 2年
const ONSITE_START_YEAR = 2025;

// 保修失效关键词
const VOID_REASONS = [
  { keywords: ['天灾', '洪水', '水灾', '淹', '雷击', '闪电', '打雷', '地震', '台风', '火灾', '火烧'], reason: '天灾（洪水、雷击、火灾等）' },
  { keywords: ['人为', '摔', '砸', '撞', '掉下来', '跌', '拆坏', '改装', '自己修'], reason: '人为损坏' },
  { keywords: ['宠物', '狗咬', '猫抓', '老鼠'], reason: '宠物破坏' },
  { keywords: ['安装错', '装错', '没按', '不按', '错误安装', '不正确安装'], reason: '错误安装或不按用户手册使用' },
  { keywords: ['电压', '发电机', '不稳', '过高', '低电压', '高电压'], reason: '异常电压或发电机使用' },
  { keywords: ['化学品', '腐蚀', '化学'], reason: '腐蚀性化学品接触' },
];

// 不涵盖配件
const EXCLUDED_PARTS = ['旋钮', '镇流器', '灯泡', '电池', '拉链', '遥控器', '扇叶', '外壳'];

/**
 * 计算保修状态
 *
 * @param {string} purchaseDate - 购买日期 (YYYY-MM-DD 或 Date string)
 * @param {string} issueType - 问题部件 ('motor' | 'receiver' | 'led_plate' | 'led_kit' | 'onsite' | 'unknown')
 * @param {string} [country='MY'] - 国家 ('MY' | 'SG')
 * @returns {{ inWarranty: boolean, warrantyPeriodYears: number, chargeIfOver: string|null, notes: string[] }}
 */
function calcWarrantyStatus(purchaseDate, issueType, country = 'MY') {
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

  if (issueType === 'unknown' || !issueType) {
    // 不确定哪个部件，给概括信息
    const motorExpiry = new Date(purchased);
    motorExpiry.setFullYear(motorExpiry.getFullYear() + WARRANTY_PERIODS.motor);
    const motorInWarranty = now < motorExpiry;
    return {
      inWarranty: motorInWarranty,
      warrantyPeriodYears: WARRANTY_PERIODS.motor,
      chargeIfOver: null,
      notes: [
        '不确定具体哪个部件有问题。马达10年保修' + (motorInWarranty ? '（在保）' : '（已过期）'),
        '其他部件（接收器/LED等）需确认后再查',
        '师傅上门后会进一步确认具体情况',
      ],
    };
  }

  let periodYears;
  let chargeInfo = null;

  if (issueType === 'onsite') {
    // 上门服务：按购买年份
    const purchaseYear = purchased.getFullYear();
    periodYears = purchaseYear >= ONSITE_START_YEAR ? 2 : 1;
  } else if (WARRANTY_PERIODS[issueType] !== undefined) {
    periodYears = WARRANTY_PERIODS[issueType];
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
    notes.push('如果属于保修失效情况（如天灾、人为损坏等），即使在期内也不保');
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
  WARRANTY_PERIODS,
  ONSITE_START_YEAR,
  CHARGES,
  VOID_REASONS,
};