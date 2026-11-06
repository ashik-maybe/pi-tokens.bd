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

const ERROR_MAP: Record<string, string> = {
  missing_api_key: "No API key. Run /login tokens.bd.",
  invalid_api_key: "Invalid API key. Recopy or create a new one.",
  key_inactive: "Key revoked or rotated. Use the current secret.",
  key_expired: "Key expired. Create a new one.",
  account_suspended: "Account suspended. Contact support.",
  model_not_allowed_on_key: "Model not in this key's allow-list.",
  monthly_spend_cap_exceeded: "Monthly spend cap reached. Wait for next month or use another key.",
  tier_permission_denied: "Plan doesn't include this model. Upgrade or top up wallet.",
  model_not_found: "Model not found. Check /v1/models.",
  insufficient_credits: "Insufficient credits. Top up or lower max_tokens.",
  no_funding: "No active plan and no wallet balance. Subscribe or top up.",
  outstanding_debt: "Negative balance. Top up to clear it.",
  member_cap_reached: "Team member cap reached. Ask admin.",
  rate_limited: "Rate limited (RPM). Wait Retry-After seconds.",
  concurrency_limit: "Too many in flight. Reduce parallelism. Retry-After: 2s.",
  window_exhausted: "Usage window exhausted. Wait for reset (can be hours).",
  model_limit_reached: "Model allowance used up. Switch models or wait.",
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

async function fetchUsage(apiKey: string): Promise<UsageResponse | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as UsageResponse;
  } catch {
    return null;
  }
}

async function fetchModels(apiKey: string, signal?: AbortSignal): Promise<TokenModel[]> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: TokenModel[] };
    return data.data ?? [];
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  let lastUsage: UsageResponse | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let warnedWindows = false;
  let warnedWallet = false;

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
    const highWindow = (lastUsage.windows ?? []).find((w) => w.percentUsed >= 90);
    if (highWindow && !warnedWindows) {
      warnedWindows = true;
      ctx.ui.notify(
        `${highWindow.label} at ${highWindow.percentUsed}%. Resets ${highWindow.resetsAt}.`,
        "warning",
      );
    }
    if (!highWindow) warnedWindows = false;

    const wallet = lastUsage.wallet?.balanceUsd ?? 0;
    if (wallet < 1 && !warnedWallet) {
      warnedWallet = true;
      ctx.ui.notify(`Low balance ($${wallet.toFixed(2)}). Top up at tokens.bd/dashboard/billing`, "warning");
    }
    if (wallet >= 1) warnedWallet = false;
  };

  const refreshUsage = async (ctx: any) => {
    const apiKey = resolveApiKey();
    if (!apiKey) return;
    lastUsage = await fetchUsage(apiKey);
    updateStatus(ctx);
    checkWarnings(ctx);
  };

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
      const mapped = models.map((m) => ({
        id: m.id,
        name: m.id,
        reasoning: false,
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      }));
      if (context?.publish) {
        context.publish({ update: mapped });
      }
    },
  });

  pi.on("session_start", async (_e, ctx) => {
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

  pi.registerCommand("tokens-status", {
    description: "Show tokens.bd plan, usage, wallet, and key limits",
    handler: async (_args, ctx) => {
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
    handler: async (_args, ctx) => {
      const lines = Object.entries(ERROR_MAP).map(([code, msg]) => `${code}: ${msg}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-models", {
    description: "List models available to your key",
    handler: async (_args, ctx) => {
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
      ctx.ui.notify(models.join("\n"), "info");
    },
  });
}
