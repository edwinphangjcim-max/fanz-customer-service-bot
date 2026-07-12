// ============================================
// transcribe.js — 语音消息转写（OpenAI audio transcriptions）
//
// 真实记录里客户大量用语音描述故障（马来客户尤其多），
// 只回"请打字"会流失一半售后入口。转写后的文字走与打字
// 完全相同的处理管线——钱红线、欠款门对语音同样生效。
//
// 依赖 OPENAI_API_KEY（与营销 bot 同一把）。未配置时调用方
// 自动退回"请打字"话术，不报错。
//
// Telegram 语音是 OGG/Opus（.oga）。OpenAI 按"文件扩展名"识别格式，
// 认 .ogg 但不认它的别名 .oga（线上实测 400 "Unsupported file format oga"，
// 2026-07-12）——发送前把 oga 归一成 ogg，字节完全不动。再保一道：
// 若仍被 400 拒格式，用 whisper-1 重试一次（格式支持面最广，实测 .oga 也收）。
// ============================================

// gpt-4o-transcribe: higher accuracy than the -mini variant, chosen for
// Malay + code-switched phone audio. Overridable via env to A/B later.
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
// 格式被拒时的兜底模型（格式支持面最广）
const TRANSCRIBE_FALLBACK_MODEL = process.env.TRANSCRIBE_FALLBACK_MODEL || "whisper-1";
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// 超过这个时长退回"请打字"（长语音转写慢、易含多个诉求，人工更合适）
const MAX_VOICE_SECONDS = 120;
// Telegram getFile 上限 20MB，留余量
const MAX_VOICE_BYTES = 19 * 1024 * 1024;

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// OpenAI 只认这些扩展名的常用别名归一（内容不动，只是改名）
function normalizeAudioFilename(filename) {
  const f = filename || "voice.ogg";
  return f.replace(/\.oga$/i, ".ogg");
}

async function callTranscriptionAPI(buffer, filename, model, signal) {
  const form = new FormData();
  form.append("model", model);
  form.append("file", new File([buffer], filename));
  // 不固定 language —— 客户可能说 BM/中文/英文，让模型自检
  const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal,
  });
  if (!resp.ok) {
    const errText = (await resp.text()).slice(0, 200);
    return { ok: false, status: resp.status, error: `transcription API ${resp.status}: ${errText}` };
  }
  const data = await resp.json();
  const text = (data.text || "").trim();
  if (!text) return { ok: false, status: 200, error: "empty transcription" };
  return { ok: true, text };
}

/**
 * 转写一段语音。
 *
 * @param {Buffer} buffer - 音频文件内容
 * @param {string} filename - 带扩展名的文件名（决定格式识别，如 voice.oga）
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function transcribeVoice(buffer, filename) {
  if (!isConfigured()) {
    return { ok: false, error: "OPENAI_API_KEY not configured" };
  }
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: "empty audio buffer" };
  }
  if (buffer.length > MAX_VOICE_BYTES) {
    return { ok: false, error: "audio too large" };
  }

  const name = normalizeAudioFilename(filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    let r = await callTranscriptionAPI(buffer, name, TRANSCRIBE_MODEL, controller.signal);
    // 主模型拒格式（400 unsupported）→ 用 whisper-1 兜底重试一次
    if (!r.ok && r.status === 400 && /unsupported/i.test(r.error || "") && TRANSCRIBE_FALLBACK_MODEL !== TRANSCRIBE_MODEL) {
      console.warn(`[transcribe] ${TRANSCRIBE_MODEL} rejected format, retrying with ${TRANSCRIBE_FALLBACK_MODEL}`);
      r = await callTranscriptionAPI(buffer, name, TRANSCRIBE_FALLBACK_MODEL, controller.signal);
    }
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, text: r.text };
  } catch (err) {
    const msg = err.name === "AbortError" ? `timeout after ${TRANSCRIBE_TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  transcribeVoice,
  isConfigured,
  MAX_VOICE_SECONDS,
  TRANSCRIBE_MODEL,
  TRANSCRIBE_FALLBACK_MODEL,
  normalizeAudioFilename,
};
