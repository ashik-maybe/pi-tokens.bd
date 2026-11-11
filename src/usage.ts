// Usage discovery, alerts and model-usage tracking.
//
// Contract with tokens.bd (docs/models-and-usage.md):
//   GET /v1/tokens/usage -> { plan, wallet: { balanceUsd }, windows[] }
//   Each window: { type, unit, label, used, limit, remaining, percentUsed, resetsAt }
//   USD-unit windows are needed for spend projection; `requests`-unit windows
//   carry no price. `session_5h` has no monthly-equivalent projection.
//
// The poller (wired from index.ts) runs every 60 s. It persists a
// `tokens-usage` session entry ONLY when the window/wallet signature moves,
// otherwise it would append one entry per poll and grow the session file.

import {
  USAGE_URL,
} from "./config.js";
import {
  resolveApiKey,
  timeoutSignal,
} from "./utils.js";
import {
  extensionState,
} from "./state.js";

export async function fetchUsage(apiKey: string): Promise<any | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: timeoutSignal(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const USAGE_ALERT_THRESHOLDS = [
  { percent: 75, level: "info" as const, note: "75% used" },
  { percent: 90, level: "warning" as const, note: "90% used — compact in Pi (/compact) or switch cheaper model" },
  { percent: 100, level: "warning" as const, note: "window exhausted — expect 429 window_exhausted until reset" },
];

const usageAlertMemory = new Map<string, number>();

// Signature covers every field the UI renders. Any movement re-persists;
// identical windows collapse into one entry.
let lastUsageSignature: string | null = null;

function usageSignature(usage: any): string {
  const wallet = usage?.wallet?.balanceUsd ?? null;
  const windows = (usage?.windows ?? [])
    .map((w: any) => [w?.type, w?.unit, w?.limit, w?.used, w?.percentUsed, w?.resetsAt].join(":"))
    .join("|");
  return `${wallet}|${windows}`;
}

export async function refreshUsage(_pi: { appendEntry: (k: string, v: any) => void; events: { emit: (n: string, v: any) => void } }, ctx: any): Promise<void> {
  const apiKey = await resolveApiKey(ctx);
  if (!apiKey) return;
  const usage = await fetchUsage(apiKey);
  if (!usage) return;
  extensionState.lastUsage = usage;
  const signature = usageSignature(usage);
  if (signature !== lastUsageSignature) {
    lastUsageSignature = signature;
    const entry = {
      date: new Date().toISOString(),
      wallet: usage.wallet?.balanceUsd ?? null,
      windows: (usage.windows ?? []).map((w: any) => ({ type: w.type, used: w.used, limit: w.limit, percentUsed: w.percentUsed, unit: w.unit })),
    };
    _pi.appendEntry("tokens-usage", entry);
  }
  _pi.events.emit("tokens:usage-updated", {
    wallet: usage.wallet?.balanceUsd ?? null,
    percentUsed: usage.windows?.[0]?.percentUsed ?? 0,
    plan: usage.plan,
    windows: usage.windows,
  });
  checkUsageAlerts(usage, ctx?.ui);
}

// Local numeric coercion, same semantics as utils.num but not exported
// (keeps this module's public surface small).
function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// One alert per (window, threshold, reset cycle), once per session. `used`
// and `percentUsed` rise per request; the memory map suppresses repeats.
// Memory is keyed by reset time so a new window cycle re-arms the alerts.
export function checkUsageAlerts(usage: any, ui?: { notify?: (msg: string, level: string) => void }): void {
  if (!usage) return;
  for (const w of usage.windows ?? []) {
    const label = String(w?.label ?? w?.type ?? "window");
    const unit = String(w?.unit ?? "");
    const resetsAt = String(w?.resetsAt ?? "");
    const used = num(w?.used, 0);
    const limit = num(w?.limit, 0);
    const percent = num(w?.percentUsed, 0);
    for (const threshold of USAGE_ALERT_THRESHOLDS) {
      if (percent < threshold.percent) continue;
      const key = `${w?.type ?? label}:${resetsAt}:${threshold.percent}`;
      const previous = usageAlertMemory.get(key) ?? -1;
      if (previous >= threshold.percent) continue;
      usageAlertMemory.set(key, percent);
      const msg = `tokens.bd: ${label} ${threshold.note} (${percent}% of ${limit}${unit ? ` ${unit}` : ""}, used ${used}, resets ${resetsAt || "unknown"})`;
      try { ui?.notify?.(msg, threshold.level); } catch {}
      break;
    }
  }
}

export function humanTimeLeft(iso: string | undefined): string {
  if (!iso) return "?";
  const target = new Date(iso);
  const diff = target.getTime() - Date.now();
  if (!Number.isFinite(diff)) return iso;
  if (diff <= 0) return "now";
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatWindow(w: any): string {
  const label = String(w?.label ?? w?.type ?? "window");
  const percent = num(w?.percentUsed, 0);
  const used = num(w?.used, 0);
  const limit = num(w?.limit, 0);
  const remaining = w?.remaining !== undefined && w?.remaining !== null ? num(w.remaining, Math.max(0, limit - used)) : Math.max(0, limit - used);
  const unit = String(w?.unit ?? "");
  const timeLeft = humanTimeLeft(w?.resetsAt ?? "");
  return `${label}: ${remaining} remaining of ${limit}${unit ? ` ${unit}` : ""} (${percent}%, used ${used}, resets in ${timeLeft})`;
}

// Project a monthly spend figure for the current plan window, in USD.
// Only usd-unit windows count; `requests` windows carry no price. Only
// weekly/monthly plan windows project; a session_5h window has no monthly
// equivalent. Returns null when nothing qualifies.
export function projectedMonthlySpend(usage: any): number | null {
  let projected: number | null = null;
  for (const w of usage?.windows ?? []) {
    if (w?.unit && w.unit !== "usd") continue;
    const limit = Number(w?.limit ?? 0);
    const percent = Number(w?.percentUsed ?? 0);
    if (!Number.isFinite(limit) || !Number.isFinite(percent) || limit <= 0) continue;
    const spent = (limit * percent) / 100;
    const monthly = w?.type === "weekly" ? (spent * 30) / 7 : w?.type === "monthly" ? spent : null;
    if (monthly === null) continue;
    projected = projected === null ? monthly : Math.max(projected, monthly);
  }
  return projected;
}

// Count model usage per session for `/tokens history --by-model`.
// Pi's footer and auto-compaction own context pressure; this hook only tallies.
export function createModelUsageTracker() {
  return async (event: any, ctx: any) => {
    try {
      const payload = event?.payload;
      if (payload === undefined || typeof payload !== "object") return undefined;
      const hint = String(payload.model ?? ctx?.model?.id ?? "").toLowerCase();
      if (hint) {
        extensionState.modelUsage[hint] = (extensionState.modelUsage[hint] ?? 0) + 1;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
}
