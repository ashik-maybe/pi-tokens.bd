import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  openAICompletionsApi,
  type Credential,
  type OAuthCredential,
  type ProviderAuthInteraction,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://tokens.bd/v1";
const MODELS_URL = "https://tokens.bd/v1/models";
const USAGE_URL = "https://tokens.bd/v1/tokens/usage";
const PROVIDER_ID = "tokens.bd";

interface CostEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow: number;
}

type LadderMap = Record<string, string[]>;

const ALL_ROLES = ["fast", "coder", "reasoner", "long-context", "private", "research"] as const;

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
  upstream_error: "Upstream server error. Retry with backoff.",
  upstream_timeout: "Upstream timed out (600s). Retry or reduce request size.",
  no_upstream_available: "No upstream for this model. Try another.",
  model_not_priced: "Model not priced. Try another model.",
  request_entity_too_large: "Request too large (>10MB). Trim context.",
  invalid_request: "Invalid request. Check model field and Content-Type.",
  model_not_available: "Model can't be served right now. Pick another.",
  endpoint_not_supported_for_model: "Endpoint not supported. Use /v1/chat/completions.",
  upstream_auth_error: "Upstream auth failed (not your key). Retry later.",
  anthropic_protocol_disabled: "Messages API disabled. Use Chat Completions.",
  lookup_failed: "Internal lookup failed. Retry once or twice, then support.",
  admission_error: "Request admission failed. Retry once or twice, then support.",
  catalog_error: "Model catalog error. Retry once or twice, then support.",
  usage_unavailable: "Usage service unavailable. Retry later.",
  unsupported_endpoint: "Path or method not supported. See /v1/models and usage.",
  context_length_exceeded: "Context window exceeded. Compaction should retry; ladder escalates to a larger model when available.",
  context_overflow: "Context window exceeded. /compact, then retry.",
};

// ---- auth helpers ----

function validateApiKey(raw: string): string {
  const key = raw.trim();
  if (!key) throw new Error("API key is required.");
  if (!key.startsWith("tok_live_")) {
    throw new Error("Invalid key format. Keys start with tok_live_. Copy one from tokens.bd/dashboard/keys.");
  }
  return key;
}

async function promptForApiKey(interaction: ProviderAuthInteraction): Promise<string> {
  interaction.signal.throwIfAborted();
  const answer = await interaction.prompt({
    type: "secret",
    message: "Enter your tokens.bd API key (tok_live_...)",
    placeholder: "tok_live_...",
  });
  interaction.signal.throwIfAborted();
  return validateApiKey(answer);
}

function extractApiKey(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") return credential.key;
  if (credential.type === "oauth") return credential.access;
  // Defensive: tolerate a bare stored shape if older Pi writes it.
  const loose = credential as unknown as { key?: string; access?: string };
  return loose.key ?? loose.access;
}

// Pi owns chat auth (runtime --api-key > stored > models.json > env TOKENS_API_KEY).
// Extension pollers use ctx.modelRegistry.getApiKeyForProvider() first; the
// helpers below keep the manual fallback for contexts without a registry.
function agentDir(): string {
  return join(process.env.HOME ?? "", ".pi", "agent");
}

function packageRootDir(): string {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return process.cwd();
  }
}

function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveApiKeySync(): string | undefined {
  if (process.env.TOKENS_API_KEY) return process.env.TOKENS_API_KEY;
  try {
    const auth = readJson(join(agentDir(), "auth.json")) ?? {};
    const stored = auth[PROVIDER_ID] ?? {};
    return stored.access ?? stored.key;
  } catch {
    return undefined;
  }
}

async function resolveApiKey(ctx?: any): Promise<string | undefined> {
  const registry = ctx?.modelRegistry;
  if (registry?.getApiKeyForProvider) {
    try {
      const key = await registry.getApiKeyForProvider(PROVIDER_ID);
      if (key) return key;
    } catch {
      // fall through to manual fallback
    }
  }
  if (registry?.getProviderAuth) {
    try {
      const result = await registry.getProviderAuth(PROVIDER_ID);
      if (result?.auth?.apiKey) return result.auth.apiKey;
    } catch {
      // fall through
    }
  }
  return resolveApiKeySync();
}

