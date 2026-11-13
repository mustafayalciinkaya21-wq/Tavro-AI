import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const store = getStore("tavro-daily-quota");
const LIMIT = 100;

export function istanbulDay(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

export function validBrowserId(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function storageKey(browserId, day) {
  // Hash the browser identifier so it is not stored as a readable key.
  const hash = createHash("sha256").update(browserId).digest("hex");
  return `${day}:${hash}`;
}

export async function readRemaining(browserId) {
  const day = istanbulDay();
  const key = storageKey(browserId, day);
  const record = await store.get(key, { type: "json" });
  const used = record && record.day === day && Number.isInteger(record.used)
    ? Math.max(0, Math.min(LIMIT, record.used)) : 0;
  return { remaining: LIMIT - used, day, key, used };
}

export async function consumeSuccessfulAnswer(browserId) {
  const state = await readRemaining(browserId);
  if (state.remaining <= 0) return { allowed: false, remaining: 0 };

  // Netlify Blobs is persistent, but its basic get/set API is not a
  // transactional compare-and-swap. This prevents ordinary sequential
  // overuse; simultaneous requests across separate function instances can race.
  await store.setJSON(state.key, {
    day: state.day,
    used: state.used + 1,
    updatedAt: new Date().toISOString()
  });
  return { allowed: true, remaining: state.remaining - 1 };
}
