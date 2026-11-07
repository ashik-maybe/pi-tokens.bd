import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://tokens.bd/v1";
const MODELS_URL = "https://tokens.bd/v1/models";
const USAGE_URL = "https://tokens.bd/v1/tokens/usage";

interface TokenModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface UsageWindow {
  type: string;
  label: string;
  unit: string;
  limit: number;
  used: number;
  remaining: number;
  percentUsed: number;
  resetsAt: string;
}

interface UsageResponse {
  plan: { name: string; tier: string; periodEnd: string | null } | null;
  windows: UsageWindow[];
  wallet: { balanceUsd: number } | null;
  key: { monthlySpendCapUsd: number | null; allowedModels: string[] | null };
}

interface CostEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow: number;
}

const ERROR_MAP: Record<string, string> = {
  missing_api_key: "No API key. Run /login tokens.bd.",
  invalid_api_key: "Invalid API key. Recopy or create a new one.",
  key_inactive: "Key revoked or rotated. Use the current secret.",
  key_expired: "Key expired. Create a new one.",
  account_suspended: "Account suspended. Contact support.",
  model_not_allowed_on_key: "Model not in this key's allow-list.",
  monthly_spend_cap_exceeded: "Monthly spend cap reached. Wait for next month or use another key. Try /tokens-suggest for a cheaper model.",
  tier_permission_denied: "Plan doesn't include this model. Upgrade or top up wallet. Try /tokens-suggest for a cheaper model.",
  model_not_found: "Model not found. Check /v1/models.",
  insufficient_credits: "Insufficient credits. Top up or lower max_tokens. Try /tokens-suggest for a cheaper model.",
  no_funding: "No active plan and no wallet balance. Subscribe or top up. Try /tokens-suggest for a cheaper model.",
  outstanding_debt: "Negative balance. Top up to clear it.",
  member_cap_reached: "Team member cap reached. Ask admin.",
  rate_limited: "Rate limited (RPM). Wait Retry-After seconds.",
  concurrency_limit: "Too many in flight. Reduce parallelism. Retry-After: 2s.",
  window_exhausted: "Usage window exhausted. Wait for reset (can be hours). Try /tokens-suggest for a cheaper model.",
  model_limit_reached: "Model allowance used up. Switch models or wait. Try /tokens-suggest for a cheaper model.",
  rate_limit_exceeded: "Upstream rate limited. Retry with backoff.",
  upstream_unreachable: "Upstream unreachable. Retry with backoff.",
  upstream_timeout: "Upstream timed out (600s). Retry or reduce request size.",
  no_upstream_available: "No upstream for this model. Try another.",
  model_not_priced: "Model not priced. Try another model.",
  request_entity_too_large: "Request too large (>10MB). Trim context.",
  invalid_request: "Invalid request. Check model field and Content-Type.",
  model_not_available: "Model can't be served right now. Pick another.",
  endpoint_not_supported_for_model: "Endpoint not supported. Use /v1/chat/completions.",
  upstream_auth_error: "Upstream auth failed (not your key). Retry later.",
  anthropic_protocol_disabled: "Messages API disabled. Use Chat Completions.",
};

async function loginTokens(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const key = await callbacks.onPrompt({ message: "Enter your tokens.bd API key (tok_live_...)" });
  if (!key || !key.startsWith("tok_live_")) {
    throw new Error("Invalid key format. Keys start with tok_live_");
  }
  return { refresh: "", access: key, expires: Infinity };
}

async function refreshTokens(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
  signal.throwIfAborted();
  return credentials;
}

function getApiKey(cred: OAuthCredentials): string {
  return cred.access;
}

function resolveApiKey(): string | undefined {
  if (process.env.TOKENS_API_KEY) return process.env.TOKENS_API_KEY;
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const home = process.env.HOME ?? "";
    const authPath = path.join(home, ".pi", "agent", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    return auth?.["tokens.bd"]?.access ?? auth?.["tokens.bd"]?.key;
  } catch {
    return undefined;
  }
}

function loadCosts(): Record<string, CostEntry> {
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const home = process.env.HOME ?? "";
    const costsPath = path.join(home, ".pi", "agent", "tokens-costs.json");
    if (!fs.existsSync(costsPath)) return {};
    const data = JSON.parse(fs.readFileSync(costsPath, "utf8"));
    return data?.models ?? {};
  } catch {
    return {};
  }
}

async function fetchUsage(apiKey: string): Promise<any> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<any[]> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: any[] };
    return data.data ?? [];
  } catch {
    return [];
  }
}

function appendUsageHistory(pi: any, usage: any) {
  const entry = {
    date: new Date().toISOString(),
    wallet: usage.wallet?.balanceUsd ?? 0,
    windows: (usage.windows ?? []).map((w: any) => ({ type: w.type, used: w.used, limit: w.limit, percentUsed: w.percentUsed })),
  };
  pi.appendEntry("tokens-usage", entry);
}

