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
// Telegram 语音是 OGG/Opus（.oga），转写接口原生支持，无需转码。
// ============================================

// gpt-4o-transcribe: higher accuracy than the -mini variant, chosen for
// Malay + code-switched phone audio. Overridable via env to A/B later.
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// 超过这个时长退回"请打字"（长语音转写慢、易含多个诉求，人工更合适）
const MAX_VOICE_SECONDS = 120;
// Telegram getFile 上限 20MB，留余量
const MAX_VOICE_BYTES = 19 * 1024 * 1024;

function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * 转写一段语音。
 *
 * @param {Buffer} buffer - 音频文件内容
 * @param {string} filename - 带扩展名的文件名（决定 MIME 推断，如 voice.oga）
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

  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("file", new File([buffer], filename || "voice.oga"));
  // 不固定 language —— 客户可能说 BM/中文/英文，让模型自检

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = (await resp.text()).slice(0, 200);
      return { ok: false, error: `transcription API ${resp.status}: ${errText}` };
    }
    const data = await resp.json();
    const text = (data.text || "").trim();
    if (!text) {
      return { ok: false, error: "empty transcription" };
    }
    return { ok: true, text };
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
};
