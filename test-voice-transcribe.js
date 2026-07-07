// ============================================
// test-voice-transcribe.js — 真实转写测试
//
// 用系统 TTS 合成一段真实音频，走真实 OpenAI 转写接口，
// 断言：1) 转写文字包含关键词  2) 转写结果能触发钱红线
// （证明语音和打字走同一套防线）。
//
// 需要 OPENAI_API_KEY。本测试在 macOS 上用 say/afconvert 合成音频；
// CI 无 say 时跳过合成用例。
// 运行：source .env && node test-voice-transcribe.js
// ============================================

const { execSync } = require("child_process");
const fs = require("fs");
const { transcribeVoice, isConfigured } = require("./lib/transcribe");
const { detectMoneyIntent } = require("./lib/guards");

let pass = 0, fail = 0;
const t = (cond, msg) => { cond ? (pass++, console.log(`PASS: ${msg}`)) : (fail++, console.error(`FAIL: ${msg}`)); };

(async () => {
  if (!isConfigured()) {
    console.error("OPENAI_API_KEY missing — cannot run real transcription test");
    process.exit(1);
  }

  // Guard behavior without audio (deterministic)
  const empty = await transcribeVoice(Buffer.alloc(0), "voice.oga");
  t(empty.ok === false, "empty buffer rejected gracefully");

  let canSynth = true;
  try { execSync("which say afconvert", { stdio: "ignore" }); } catch { canSynth = false; }
  if (!canSynth) {
    console.log("SKIP: say/afconvert unavailable — synthesized-audio cases skipped");
  } else {
    // voice defaults to English; pass a real language voice for non-English
    // (macOS default voice reads Malay text with English phonetics = fake
    // audio, which would unfairly fail the model — a real ms_MY voice is
    // required to actually exercise the Malay path).
    const hasMalayVoice = (() => {
      try { return /Amira/.test(execSync("say -v '?'").toString()); } catch { return false; }
    })();
    const mk = (text, name, voice) => {
      const v = voice ? `-v ${voice}` : "";
      execSync(`say ${v} -o /tmp/${name}.aiff ${JSON.stringify(text)}`);
      execSync(`afconvert -f m4af -d aac /tmp/${name}.aiff /tmp/${name}.m4a`);
      return fs.readFileSync(`/tmp/${name}.m4a`);
    };
    const names = [];
    const clip = (text, name, voice) => { names.push(name); return mk(text, name, voice); };

    // Case 1: English repair phrase
    const r1 = await transcribeVoice(clip("Hello, my ceiling fan is very noisy and cannot turn", "fanz-t1"), "voice.m4a");
    t(r1.ok === true, `EN repair phrase transcribed (got: "${(r1.text || r1.error || "").slice(0, 60)}")`);
    t(r1.ok && /fan/i.test(r1.text) && /(nois|turn)/i.test(r1.text), "EN transcription contains key words");

    // Case 2: voice discount attempt must trip the money guard (voice shares the pipeline)
    const r2 = await transcribeVoice(clip("Can you give me a discount for the repair", "fanz-t2"), "voice.m4a");
    t(r2.ok === true, `discount phrase transcribed (got: "${(r2.text || r2.error || "").slice(0, 60)}")`);
    t(r2.ok && detectMoneyIntent(r2.text) === "discount", "voice discount trips the money red line");

    // Case 3: real Malay fault description (only meaningful with a real ms_MY voice)
    if (hasMalayVoice) {
      const { detectRepairIntent } = require("./lib/guards");
      const r3 = await transcribeVoice(clip("kipas saya bising dan tak boleh pusing, tolong hantar technician", "fanz-t3", "Amira"), "voice.m4a");
      t(r3.ok === true, `MS repair phrase transcribed (got: "${(r3.text || r3.error || "").slice(0, 60)}")`);
      t(r3.ok && /kipas/i.test(r3.text) && detectRepairIntent(r3.text), "MS transcription understood + trips repair intent");
    } else {
      console.log("SKIP: no ms_MY voice (Amira) installed — Malay case skipped");
    }

    for (const n of names) {
      try { fs.unlinkSync(`/tmp/${n}.aiff`); fs.unlinkSync(`/tmp/${n}.m4a`); } catch (_) {}
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
