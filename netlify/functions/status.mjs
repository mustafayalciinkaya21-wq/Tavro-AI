import { readRemaining, validBrowserId } from "./lib/quota.mjs";

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
  if (request.method !== "GET") {
    return json(405, { error: "Bu uç nokta yalnızca GET isteklerini kabul eder." });
  }
  const browserId = new URL(request.url).searchParams.get("browserId");
  if (!validBrowserId(browserId)) {
    return json(400, { error: "Oturum kimliği geçersiz." });
  }
  try {
    const state = await readRemaining(browserId);
    return json(200, { remaining: state.remaining, limit: 100, resetTimeZone: "Europe/Istanbul" });
  } catch (e) {
    console.error("Quota status failed:", e);
    return json(503, { error: "Günlük kullanım bilgisi şu anda okunamıyor." });
  }
};

export const config = { path: "/api/status" };
