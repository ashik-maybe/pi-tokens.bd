// Virtual router for Tokens.bd. One file. Optional.
// Picks a physical model per request from the user's weekly or monthly allowlist.
// Sticky on continuation/retry — task moves to one model, never silently off-model.
// No LLM classifier: rules + user hints only, free to run.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./config.js";
import { extensionState } from "./state.js";

export type RouterPlan = "weekly" | "monthly";
export type RouterMode = "auto" | "economy" | "hard";

export interface RouterState {
  plan: RouterPlan;
  mode: RouterMode;
  chosen: string;
  taskAttempts: number;
}

const DEFAULT_PLAN: RouterPlan = "weekly";
const DEFAULT_MODE: RouterMode = "auto";

// Exact IDs in the provider catalog. Edit here to add/remove models.
const WEEKLY = {
  economy: "z-ai/glm-5.3-flash",   // $20 allowance, biggest for cheap work
  balanced: "deepseek-ai/deepseek-v4.1-flash-1017", // $15, main coding worker
  cheapAlt: "deepseek/deepseek-v4.1-flash",          // $15, input-heavy alt
} as const;

const MONTHLY = {
  balance: "deepseek-ai/deepseek-v4.1-flash-1017", // $60, main worker
  cheap: "xiaomi/mimo-v2.6-flash",                 // $60, small work
  cheapAlt: "deepseek/deepseek-v4.1-flash",        // $60
  reviewer: "claude-haiku-5-5",                    // $60, bounded review
  hard: "z-ai/glm-5.3",                            // $60, reserved for [hard]
} as const;

const HINTS: Record<string, RouterMode> = {
  "[cheap]": "economy",
  "[economy]": "economy",
  "[balanced]": "auto",
  "[hard]": "hard",
};

export function setRouterPlan(plan: RouterPlan): void {
  extensionState.routerPlan = plan;
}
export function setRouterMode(mode: RouterMode): void {
  extensionState.routerMode = mode;
}

export function getRouterPlan(): RouterPlan {
  const env = String(process.env.TOKENS_ROUTER_PLAN ?? "").trim().toLowerCase();
  if (env === "weekly" || env === "monthly") return env as RouterPlan;
  return extensionState.routerPlan ?? DEFAULT_PLAN;
}
export function getRouterMode(): RouterMode {
  const env = String(process.env.TOKENS_ROUTER_MODE ?? "").trim().toLowerCase();
  if (env === "auto" || env === "economy" || env === "hard") return env as RouterMode;
  return extensionState.routerMode ?? DEFAULT_MODE;
}

function lastUserText(messages: readonly any[]): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("\n");
    }
  }
  return "";
}

const HINT_RE = /^\[(cheap|economy|balanced|hard|review)(\]|\))/i;

function stripHint(text: string): string {
  return text.replace(HINT_RE, "").trimStart();
}

// User-facing recommendation entry: classify the current prompt and pick the
// allowlisted model for the active plan/mode. Pure text-in, model-out.
export function recommendModel(text: string): string {
  const plan = getRouterPlan();
  const mode = getRouterMode();
  return routeModel(plan, mode, text);
}

export function routeModel(plan: RouterPlan, mode: RouterMode, text: string): string {
  const t = stripHint(text || "").toLowerCase();
  const hint = HINT_RE.exec(text || "");
  if (hint) {
    const word = hint[1].toLowerCase();
    // [review] pins the monthly reviewer; weekly has no reviewer tier.
    if (word === "review") return plan === "monthly" ? MONTHLY.reviewer : WEEKLY.balanced;
    mode = (HINTS[`[${word}]`] as RouterMode) ?? mode;
  }
  if (mode === "economy") {
    return plan === "weekly" ? WEEKLY.economy : MONTHLY.cheap;
  }
  if (mode === "hard") {
    return plan === "weekly" ? WEEKLY.balanced : MONTHLY.hard;
  }
  if (
    /(auth|migrat|permission|security|race condition|intermittent|memory leak|deadlock)/.test(t)
  ) {
    return plan === "weekly" ? WEEKLY.balanced : MONTHLY.hard;
  }
  if (
    /(rename|typo|format|comment|readme|describe|what is|explain|small|simple|cleanup)/.test(t)
  ) {
    return plan === "weekly" ? WEEKLY.economy : MONTHLY.cheap;
  }
  return plan === "weekly" ? WEEKLY.balanced : MONTHLY.balance;
}