export default function (pi: ExtensionAPI) {
  let lastUsage: any = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let warnedWindows = false;
  let warnedWallet = false;
  let warnedBudget = false;

  const updateStatus = (ctx: any) => {
    if (!lastUsage) {
      ctx.ui.setStatus("tokens.bd", "tokens.bd: no data");
      return;
    }
    const wallet = lastUsage.wallet?.balanceUsd ?? 0;
    const pct = lastUsage.windows?.length ? lastUsage.windows[0].percentUsed : 0;
    ctx.ui.setStatus("tokens.bd", `tokens.bd: $${wallet.toFixed(2)} | ${pct}% used`);
  };

  const checkWarnings = (ctx: any) => {
    if (!lastUsage) return;
    const highWindow = (lastUsage.windows ?? []).find((w: any) => w.percentUsed >= 90);
    if (highWindow && !warnedWindows) {
      warnedWindows = true;
      ctx.ui.notify(`${highWindow.label} at ${highWindow.percentUsed}%. Resets ${highWindow.resetsAt}.`, "warning");
    }
    if (!highWindow) warnedWindows = false;
    const wallet = lastUsage.wallet?.balanceUsd ?? 0;
    if (wallet < 1 && !warnedWallet) {
      warnedWallet = true;
      ctx.ui.notify(`Low balance ($${wallet.toFixed(2)}). Top up at tokens.bd/dashboard/billing`, "warning");
    }
    if (wallet >= 1) warnedWallet = false;

    const budget = Number(process.env.TOKENS_DAILY_BUDGET) || 0;
    if (budget > 0 && !warnedBudget) {
      const today = new Date().toISOString().slice(0, 10);
      const spend = (lastUsage.windows ?? []).reduce((s: number, w: any) => s + (w.used ?? 0), 0);
      if (spend >= budget) {
        warnedBudget = true;
        ctx.ui.notify(`Daily spend $${spend.toFixed(2)} reached budget $${budget}.`, "warning");
      }
    }
    if (warnedBudget) {
      const spend = (lastUsage.windows ?? []).reduce((s: number, w: any) => s + (w.used ?? 0), 0);
      if (spend < budget * 0.9) warnedBudget = false;
    }
  };

  const refreshUsage = async (ctx: any) => {
    const apiKey = resolveApiKey();
    if (!apiKey) return;
    lastUsage = await fetchUsage(apiKey);
    if (lastUsage) {
      appendUsageHistory(pi, lastUsage);
      pi.events.emit("tokens:usage-updated", {
        wallet: lastUsage.wallet?.balanceUsd ?? 0,
        percentUsed: lastUsage.windows?.[0]?.percentUsed ?? 0,
        plan: lastUsage.plan,
        windows: lastUsage.windows,
      });
    }
    updateStatus(ctx);
    checkWarnings(ctx);
  };

  // Register provider with native auth + dynamic catalog
  pi.registerProvider("tokens.bd", {
    name: "Tokens.bd",
    baseUrl: BASE_URL,
    api: "openai-completions",
    models: [],
    oauth: {
      name: "Tokens.bd API Key",
      login: loginTokens,
      refreshToken: refreshTokens,
      getApiKey: getApiKey,
    },
    async refreshModels(context: any) {
      const apiKey = resolveApiKey();
      if (!apiKey) return;
      const models = await fetchModels(apiKey, context?.signal);
      const costs = loadCosts();
      const mapped = models.map((m: any) => {
        const c = costs[m.id];
        return {
          id: m.id,
          name: m.id,
          reasoning: false,
          input: ["text", "image"] as ("text" | "image")[],
          cost: c
            ? { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: c?.contextWindow ?? 128000,
          maxTokens: 8192,
          promptCache: { short: 300 },
        };
      });
      if (context?.publish) {
        context.publish({ update: mapped });
      }
    },
  });

  // Virtual model router (generic, env-configured)
  pi.registerVirtualModel({
    provider: "tokens.bd",
    id: "auto",
    name: "Auto (cost router)",
    thinkingLevels: ["low", "high"],
    contextWindow: 200000,
    maxTokens: 64000,
    route(request: any, ctx: any) {
      const sticky = request.failed ?? request.previous;
      if (request.reason !== "user" && sticky) {
        return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
      }
      const costs = loadCosts();
      const entries = Object.entries(costs);
      let targetId: string | undefined;
      if (request.thinkingLevel === "high") {
        targetId = process.env.PI_ROUTER_HIGH || entries.sort((a: any, b: any) => b[1].output - a[1].output)[0]?.[0];
      } else {
        targetId = process.env.PI_ROUTER_LOW || entries.sort((a: any, b: any) => a[1].input - b[1].input)[0]?.[0];
      }
      if (targetId) {
        const model = ctx.modelRegistry.find("tokens.bd", targetId);
        if (model) return { model, thinkingLevel: "medium" };
      }
      if (ctx.model) return { model: ctx.model, thinkingLevel: "medium" };
      throw new Error("No router target. Set PI_ROUTER_LOW/HIGH or add costs.json.");
    },
  });

  pi.on("session_start", async (_e: any, ctx: any) => {
    await refreshUsage(ctx);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(async () => {
      await refreshUsage(ctx);
    }, 60000);
  });

  pi.on("session_shutdown", async () => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  });

  // Commands
  pi.registerCommand("tokens-status", {
    description: "Show tokens.bd plan, usage, wallet, and key limits",
    handler: async (_args: any, ctx: any) => {
      const apiKey = resolveApiKey();
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const usage = await fetchUsage(apiKey);
      if (!usage) {
        ctx.ui.notify("Failed to fetch usage.", "error");
        return;
      }
      lastUsage = usage;
      const lines: string[] = [];
      if (usage.plan) {
        lines.push(`Plan: ${usage.plan.name} (${usage.plan.tier})`);
        if (usage.plan.periodEnd) lines.push(`Period ends: ${usage.plan.periodEnd}`);
      } else {
        lines.push("Plan: pay-as-you-go");
      }
      for (const w of usage.windows ?? []) {
        lines.push(`${w.label}: ${w.used}/${w.limit} ${w.unit} (${w.percentUsed}%) resets ${w.resetsAt}`);
      }
      if (usage.wallet) lines.push(`Wallet: $${usage.wallet.balanceUsd.toFixed(2)}`);
      if (usage.key?.monthlySpendCapUsd) lines.push(`Key cap: $${usage.key.monthlySpendCapUsd}/mo`);
      if (usage.key?.allowedModels) lines.push(`Allowed: ${usage.key.allowedModels.join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
      updateStatus(ctx);
    },
  });

  pi.registerCommand("tokens-errors", {
    description: "List tokens.bd error codes and fixes",
    handler: async (_args: any, ctx: any) => {
      const lines = Object.entries(ERROR_MAP).map(([code, msg]) => `${code}: ${msg}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-models", {
    description: "List models available to your key",
    handler: async (_args: any, ctx: any) => {
      const apiKey = resolveApiKey();
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const models = await fetchModels(apiKey);
      if (models.length === 0) {
        ctx.ui.notify("No models available. Check plan/wallet.", "warning");
        return;
      }
      const costs = loadCosts();
      const lines = models.map((m: any) => {
        const c = costs[m.id];
        if (c) return `${m.id} (ctx=${(c.contextWindow / 1000).toFixed(0)}K, in=$${c.input}/M, out=$${c.output}/M)`;
        return `${m.id} (no cost data)`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-costs", {
    description: "Show loaded per-model costs from tokens-costs.json",
    handler: async (_args: any, ctx: any) => {
      const costs = loadCosts();
      const entries = Object.entries(costs);
      if (entries.length === 0) {
        ctx.ui.notify("No costs loaded. Copy costs.json to ~/.pi/agent/tokens-costs.json", "warning");
        return;
      }
      const lines = entries.map(([id, c]) =>
        `${id}: in=$${c.input}/M out=$${c.output}/M ctx=${c.contextWindow}`
      );
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-history", {
    description: "Show 7-day usage history",
    handler: async (_args: any, ctx: any) => {
      const branch = ctx.sessionManager.getBranch();
      const entries = branch.filter((e: any) => e.type === "custom" && e.customType === "tokens-usage");
      if (entries.length === 0) {
        ctx.ui.notify("No usage history in this session yet.", "info");
        return;
      }
      const lines = entries.slice(-7).map((e: any) => {
        const d = new Date(e.data.date).toLocaleDateString();
        const w = e.data.windows?.[0];
        return `${d}: $${e.data.wallet?.toFixed(2) ?? "?"} | ${w ? `${w.percentUsed}%` : "n/a"}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-compare", {
    description: "Compare available models by cost",
    handler: async (_args: any, ctx: any) => {
      const apiKey = resolveApiKey();
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const models = await fetchModels(apiKey);
      const costs = loadCosts();
      const lines = models
        .map((m: any) => {
          const c = costs[m.id];
          return c ? `${m.id}: in=$${c.input}/M out=$${c.output}/M ctx=${c.contextWindow}` : `${m.id}: (no cost data)`;
        })
        .sort();
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-suggest", {
    description: "Suggest cheapest model for routine work",
    handler: async (_args: any, ctx: any) => {
      const costs = loadCosts();
      const entries = Object.entries(costs);
      if (entries.length === 0) {
        ctx.ui.notify("No costs loaded. Copy costs.json to ~/.pi/agent/tokens-costs.json", "warning");
        return;
      }
      const cheapest = entries.sort((a: any, b: any) => a[1].input - b[1].input)[0];
      ctx.ui.notify(`Cheapest: ${cheapest[0]} ($${cheapest[1].input}/M in, $${cheapest[1].output}/M out)`, "info");
    },
  });
}
