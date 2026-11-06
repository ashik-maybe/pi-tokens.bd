import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://tokens.bd/v1";
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
  missing_api_key: "No API key. Run /login tokens.",
  invalid_api_key: "Invalid API key. Check or recreate it.",
  key_inactive: "Key revoked or rotated. Use the current secret.",
  key_expired: "Key expired. Create a new one.",
  account_suspended: "Account suspended. Contact support.",
  model_not_allowed_on_key: "Model not in this key's allow-list.",
  monthly_spend_cap_exceeded: "Monthly spend cap reached. Wait or use another key.",
  tier_permission_denied: "Plan does not include this model. Upgrade or top up wallet.",
  model_not_found: "Model not found. Check GET /v1/models.",
  insufficient_credits: "Insufficient credits. Top up or lower max_tokens.",
  no_funding: "No active plan and no wallet balance. Subscribe or top up.",
  outstanding_debt: "Negative balance. Top up to clear it.",
  member_cap_reached: "Team member cap reached. Ask admin.",
  rate_limited: "Rate limited. Wait Retry-After seconds.",
  concurrency_limit: "Too many requests in flight. Reduce parallelism.",
  window_exhausted: "Usage window exhausted. Wait for reset.",
  model_limit_reached: "Model allowance used up. Switch models or wait.",
  rate_limit_exceeded: "Upstream rate limited. Retry with backoff.",
  upstream_unreachable: "Upstream unreachable. Retry later.",
  upstream_timeout: "Upstream timed out. Retry or reduce request size.",
  no_upstream_available: "No upstream for this model. Try another.",
  model_not_priced: "Model not priced. Try another model.",
  request_entity_too_large: "Request too large (>10MB). Trim context.",
};

export default function (pi: ExtensionAPI) {
  let lastUsage: UsageResponse | null = null;

  const fetchUsage = async (apiKey: string): Promise<UsageResponse | null> => {
    try {
      const res = await fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as UsageResponse;
    } catch {
      return null;
    }
  };

  const fetchModels = async (apiKey: string): Promise<string[]> => {
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: TokenModel[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  };

  const updateStatus = (ctx: any) => {
    if (!lastUsage) {
      ctx.ui.setStatus("tokens", "tokens.bd: no data");
      return;
    }
    const wallet = lastUsage.wallet?.balanceUsd ?? 0;
    const pct = lastUsage.windows.length
      ? lastUsage.windows[0].percentUsed
      : 0;
    ctx.ui.setStatus("tokens", `tokens.bd: $${wallet.toFixed(2)} | ${pct}% used`);
  };

  const refreshUsage = async (ctx: any, apiKey: string) => {
    lastUsage = await fetchUsage(apiKey);
    updateStatus(ctx);
  };

  // Register provider
  pi.registerProvider("tokens", {
    name: "Tokens.bd",
    baseUrl: BASE_URL,
    apiKey: "$TOKENS_API_KEY",
    api: "openai-completions",
    models: [],
    // Dynamic catalog populated via refreshModels below
  } as any);

  // Auth: env var or auth.json key
  // Pi resolves $TOKENS_API_KEY from environment automatically.

  pi.on("session_start", async (_e, ctx) => {
    const apiKey = process.env.TOKENS_API_KEY;
    if (apiKey) {
      const models = await fetchModels(apiKey);
      // Update provider models dynamically
      try {
        (pi as any).registerProvider?.("tokens", {
          name: "Tokens.bd",
          baseUrl: BASE_URL,
          apiKey: "$TOKENS_API_KEY",
          api: "openai-completions",
          models: models.map((id) => ({ id, name: id, input: ["text", "image"] })),
        });
      } catch {}
      await refreshUsage(ctx, apiKey);
    }
    // Refresh usage every 60s
    setInterval(async () => {
      const key = process.env.TOKENS_API_KEY;
      if (key) await refreshUsage(ctx, key);
    }, 60000);
  });

  pi.registerCommand("tokens-status", {
    description: "Show tokens.bd plan, usage, wallet, and key limits",
    handler: async (_args, ctx) => {
      const apiKey = process.env.TOKENS_API_KEY;
      if (!apiKey) {
        ctx.ui.notify("Set TOKENS_API_KEY first.", "warning");
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
      for (const w of usage.windows) {
        lines.push(`${w.label}: ${w.used}/${w.limit} ${w.unit} (${w.percentUsed}%) resets ${w.resetsAt}`);
      }
      if (usage.wallet) lines.push(`Wallet: $${usage.wallet.balanceUsd.toFixed(2)}`);
      if (usage.key.monthlySpendCapUsd) lines.push(`Key cap: $${usage.key.monthlySpendCapUsd}/mo`);
      if (usage.key.allowedModels) lines.push(`Allowed: ${usage.key.allowedModels.join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // Error mapping via tool_result? Pi handles HTTP errors internally.
  // We can't intercept HTTP errors easily, so provide a helper command.
  pi.registerCommand("tokens-errors", {
    description: "List tokens.bd error codes and fixes",
    handler: async (_args, ctx) => {
      const lines = Object.entries(ERROR_MAP).map(([code, msg]) => `${code}: ${msg}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