function routeRequest(request: any): { modelId: string; state: RouterState } {
  const plan = getRouterPlan();
  const mode = getRouterMode();
  const text = lastUserText(request?.messages ?? []);
  const modelId = routeModel(plan, mode, text);
  return {
    modelId,
    state: {
      plan,
      mode,
      chosen: modelId,
      taskAttempts: (request?.state?.taskAttempts ?? 0) + 1,
    },
  };
}

// ---- register as one virtual model -----------------------------------

export function registerVirtualRouter(pi: ExtensionAPI): void {
  pi.registerVirtualModel({
    provider: PROVIDER_ID,
    id: "virtual-router",
    name: "Tokens Router (budget-aware)",
    thinkingLevels: ["low", "medium", "high"],
    contextWindow: 1_100_000,
    maxTokens: 8192,
    route(request: any, ctx: any) {
      if (request?.state?.chosen && request?.reason !== "user") {
        const sticky = ctx.modelRegistry?.find?.(PROVIDER_ID, request.state.chosen);
        if (sticky) {
          return { model: sticky, thinkingLevel: "medium", state: request.state };
        }
      }
      const picked = routeRequest(request);
      const model = ctx.modelRegistry?.find?.(PROVIDER_ID, picked.modelId);
      if (!model) {
        throw new Error(
          `Router chose ${picked.modelId} on ${picked.state.plan} but it is not available on this account. ` +
          `Add it to the plan's allowlist in src/router.ts or pick a different model.`,
        );
      }
      return { model, thinkingLevel: "medium", state: picked.state };
    },
  });
}

// ---- ladder routing (existing service) -------------------------------
// Preserved from pre-split code for backward-compat virtual models.
// Do not remove while the old ladder virtual models remain.

import { PROVIDER_ID as PID } from "./config.js";
import { classifyFailure, errorHint } from "./errors.js";
import { deriveLadder, getLastCatalog } from "./catalog.js";

function pickNextPhysical(ctx: any, ids: string[], skip?: string): any | null {
  const start = skip ? ids.indexOf(skip) : -1;
  const ordered = skip && start >= 0 ? ids.slice(start + 1) : skip ? ids : ids;
  for (const id of ordered) {
    if (!id || id === skip) continue;
    const model = ctx.modelRegistry.find(PID, id);
    if (model) return model;
  }
  return null;
}

export function routeForRole(role: string, request: any, ctx: any): any {
  const ids = deriveLadder(getLastCatalog())[role] ?? [];
  if (!ids.length) {
    throw new Error(`No ladder for ${role}. Catalog offline and no tokens-ladder.json override. Check /v1/models.`);
  }
  const sticky = request.failed ?? request.previous;
  if (request.reason === "retry" && sticky?.model) {
    const failedId = sticky.model.id;
    const message = request.failed?.message?.errorMessage ?? sticky.message?.errorMessage ?? "";
    if (classifyFailure(message) === "non_retryable") {
      const suffix = extensionState.lastRetryAfterSeconds !== null ? ` (Retry-After: ${extensionState.lastRetryAfterSeconds}s)` : "";
      throw new Error(errorHint(message) + suffix);
    }
    const next = pickNextPhysical(ctx, ids, failedId);
    if (next) return { model: next, thinkingLevel: request.thinkingLevel ?? sticky.thinkingLevel ?? "medium" };
    const suffix = extensionState.lastRetryAfterSeconds !== null ? ` (Retry-After: ${extensionState.lastRetryAfterSeconds}s)` : "";
    throw new Error(`Ladder ${role} exhausted after ${failedId}. ${errorHint(message)}${suffix}`);
  }
  if (request.reason !== "user" && sticky?.model) {
    return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel ?? "medium" };
  }
  const first = pickNextPhysical(ctx, ids);
  if (first) return { model: first, thinkingLevel: request.thinkingLevel ?? "medium" };
  throw new Error(`Ladder ${role} has no available model. Check /v1/models and account limits.`);
}