function loadCosts(): Record<string, CostEntry> {
  const candidates = [
    join(agentDir(), "tokens-costs.json"),
    join(agentDir(), "costs.json"),
    join(packageRootDir(), "costs.json"),
    join(process.cwd(), "costs.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const data = readJson(candidate);
    if (data?.models && typeof data.models === "object") return data.models;
    if (data && typeof data === "object" && !data._note && !data.roles) {
      // tolerate a bare id -> cost map
      const values = Object.values(data);
      if (values.length && typeof values[0] === "object" && values[0] !== null && "input" in (values[0] as any)) {
        return data as Record<string, CostEntry>;
      }
    }
  }
  return {};
}

function loadLadder(): LadderMap {
  const envOverride: LadderMap = {};
  for (const role of ALL_ROLES) {
    const envKey = `TOKENS_${role.replace("-", "_").toUpperCase()}`;
    const val = process.env[envKey];
    if (val?.trim()) {
      envOverride[role] = val.split(",").map((s: string) => s.trim()).filter(Boolean);
    }
  }
  const candidates = [
    join(agentDir(), "tokens-ladder.json"),
    join(agentDir(), "ladder.json"),
    join(packageRootDir(), "ladder.json"),
    join(process.cwd(), "ladder.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const data = readJson(candidate);
    const roles = (data?.roles ?? data) as LadderMap | undefined;
    if (roles && typeof roles === "object") return { ...roles, ...envOverride };
  }
  return envOverride;
}

// Legacy offline cache written by pre-native builds. Pi's models-store is
// now the primary snapshot; keep reading this once for offline installs,
// then stop depending on it.
function readSnapshot(): any[] {
  try {
    const data = readJson(join(agentDir(), "tokens-models.json"));
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

function writeSnapshot(models: any[]) {
  try {
    writeFileSync(join(agentDir(), "tokens-models.json"), `${JSON.stringify({ data: models }, null, 2)}\n`, { mode: 0o644 });
  } catch {
    // best-effort legacy compat only
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

async function fetchModelsRaw(apiKey: string, signal?: AbortSignal): Promise<any[]> {
  try {
    const res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: any[] };
    return Array.isArray(data.data) ? data.data : [];
  } catch {
    return [];
  }
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInput(value: unknown): ("text" | "image")[] {
  if (Array.isArray(value)) {
    const filtered = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
    if (filtered.length) return filtered;
  }
  if (typeof value === "string" && (value === "text" || value === "image")) return [value];
  return ["text"];
}

function mapModels(models: any[], costs: Record<string, CostEntry>) {
  const mapped: any[] = [];
  for (const raw of models) {
    const id = String(raw?.id ?? "").trim();
    if (!id) continue;
    const cost = costs[id] ?? {};
    const input = num(cost.input, 0);
    const output = num(cost.output, 0);
    // tokens.bd bills unknown cache prices at the input price
    // (api-reference cost formula). costs.json stores 0 for "unknown".
    const cacheRead = cost.cacheRead ? num(cost.cacheRead, input) : input;
    const cacheWrite = cost.cacheWrite ? num(cost.cacheWrite, input) : input;
    const reasoning =
      raw.reasoning ?? raw.supports_reasoning ?? raw.supportsReasoning ?? raw.supports_reasoning_effort ?? false;
    const inputModalities = raw.input ?? raw.modalities ?? raw.image ?? undefined;
    const model: Record<string, any> = {
      type: "chat",
      id,
      name: String(raw.name ?? id),
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: BASE_URL,
      reasoning: Boolean(reasoning),
      input: normalizeInput(inputModalities),
      cost: { input, output, cacheRead, cacheWrite },
      contextWindow: num(raw.contextWindow ?? raw.context_window ?? raw.contextLength ?? cost.contextWindow, 128000),
      maxTokens: num(raw.maxTokens ?? raw.max_tokens ?? raw.max_output_tokens, 8192),
    };
    if (raw.thinkingLevelMap && typeof raw.thinkingLevelMap === "object") model.thinkingLevelMap = raw.thinkingLevelMap;
    if (raw.inputLimits && typeof raw.inputLimits === "object") model.inputLimits = raw.inputLimits;
    if (raw.promptCache && typeof raw.promptCache === "object") model.promptCache = raw.promptCache;
    if (raw.compat && typeof raw.compat === "object") model.compat = raw.compat;
    if (raw.samplingParams && typeof raw.samplingParams === "object") model.samplingParams = raw.samplingParams;
    mapped.push(model);
  }
  return mapped;
}

function storedFallback(context: RefreshModelsContext): any[] {
  if (context.stored?.models?.length) return context.stored.models as any[];
  const legacy = readSnapshot();
  if (legacy.length) return mapModels(legacy, loadCosts());
  return [];
}

async function fetchNativeModels(context: RefreshModelsContext): Promise<any[]> {
  const apiKey = extractApiKey(context.credential) ?? process.env.TOKENS_API_KEY;
  if (!apiKey) return storedFallback(context);
  const live = await fetchModelsRaw(apiKey, context.signal);
  if (!live.length) {
    // An empty live catalog is only trustworthy when the request actually
    // succeeded; fetchModelsRaw collapses both failure and empty to [].
    // Re-check reachability so offline glitches never wipe the Pi snapshot.
    try {
      const probe = await fetch(MODELS_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: context.signal,
      });
      if (!probe.ok) return storedFallback(context);
      const data = (await probe.json()) as { data?: any[] };
      const raw = Array.isArray(data.data) ? data.data : [];
      if (!raw.length && context.stored?.models?.length) return storedFallback(context);
      const mapped = mapModels(raw, loadCosts());
      writeSnapshot(raw);
      return mapped;
    } catch {
      return storedFallback(context);
    }
  }
  const mapped = mapModels(live, loadCosts());
  writeSnapshot(live);
  return mapped;
}

// ---- ladder router retry policy ----

const RETRYABLE_CODES = new Set([
  "rate_limited",
  "concurrency_limit",
  "rate_limit_exceeded",
  "upstream_unreachable",
  "upstream_error",
  "upstream_timeout",
  "no_upstream_available",
  "model_not_priced",
  "model_not_available",
  "upstream_auth_error",
  "lookup_failed",
  "admission_error",
  "catalog_error",
  "usage_unavailable",
  "model_limit_reached",
  "context_length_exceeded",
  "context_overflow",
  "context_length",
]);

const NON_RETRYABLE_CODES = new Set([
  "missing_api_key",
  "invalid_api_key",
  "key_inactive",
  "key_expired",
  "account_suspended",
  "model_not_allowed_on_key",
  "monthly_spend_cap_exceeded",
  "tier_permission_denied",
  "insufficient_credits",
  "no_funding",
  "outstanding_debt",
  "member_cap_reached",
  "window_exhausted",
  "invalid_request",
  "request_entity_too_large",
  "endpoint_not_supported_for_model",
  "anthropic_protocol_disabled",
  "model_not_found",
  "unsupported_endpoint",
]);

function classifyFailure(errorMessage: string): "retryable" | "non_retryable" {
  const text = (errorMessage ?? "").toLowerCase();
  for (const code of RETRYABLE_CODES) {
    if (text.includes(code)) return "retryable";
  }
  for (const code of NON_RETRYABLE_CODES) {
    if (text.includes(code)) return "non_retryable";
  }
  // tokens.bd bodies carry status numbers and/or ChatGPT-style codes.
  const statusMatch = text.match(/\b(\d{3})\b/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return "retryable";
  if (status !== undefined && status >= 400 && status < 500) return "non_retryable";
  // Unknown: never burn budget retrying a likely 4xx/billing error.
  if (text.includes("context")) return "retryable";
  return "non_retryable";
}

function errorHint(errorMessage: string): string {
  const text = (errorMessage ?? "").toLowerCase();
  for (const [code, hint] of Object.entries(ERROR_MAP)) {
    if (text.includes(code)) return hint;
  }
  return errorMessage ? errorMessage.slice(0, 240) : "Request failed.";
}

function pickNextPhysical(ctx: any, ids: string[], skip?: string): any | null {
  const start = skip ? ids.indexOf(skip) : -1;
  // Escalation moves forward only, never wraps back to cheap after failure.
  const ordered = skip && start >= 0 ? ids.slice(start + 1) : skip ? ids : ids;
  for (const id of ordered) {
    if (!id || id === skip) continue;
    const model = ctx.modelRegistry.find(PROVIDER_ID, id);
    if (model) return model;
  }
  return null;
}

function routeForRole(role: string, request: any, ctx: any): any {
  const ids = loadLadder()[role] ?? [];
  if (!ids.length) {
    throw new Error(`No ladder for ${role}. Set ladder.json roles.${role} or TOKENS_${role.toUpperCase().replace("-", "_")}.`);
  }
  const sticky = request.failed ?? request.previous;
  if (request.reason === "retry" && sticky?.model) {
    const failedId = sticky.model.id;
    const message = request.failed?.message?.errorMessage ?? sticky.message?.errorMessage ?? "";
    if (classifyFailure(message) === "non_retryable") {
      // Fail fast: retrying another ladder step cannot fix auth, billing,
      // spend caps, or malformed input, and would only burn usage.
      throw new Error(errorHint(message));
    }
    const next = pickNextPhysical(ctx, ids, failedId);
    if (next) return { model: next, thinkingLevel: request.thinkingLevel ?? sticky.thinkingLevel ?? "medium" };
    throw new Error(`Ladder ${role} exhausted after ${failedId}. ${errorHint(message)}`);
  }
  if (request.reason !== "user" && sticky?.model) {
    return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel ?? "medium" };
  }
  const first = pickNextPhysical(ctx, ids);
  if (first) return { model: first, thinkingLevel: request.thinkingLevel ?? "medium" };
  throw new Error(`Ladder ${role} has no available model. Check /v1/models and ladder ids.`);
}

export default function (pi: ExtensionAPI) {
  let lastUsage: any = null;
  let lastRequestId: string | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  const refreshUsage = async (ctx: any) => {
    const apiKey = await resolveApiKey(ctx);
    if (!apiKey) return;
    lastUsage = await fetchUsage(apiKey);
    if (lastUsage) {
      const entry = {
        date: new Date().toISOString(),
        wallet: lastUsage.wallet?.balanceUsd ?? 0,
        windows: (lastUsage.windows ?? []).map((w: any) => ({ type: w.type, used: w.used, limit: w.limit, percentUsed: w.percentUsed })),
      };
      pi.appendEntry("tokens-usage", entry);
      pi.events.emit("tokens:usage-updated", {
        wallet: lastUsage.wallet?.balanceUsd ?? 0,
        percentUsed: lastUsage.windows?.[0]?.percentUsed ?? 0,
        plan: lastUsage.plan,
        windows: lastUsage.windows,
      });
    }
  };

  // Native provider: Pi owns auth order, offline snapshot, SSE streaming,
  // and usage accounting. The extension owns discovery + costs + ladders.
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Tokens.bd",
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: "Tokens.bd API key",
        login: async (interaction: ProviderAuthInteraction) => ({ type: "api_key", key: await promptForApiKey(interaction) }),
        resolve: async ({ ctx, credential, signal }: { ctx: any; credential: any; signal: AbortSignal }) => {
          signal.throwIfAborted();
          if (credential?.key) return { auth: { apiKey: credential.key }, env: credential.env, source: "stored API key" };
          const fromEnv = await ctx.env("TOKENS_API_KEY");
          signal.throwIfAborted();
          if (fromEnv) return { auth: { apiKey: fromEnv }, source: "TOKENS_API_KEY" };
          return undefined;
        },
      },
      oauth: {
        name: "Tokens.bd API Key",
        login: async (interaction: ProviderAuthInteraction) => {
          const key = await promptForApiKey(interaction);
          const credential: OAuthCredential = {
            type: "oauth",
            refresh: "",
            access: key,
            expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000,
          };
          return credential;
        },
        refresh: async (credential: OAuthCredential, signal: AbortSignal) => {
          signal.throwIfAborted();
          return credential;
        },
        toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
      },
    },
    models: [],
    fetchModels: fetchNativeModels,
    api: openAICompletionsApi(),
  });
  pi.registerProvider(provider);

  // Ladder virtual models: Pi owns selection/store/sticky; extension owns order.
  for (const role of ALL_ROLES) {
    const label = role.replace("-", " ");
    pi.registerVirtualModel({
      provider: PROVIDER_ID,
      id: role,
      name: `Tokens ${label} (ladder)`,
      thinkingLevels: ["low", "medium", "high"],
      contextWindow: 1100000,
      maxTokens: 8192,
      route(request: any, ctx: any) {
        return routeForRole(role, request, ctx);
      },
    });
  }

  // Legacy auto kept as alias to fast for existing /model references.
  pi.registerVirtualModel({
    provider: PROVIDER_ID,
    id: "auto",
    name: "Auto (ladder: fast)",
    thinkingLevels: ["low", "medium", "high"],
    contextWindow: 1100000,
    maxTokens: 8192,
    route(request: any, ctx: any) {
      return routeForRole("fast", request, ctx);
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

  pi.on("after_provider_response" as any, async (event: any, _ctx: any) => {
    try {
      const headers = event?.headers ?? {};
      const id = headers["x-tokens-request-id"] ?? headers["X-Tokens-Request-Id"];
      if (id) {
        lastRequestId = String(id);
        pi.events.emit("tokens:request-logged", { requestId: lastRequestId, status: event?.status });
      }
    } catch {
      // never break provider flow
    }
  });

  // Commands: Pi defaults cover /model, /login, /scoped-models.
  pi.registerCommand("tokens-status", {
    description: "Show tokens.bd plan, usage, wallet, and key limits",
    handler: async (_args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
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
      if (lastRequestId) lines.push(`Last request id: ${lastRequestId}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("tokens-errors", {
    description: "List tokens.bd error codes and fixes",
    handler: async (_args: any, ctx: any) => {
      const lines = Object.entries(ERROR_MAP).map(([code, msg]) => `${code}: ${msg}`);
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
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const models = await fetchModelsRaw(apiKey);
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
