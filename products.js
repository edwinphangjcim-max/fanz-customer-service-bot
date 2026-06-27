// Fanz Sdn Bhd — Product Knowledge Database
// Used by the bot's system prompt. Do not edit prices or warranty here.

const company = {
  name: "Fanz Sdn Bhd",
  yearsInBusiness: "10 years (Malaysia)",
  warrantyNote: "Motor 10 years, Receiver/LED 2 years, On-site service 1-2 years (by invoice year). Void for damage, pets, incorrect installation.",
  services: "Malaysia & Singapore on-site service",
  certifications: [
    "SIRIM certified",
    "Suruhanjaya Tenaga approved",
    "Product liability insurance RM 1,000,000",
  ],
  businessHours: "Monday to Friday 9:00 AM – 5:30 PM / 周一至五 9:00AM–5:30PM",
  contactPhone: "+60 17-707 1366",
  contactEmail: "contact@fanz.my",
  address: "No 5, Jalan Ekoperniagaan 1/26, Taman Ekoperniagaan, 81100 Johor Bahru, Johor",
};

const products = [
  {
    id: "fs-series",
    name: "FS Series 563 L",
    nameZh: "FS系列 563升",
    bladeSize: '56" L-type fan blades',
    bladeSizeZh: '56寸 L型扇叶',
    features: [
      "Smart control",
      "DC motor",
      "Large living room / large space",
    ],
    featuresZh: [
      "智能控制",
      "DC马达",
      "适合客厅大空间",
    ],
    type: "Smart",
    typeZh: "智能款",
  },
  {
    id: "grande-l",
    name: "Grande L Series",
    nameZh: "Grande L系列",
    bladeSize: '56" ABS fan blades',
    bladeSizeZh: '56寸 ABS扇叶',
    features: [
      "22W LED light",
      "DC motor",
      "Energy saving",
      "Living room / dining room",
    ],
    featuresZh: [
      "22W LED灯",
      "DC马达",
      "节能",
      "适合客厅餐厅",
    ],
    type: "Non-Smart",
    typeZh: "非智能款",
  },
  {
    id: "smart-series",
    name: "Smart Series",
    nameZh: "Smart系列",
    bladeSize: null,
    bladeSizeZh: null,
    features: [
      "WiFi remote control",
      "Multi-speed adjustment",
      "Multi-level LED brightness",
      "Scheduled timing",
      "Smart home integration",
    ],
    featuresZh: [
      "WiFi远程控制",
      "多档调速",
      "多级LED亮度",
      "定时排程",
      "智能家居",
    ],
    type: "Smart",
    typeZh: "智能款",
  },
  {
    id: "aura",
    name: "AURA Series",
    nameZh: "AURA系列",
    bladeSize: null,
    bladeSizeZh: null,
    features: [
      "Compact design",
      "Small space / low ceiling",
      "Bedroom / small room",
    ],
    featuresZh: [
      "紧凑型",
      "适合小空间低天花板",
      "适合卧室小房间",
    ],
    type: "Non-Smart",
    typeZh: "非智能款",
  },
];

module.exports = { company, products };