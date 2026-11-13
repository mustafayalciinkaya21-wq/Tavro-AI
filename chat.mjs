import { readRemaining, validBrowserId, consumeSuccessfulAnswer } from "./lib/quota.mjs";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";
const MAX_BODY = 48 * 1024;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 8000;
const SYSTEM_PROMPT = `You are Tavro AI, a helpful, accurate, multilingual assistant.
Reply in the same language as the user's latest message unless asked otherwise.
Use the conversation history to maintain context. Give clear, useful, sufficiently detailed answers.
You can explain concepts, solve math, write and review code, and brainstorm ideas.
Do not claim to have browsed the web, checked live news, or accessed sources unless a tool actually provided that information.
If uncertain, say so.`;

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    body: JSON.stringify(data)
  };
}

export default async (request) => {
  if (request.method !== "POST") {
    return json(405, { error: "Bu uç nokta yalnızca POST isteklerini kabul eder." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return json(503, { error: "Sunucu yapılandırılmamış: GROQ_API_KEY ortam değişkeni eksik." });
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BODY) {
    return json(413, { error: "İstek çok büyük. Mesajlarını kısaltıp tekrar dene." });
  }

  let body;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) {
      return json(413, { error: "İstek çok büyük. Mesajlarını kısaltıp tekrar dene." });
    }
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "İstek verisi geçerli JSON değil." });
  }

  const { browserId, messages } = body || {};
  if (!validBrowserId(browserId)) {
    return json(400, { error: "Oturum kimliği geçersiz. Sayfayı yenileyip tekrar dene." });
  }
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) {
    return json(400, { error: `Sohbet geçmişi 1-${MAX_MESSAGES} mesaj arasında olmalı.` });
  }

  let totalChars = 0;
  const cleanMessages = [];
  for (const item of messages) {
    if (!item || !["user", "assistant"].includes(item.role) ||
        typeof item.content !== "string" ||
        !item.content.trim() || item.content.length > MAX_MESSAGE_CHARS) {
      return json(400, { error: "Mesaj biçimi geçersiz veya mesaj çok uzun." });
    }
    totalChars += item.content.length;
    if (totalChars > 30000) {
      return json(413, { error: "Sohbet geçmişi çok uzun. Yeni bir sohbet başlatmayı dene." });
    }
    cleanMessages.push({ role: item.role, content: item.content.trim() });
  }
  if (cleanMessages[cleanMessages.length - 1].role !== "user") {
    return json(400, { error: "Son mesaj kullanıcı mesajı olmalı." });
  }

  let quota;
  try {
    quota = await readRemaining(browserId);
  } catch (e) {
    console.error("Quota read failed:", e);
    return json(503, { error: "Günlük kullanım bilgisi şu anda okunamıyor. Biraz sonra tekrar dene." });
  }
  if (quota.remaining <= 0) {
    return json(429, {
      error: "Bugünkü 100 yanıt hakkın doldu. Hakkın Türkiye saatiyle 00.00'da yenilenir.",
      remaining: 0
    });
  }

  let groqResponse;
  try {
    groqResponse = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...cleanMessages],
        temperature: 0.7,
        max_tokens: 4096,
        stream: false
      }),
      signal: AbortSignal.timeout(55000)
    });
  } catch (e) {
    console.error("Groq request failed:", e);
    return json(502, { error: "Groq servisine ulaşılamadı. İnternet bağlantısını veya Groq durumunu kontrol edip tekrar dene." });
  }

  let result;
  try { result = await groqResponse.json(); }
  catch {
    return json(502, { error: "Groq geçerli bir yanıt döndürmedi." });
  }

  if (!groqResponse.ok) {
    const groqMessage = result?.error?.message;
    console.error("Groq API error:", groqResponse.status, groqMessage || "Unknown error");
    const safeMessage = groqResponse.status === 401
      ? "Groq API anahtarı geçersiz. Netlify üzerindeki GROQ_API_KEY değerini kontrol et."
      : groqResponse.status === 429
        ? "Groq istek sınırına ulaşıldı. Biraz bekleyip tekrar dene."
        : "Groq isteği başarısız oldu. Biraz sonra tekrar dene.";
    return json(groqResponse.status === 429 ? 503 : 502, { error: safeMessage });
  }

  const answer = result?.choices?.[0]?.message?.content;
  if (typeof answer !== "string" || !answer.trim()) {
    return json(502, { error: "Groq boş yanıt döndürdü. Yanıt hakkın düşürülmedi." });
  }

  // Only successful, non-empty model responses consume a daily answer.
  try {
    const consumed = await consumeSuccessfulAnswer(browserId);
    if (!consumed.allowed) {
      return json(429, {
        error: "Bugünkü 100 yanıt hakkın doldu. Hakkın Türkiye saatiyle 00.00'da yenilenir.",
        remaining: 0
      });
    }
    return json(200, { answer: answer.trim(), remaining: consumed.remaining });
  } catch (e) {
    console.error("Quota write failed:", e);
    // Do not deliver an unmetered answer if the quota cannot be persisted.
    return json(503, { error: "Yanıt üretildi ancak kullanım hakkı kaydedilemedi. Güvenliğiniz için yanıt teslim edilmedi; tekrar deneyebilirsin." });
  }
};

export const config = { path: "/api/chat" };
