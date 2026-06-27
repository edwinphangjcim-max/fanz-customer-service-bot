// ============================================
// test-warranty.js — Fanz 真实保修规则自测
//
// 验证 lib/warranty.js 的保修计算逻辑
// 包含用户指定的所有断言
// ============================================

const assert = require('assert');
const w = require('./lib/warranty');

let exitCode = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  exitCode = 1;
}

// ============================================
console.log('=== Fanz 保修规则自测 ===\n');

// ──────────────────────────────────────────
// 1. 马达10年：2020年买的马达还在保（2030年才到期）
// ──────────────────────────────────────────
console.log('Test 1: Motor 10yr — 2020 purchase still in warranty');
try {
  const r = w.calcWarrantyStatus('2020-01-01', 'motor', 'MY');
  assert.strictEqual(r.inWarranty, true, 'Motor 10yr from 2020 should still be in warranty');
  assert.strictEqual(r.warrantyPeriodYears, 10, 'Motor period should be 10 years');
  console.log(`  PASS (inWarranty=${r.inWarranty}, period=${r.warrantyPeriodYears}yr)`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 2. 马达10年：2014年买的马达已过保（2024年到期）
// ──────────────────────────────────────────
console.log('Test 2: Motor 10yr — 2014 purchase out of warranty');
try {
  const r = w.calcWarrantyStatus('2014-01-01', 'motor', 'MY');
  assert.strictEqual(r.inWarranty, false, 'Motor 10yr from 2014 should be out of warranty');
  console.log(`  PASS (inWarranty=${r.inWarranty})`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 3. 接收器2年：2024-06-01买的，接收器过保（2年到2026-06-01，今天2026-06-27）
// ──────────────────────────────────────────
console.log('Test 3: Receiver 2yr — 2024-06-01 purchase out of warranty');
try {
  const r = w.calcWarrantyStatus('2024-06-01', 'receiver', 'MY');
  assert.strictEqual(r.inWarranty, false, 'Receiver 2yr from 2024-06-01 should be out of warranty');
  assert.strictEqual(r.warrantyPeriodYears, 2, 'Receiver period should be 2 years');
  assert.ok(r.chargeIfOver && r.chargeIfOver.includes('RM 120'), `Charge should be RM 120, got "${r.chargeIfOver}"`);
  console.log(`  PASS (inWarranty=${r.inWarranty}, charge=${r.chargeIfOver})`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 4. 上门服务1年：2024年购买，onsite保1年
// ──────────────────────────────────────────
console.log('Test 4: Onsite 1yr — 2024 purchase');
try {
  const r = w.calcWarrantyStatus('2024-12-01', 'onsite', 'MY');
  assert.strictEqual(r.warrantyPeriodYears, 1, '2024 purchase should have 1yr onsite warranty');
  console.log(`  PASS (period=${r.warrantyPeriodYears}yr)`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 5. 上门服务2年：2025年起购买，onsite保2年
// ──────────────────────────────────────────
console.log('Test 5: Onsite 2yr — 2025 purchase');
try {
  const r = w.calcWarrantyStatus('2025-01-01', 'onsite', 'MY');
  assert.strictEqual(r.warrantyPeriodYears, 2, '2025 purchase should have 2yr onsite warranty');
  console.log(`  PASS (period=${r.warrantyPeriodYears}yr)`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 6. 新加坡版本：LED板过保收费 SGD 15
// ──────────────────────────────────────────
console.log('Test 6: SG version — LED plate charge is $15');
try {
  const r = w.calcWarrantyStatus('2024-01-01', 'led_plate', 'SG');
  assert.strictEqual(r.inWarranty, false, 'LED plate from 2024 should be out of warranty');
  assert.strictEqual(r.warrantyPeriodYears, 2, 'LED plate period should be 2 years');
  assert.ok(r.chargeIfOver && r.chargeIfOver.includes('SGD 15'), `Charge should be SGD 15, got "${r.chargeIfOver}"`);
  console.log(`  PASS (charge=${r.chargeIfOver})`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 7. 保修失效：被狗咬了
// ──────────────────────────────────────────
console.log('Test 7: Warranty void — dog bite');
try {
  const r = w.isWarrantyVoid('我的风扇被狗咬坏了');
  assert.strictEqual(r.mayBeVoid, true, 'Dog bite should trigger void');
  assert.ok(r.reason && r.reason.includes('宠物'), `Reason should mention pets, got "${r.reason}"`);
  console.log(`  PASS (mayBeVoid=${r.mayBeVoid}, reason="${r.reason}")`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 8. 正常马达问题不被标记为保修失效
// ──────────────────────────────────────────
console.log('Test 8: Warranty void — normal motor issue NOT void');
try {
  const r = w.isWarrantyVoid('马达不转了，有异响');
  assert.strictEqual(r.mayBeVoid, false, 'Normal motor issue should not be void');
  console.log(`  PASS (mayBeVoid=${r.mayBeVoid})`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 9. 未知部件类型返回概括信息
// ──────────────────────────────────────────
console.log('Test 9: Unknown issue type returns summary info');
try {
  const r = w.calcWarrantyStatus('2023-01-01', 'unknown', 'MY');
  assert.ok(r.notes.length > 0, 'Should have notes for unknown type');
  console.log(`  PASS (inWarranty=${r.inWarranty}, notes="${r.notes[0].slice(0, 60)}...")`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 10. 天灾关键词触发保修失效
// ──────────────────────────────────────────
console.log('Test 10: Warranty void — flood damage');
try {
  const r = w.isWarrantyVoid('淹水导致风扇坏了');
  assert.strictEqual(r.mayBeVoid, true, 'Flood should trigger void');
  assert.ok(r.reason && r.reason.includes('天灾'), `Reason should mention natural disaster, got "${r.reason}"`);
  console.log(`  PASS (mayBeVoid=${r.mayBeVoid}, reason="${r.reason}")`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 11. 不涵盖配件列表
// ──────────────────────────────────────────
console.log('Test 11: Excluded parts list');
try {
  const parts = w.getExcludedParts();
  assert.ok(Array.isArray(parts), 'Should return array');
  assert.ok(parts.length >= 5, `Expected at least 5 excluded parts, got ${parts.length}`);
  assert.ok(parts.includes('扇叶'), 'Fan blades should be excluded');
  assert.ok(parts.includes('遥控器'), 'Remote should be excluded');
  console.log(`  PASS (${parts.length} parts: ${parts.join(', ')})`);
} catch (e) { fail(e.message); }

// ──────────────────────────────────────────
// 12. 2026年买的接收器还在保（边界测试）
// ──────────────────────────────────────────
console.log('Test 12: Receiver 2yr — 2026-01-01 purchase still in warranty');
try {
  const r = w.calcWarrantyStatus('2026-01-01', 'receiver', 'MY');
  assert.strictEqual(r.inWarranty, true, 'Receiver 2yr from 2026-01-01 should still be in warranty');
  console.log(`  PASS (inWarranty=${r.inWarranty})`);
} catch (e) { fail(e.message); }

// ============================================
console.log('');
if (exitCode === 0) {
  console.log('=== All warranty tests passed ===');
} else {
  console.error(`=== Some tests FAILED (exit code ${exitCode}) ===`);
}
process.exit(exitCode);