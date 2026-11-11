// Usage discovery, alerts and pre-flight/compaction guards.
// Provides utilities the default-export wires into Pi hooks.

import {
  USAGE_URL,
} from "./config.js";
import {
  resolveApiKey,
} from "./utils.js";
import {
  extensionState,
} from "./state.js";

export async function fetchUsage(apiKey: string): Promise<any | null> {
  try {
    const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const PREFLIGHT_WARN_AT = 0.8;
export const PREFLIGHT_STRICT_AT = 0.95;
export const PREFLIGHT_COOLDOWN_MS = 60_000;
let lastPreflightWarn = 0;
const COMPACT_OVERFLOW_COOLDOWN_MS = 120_000;
let lastCompactOverflowHint = 0;
let lastRequestIdLastSnapshot: string | null = null;

export const CONTEXT_HINTS: Record<string, number> = {
  "kimi-k3": 1_000_000,
  "glm-5.3": 1_000_000,
  "deepseek/deepseek-v4.1-flash": 1_000_000,
  "deepseek/deepseek-v4-pro-latest": 1_000_000,
};

export function guessContextCap(modelIdHint: string | undefined): number {
  const hint = String(modelIdHint ?? "").toLowerCase();
  if (!hint) return 1_048_576;
  const direct = CONTEXT_HINTS[hint];
  if (direct) return direct;
  if (hint.includes("codex") || hint.includes("response")) return 400_000;
  if (hint.includes("kimi")) return 1_000_000;
  if (hint.includes("gemini")) return 1_000_000;
  return 128_000;
}

export function roughPromptTokens(payload: unknown): number {
  try {
    return Math.ceil(JSON.stringify(payload).length / 4);
  } catch {
    return 0;
  }
}

export const USAGE_ALERT_THRESHOLDS = [
  { percent: 75, level: "info" as const, note: "75% used" },
  { percent: 90, level: "warning" as const, note: "90% used — compact in Pi (/compact) or switch cheaper model" },
  { percent: 100, level: "warning" as const, note: "window exhausted — expect 429 window_exhausted until reset" },
];

const usageAlertMemory = new Map<string, number>();

export async function refreshUsage(_pi: { appendEntry: (k: string, v: any) => void; events: { emit: (n: string, v: any) => void } }, ctx: any): Promise<void> {
  const apiKey = await resolveApiKey(ctx);
  if (!apiKey) return;
  const usage = await fetchUsage(apiKey);
  if (!usage) return;
  extensionState.lastUsage = usage;
  const entry = {
    date: new Date().toISOString(),
    wallet: usage.wallet?.balanceUsd ?? 0,
    windows: (usage.windows ?? []).map((w: any) => ({ type: w.type, used: w.used, limit: w.limit, percentUsed: w.percentUsed })),
  };
  _pi.appendEntry("tokens-usage", entry);
  _pi.events.emit("tokens:usage-updated", {
    wallet: usage.wallet?.balanceUsd ?? 0,
    percentUsed: usage.windows?.[0]?.percentUsed ?? 0,
    plan: usage.plan,
    windows: usage.windows,
  });
  checkUsageAlerts(usage, ctx?.ui);
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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

// Project a monthly spend figure for the current plan window. For a weekly
// window we assume the observed spend repeats weekly; for a monthly window the
// observed usage is already the monthly figure.
export function projectedMonthlySpend(usage: any): number {
  let projected = 0;
  for (const w of usage?.windows ?? []) {
    const limit = Number(w?.limit ?? 0);
    const percent = Number(w?.percentUsed ?? 0);
    if (!Number.isFinite(limit) || !Number.isFinite(percent) || limit <= 0) continue;
    const spent = (limit * percent) / 100;
    const monthly = w?.type === "weekly" ? (spent * 30) / 7 : spent;
    projected = Math.max(projected, monthly);
  }
  return projected;
}

export function createBeforeProviderRequestHandler(piApi: any) {
  return async (event: any, ctx: any) => {
    try {
      const payload = event?.payload;
      if (payload === undefined || typeof payload !== "object") return undefined;
      const chars = JSON.stringify(payload).length;
      const approxTokens = roughPromptTokens(payload);
      const hint = String(payload.model ?? ctx?.model?.id ?? "").toLowerCase();
      if (hint) {
        extensionState.modelUsage[hint] = (extensionState.modelUsage[hint] ?? 0) + 1;
      }
      const piCtx = Number(ctx?.model?.contextWindow ?? 0);
      const cap = piCtx > 8192 ? piCtx : guessContextCap(hint);
      const strict = cap * PREFLIGHT_STRICT_AT;
      const warn = cap * PREFLIGHT_WARN_AT;
      if (approxTokens >= strict || approxTokens >= warn) {
        const strictCase = approxTokens >= strict;
        if (Date.now() - lastPreflightWarn >= PREFLIGHT_COOLDOWN_MS) {
          lastPreflightWarn = Date.now();
          const line = strictCase
            ? `tokens.bd preflight: ~${approxTokens.toLocaleString()} tokens vs context ${cap.toLocaleString()} on ${hint || "current model"}. Compact NOW (/compact) or drop large files from context.`
            : `tokens.bd preflight: ~${approxTokens.toLocaleString()} of ${cap.toLocaleString()} context used. /tokens count --model ${hint || "<id>"} for exact count (not billed).`;
          try { piApi.events.emit(strictCase ? "tokens:preflight-warn" : "tokens:preflight-watch", { approxTokens, cap, hint }); } catch {}
          try { ctx?.ui?.notify?.(line, strictCase ? "warning" : "info"); } catch {}
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };
}

// Factory for session_before_compact handler. One hint per overflow per cooldown.
export function createSessionBeforeCompactHandler(piApi: any) {
  return async (event: any, ctx: any) => {
    try {
      if (event?.reason !== "overflow") return undefined;
      if (Date.now() - lastCompactOverflowHint < COMPACT_OVERFLOW_COOLDOWN_MS) return undefined;
      lastCompactOverflowHint = Date.now();
      try { ctx?.ui?.notify?.("tokens.bd overflow: choose /tokens suggest and confirm /compact; exact count needs /tokens count --model <id>.", "warning"); } catch {}
      try { piApi.events.emit("tokens:compact-overflow", { reason: "overflow", willRetry: event?.willRetry ?? false, tokensBefore: event?.preparation?.tokensBefore }); } catch {}
      return undefined;
    } catch {
      return undefined;
    }
  };
}
