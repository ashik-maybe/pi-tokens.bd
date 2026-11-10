import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
  type Credential,
  type OAuthCredential,
  type ProviderAuthInteraction,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";

const BASE_URL = "https://tokens.bd/v1";
const MESSAGES_BASE_URL = "https://tokens.bd";
const MODELS_URL = "https://tokens.bd/v1/models";
const CATALOG_URL = "https://tokens.bd/api/models";
const USAGE_URL = "https://tokens.bd/v1/tokens/usage";
const COUNT_TOKENS_URL = "https://tokens.bd/v1/messages/count_tokens";
const PROVIDER_ID = "tokens.bd";
const PROVIDER_ID_RESPONSES = "tokens.bd-responses";
const PROVIDER_ID_MESSAGES = "tokens.bd-messages";
const PROVIDER_VERSION = "0.6.0";

interface CostEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindow: number;
}

interface CatalogModel {
  alias: string;
  contextWindow: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

type LadderMap = Record<string, string[]>;

// Roles derived from live catalog. `private` is kept as a registered alias
// to `fast` for existing user configs; it has no reliable catalogue signal.
const ALL_ROLES = ["fast", "coder", "reasoner", "long-context", "private", "research"] as const;

// effort names follow OpenAI's (reasoning_effort) superset:
// none, minimal, low, medium, high, xhigh, max. Provider support varies per model;
// the gateway passes values through. Pi sends them in the request.
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const ROLE_THINKING_LEVELS: Record<string, readonly ThinkingLevel[]> = {
  fast: ["low", "medium"],
  coder: ["low", "medium", "high", "xhigh"],
  reasoner: ["high", "xhigh", "max"],
  "long-context": ["medium", "high", "xhigh"],
  private: ["low", "medium"],
  research: ["medium", "high", "max"],
};

// Last live catalog + costs fetched during refreshModels. Used to derive
// ladder roles dynamically at route time instead of from a file.
let lastCatalog: CatalogModel[] = [];
let lastCosts: Record<string, CostEntry> = {};
let lastCostSource = "none";
let lastCostFetchedAt: Date | null = null;
let lastRequestId: string | null = null;
let lastRetryAfterSeconds: number | null = null;
const usageAlertMemory = new Map<string, number>();

const ERROR_MAP: Record<string, string> = {
  free_limit_reached: "Plan usage windows used up. Wait for reset (shown in /tokens-status) or upgrade plan.",
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
  rate_limited: "Rate limited (RPM). Wait Retry-After seconds. Scattered parallelism helps more than retries.",
  concurrency_limit: "Too many in flight. Reduce parallelism. Retry-After: 2s.",
  window_exhausted: "Usage window exhausted. Wait for reset (timing in /tokens-status). Do not retry in a loop.",
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

// Pi owns chat auth (runtime --api-key > stored > models.json > env
// TOKENS_API_KEY) and API-key resolution for the usage poller. Direct
// auth.json reads were removed: they could return a different key than
// the one Pi is actually using.
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

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
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
      // fall through
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
  // No registry: Pi's env path is the only remaining source.
  return process.env.TOKENS_API_KEY || undefined;
}

// cache-read/write price fields differ across catalogue revisions. Read any
// of them best-effort; missing fields fall back to input price as before.
function cachePriceField(pricing: any, key: string): number {
  const variants = [
    key,
    `${key}PerMillionUsd`,
    `${key}PerMillion`,
    `${key}PricePerMillionUsd`,
    `${key}PricePerMillion`,
    `${key === "cacheRead" ? "cache_read" : "cache_write"}_input_usd_per_million`,
  ];
  for (const variant of variants) {
    const value = Number(pricing?.[variant]);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
}

// Bundled costs.json is a fallback only. The live /api/models catalogue is
// the source of truth for prices and context windows.
function loadFallbackCosts(): Record<string, CostEntry> {
  const candidates = [
    join(agentDir(), "tokens-costs.json"),
    join(packageRootDir(), "costs.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const data = readJson(candidate);
    if (data?.models && typeof data.models === "object") return data.models;
    if (data && typeof data === "object" && !data._note && !data.roles) {
      const values = Object.values(data);
      if (values.length && typeof values[0] === "object" && values[0] !== null && "input" in (values[0] as any)) {
        return data as Record<string, CostEntry>;
      }
    }
  }
  return {};
}

function effectiveCosts(): Record<string, CostEntry> {
  if (Object.keys(lastCosts).length) return lastCosts;
  return loadFallbackCosts();
}

// ---------------------------------------------------------------------------
// Dynamic catalog (prices + context windows) from https://tokens.bd/api/models
// ---------------------------------------------------------------------------

async function fetchCatalog(signal?: AbortSignal): Promise<CatalogModel[]> {
  try {
    const res = await fetch(CATALOG_URL, { signal });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: any[] };
    const out: CatalogModel[] = [];
    for (const m of Array.isArray(data.models) ? data.models : []) {
      const alias = String(m?.alias ?? "").trim();
      if (!alias || m?.isActive === false) continue;
      const pricing = m?.pricing ?? {};
      const cacheRead = cachePriceField(pricing, "cacheRead");
      const cacheWrite = cachePriceField(pricing, "cacheWrite");
      out.push({
        alias,
        contextWindow: num(m?.contextWindow, 0),
        input: num(pricing.inputPricePerMillionUsd, Number.NaN),
        output: num(pricing.outputPricePerMillionUsd, Number.NaN),
        cacheRead: Number.isFinite(cacheRead) ? cacheRead : undefined,
        cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function buildCosts(catalog: CatalogModel[]): Record<string, CostEntry> {
  const costs: Record<string, CostEntry> = {};
  for (const m of catalog) {
    if (!Number.isFinite(m.input) || !Number.isFinite(m.output)) continue;
    // tokens.bd bills unknown cache prices at the input price.
    costs[m.alias] = {
      input: m.input,
      output: m.output,
      cacheRead: Number.isFinite(m.cacheRead ?? Number.NaN) ? (m.cacheRead as number) : m.input,
      cacheWrite: Number.isFinite(m.cacheWrite ?? Number.NaN) ? (m.cacheWrite as number) : m.input,
      contextWindow: m.contextWindow || 128000,
    };
  }
  return costs;
}

// Roles are derived from the live catalog on each refresh. Explicit user
// ladders (agent file, then env) override the algorithm per role.
function deriveLadder(catalog: CatalogModel[]): LadderMap {
  const priced = catalog.filter((m) => Number.isFinite(m.input) && Number.isFinite(m.output));
  const byCost = [...priced].sort((a, b) => a.input + a.output - (b.input + b.output));
  const ids = (list: CatalogModel[]) => list.slice(0, 4).map((m) => m.alias);
  const algorithm: LadderMap = {
    fast: ids(byCost.filter((m) => m.contextWindow <= 256000)),
    coder: ids(byCost.filter((m) => m.contextWindow >= 256000)),
    reasoner: ids([...byCost].sort((a, b) => b.contextWindow - a.contextWindow).filter((m) => m.contextWindow >= 1000000)),
    "long-context": ids([...byCost].sort((a, b) => b.contextWindow - a.contextWindow)),
    private: ids(byCost),
    research: ids(byCost),
  };
  // Fill any empty role from the cheapest overall list so route never starves.
  const cheapest = ids(byCost);
  for (const role of Object.keys(algorithm)) {
    if (!algorithm[role].length && cheapest.length) algorithm[role] = cheapest;
  }

  const envOverride: LadderMap = {};
  for (const role of ALL_ROLES) {
    const envKey = `TOKENS_${role.replace("-", "_").toUpperCase()}`;
    const val = process.env[envKey];
    if (val?.trim()) {
      envOverride[role] = val.split(",").map((s: string) => s.trim()).filter(Boolean);
    }
  }

  const agentLadder = join(agentDir(), "tokens-ladder.json");
  if (existsSync(agentLadder)) {
    const data = readJson(agentLadder);
    const roles = (data?.roles ?? data) as LadderMap | undefined;
    if (roles && typeof roles === "object") return { ...algorithm, ...roles, ...envOverride };
  }
  return { ...algorithm, ...envOverride };
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

// Docs (choosing-a-model, checked October 2026) list these as always-on thinking
// models. Detected from catalog description when present, otherwise by alias.
const ALWAYS_THINKING_HINTS = [/kimi-?k3/i, /glm-?5\.3/i];
function isAlwaysThinking(alias: string, description?: unknown): boolean {
  if (description && /always.+(think|reason)/i.test(String(description))) return true;
  return ALWAYS_THINKING_HINTS.some((re) => re.test(alias));
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

function mapModels(models: any[], costs: Record<string, CostEntry>, provider = PROVIDER_ID, baseUrl = BASE_URL) {
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
    const alwaysThinking = isAlwaysThinking(id, raw?.description ?? raw?.about ?? raw?.notes);
    const inputModalities = raw.input ?? raw.modalities ?? raw.image ?? undefined;
    const model: Record<string, any> = {
      type: "chat",
      id,
      name: String(raw.name ?? id),
      api: provider === PROVIDER_ID_MESSAGES ? "anthropic-messages" : provider === PROVIDER_ID_RESPONSES ? "openai-responses" : "openai-completions",
      provider,
      baseUrl,
      reasoning: Boolean(reasoning),
      input: normalizeInput(inputModalities),
      cost: { input, output, cacheRead, cacheWrite },
      contextWindow: num(raw.contextWindow ?? raw.context_window ?? raw.contextLength ?? cost.contextWindow, 128000),
      maxTokens: num(raw.maxTokens ?? raw.max_tokens ?? raw.max_output_tokens, 8192),
    };
    if (alwaysThinking) {
      model.reasoning = true;
      model.thinkingLevelMap = { ...(typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {}), effort: "max" };
    }
    if (raw.thinkingLevelMap && typeof raw.thinkingLevelMap === "object") model.thinkingLevelMap = raw.thinkingLevelMap;
    if (raw.inputLimits && typeof raw.inputLimits === "object") model.inputLimits = raw.inputLimits;
    if (raw.promptCache && typeof raw.promptCache === "object") model.promptCache = raw.promptCache;
    if (raw.compat && typeof raw.compat === "object") model.compat = raw.compat;
    if (raw.samplingParams && typeof raw.samplingParams === "object") model.samplingParams = raw.samplingParams;
    mapped.push(model);
  }
  return mapped;
}

// Pi's models store is the snapshot. A failed live fetch never wipes it.
function storedFallback(context: RefreshModelsContext): any[] {
  if (context.stored?.models?.length) return context.stored.models as any[];
  return [];
}

function providerApiAndBaseUrl(provider: string) {
  if (provider === PROVIDER_ID_MESSAGES) return { api: anthropicMessagesApi(), baseUrl: MESSAGES_BASE_URL };
  if (provider === PROVIDER_ID_RESPONSES) return { api: openAIResponsesApi(), baseUrl: BASE_URL };
  return { api: openAICompletionsApi(), baseUrl: BASE_URL };
}

async function fetchNativeModels(context: RefreshModelsContext, provider = PROVIDER_ID): Promise<any[]> {
  const apiKey = extractApiKey(context.credential) ?? process.env.TOKENS_API_KEY;
  if (!apiKey) return storedFallback(context);
  const live = await fetchModelsRaw(apiKey, context.signal);
  if (!live.length) {
    // Empty list may mean a failed request or an empty key allow-list.
    // Never wipe the snapshot on failure either way.
    return storedFallback(context);
  }
  const catalog = await fetchCatalog(context.signal);
  if (catalog.length) {
    lastCatalog = catalog;
    lastCosts = buildCosts(catalog);
    lastCostSource = "tokens.bd/api/models";
    lastCostFetchedAt = new Date();
  } else {
    lastCatalog = [];
    lastCosts = loadFallbackCosts();
    lastCostSource = "bundled costs.json";
    lastCostFetchedAt = null;
  }
  const baseUrl = providerApiAndBaseUrl(provider).baseUrl;
  return mapModels(live, lastCosts, provider, baseUrl);
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
  "free_limit_reached",
  "model_limit_reached",
  "invalid_request",
  "request_entity_too_large",
  "endpoint_not_supported_for_model",
  "anthropic_protocol_disabled",
  "model_not_found",
  "unsupported_endpoint",
]);

// Extract the machine-readable code from a gateway error body. Both shapes
// carry it: OpenAI-style `{"error":{"code":"..."}}` and Anthropic-style
// `{"type":"error","error":{"type":"...","code":"..."}}`. Falls back to a
// bare code-looking token or status digits in free text.
function extractErrorCode(errorMessage: string): string | undefined {
  const text = errorMessage ?? "";
  const jsonMatch = text.match(/"code"\s*:\s*"([A-Za-z0-9_-]{2,64})"/);
  if (jsonMatch) return jsonMatch[1].toLowerCase();
  const altMatch = text.match(/\b(missing_api_key|invalid_api_key|key_inactive|key_expired|account_suspended|model_not_allowed_on_key|monthly_spend_cap_exceeded|tier_permission_denied|model_not_found|insufficient_credits|no_funding|outstanding_debt|member_cap_reached|rate_limited|concurrency_limit|window_exhausted|model_limit_reached|free_limit_reached|rate_limit_exceeded|upstream_unreachable|upstream_error|upstream_timeout|no_upstream_available|model_not_priced|model_not_available|request_entity_too_large|invalid_request|endpoint_not_supported_for_model|anthropic_protocol_disabled|lookup_failed|admission_error|catalog_error|usage_unavailable|unsupported_endpoint|context_length_exceeded|context_overflow)\b/i);
  return altMatch ? altMatch[1].toLowerCase() : undefined;
}

function classifyFailure(errorMessage: string): "retryable" | "non_retryable" {
  const text = (errorMessage ?? "").toLowerCase();
  const code = extractErrorCode(text);
  // Billing, auth and cap errors: retrying cannot fix them.
  if (code && NON_RETRYABLE_CODES.has(code)) return "non_retryable";
  // Known-transient upstream codes.
  if (code && RETRYABLE_CODES.has(code)) return "retryable";
  for (const retryable of RETRYABLE_CODES) {
    if (text.includes(retryable)) return "retryable";
  }
  // tokens.bd bodies carry status numbers and/or ChatGPT-style codes.
  const statusMatch = text.match(/\b(4\d\d|5\d\d)\b/);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 429 || (status !== undefined && status >= 500)) return "retryable";
  if (status !== undefined && status >= 400 && status < 500) return "non_retryable";
  // Unknown: never burn budget retrying a likely 4xx/billing error.
  if (text.includes("context")) return "retryable";
  return "non_retryable";
}

function errorHint(errorMessage: string): string {
  const code = extractErrorCode(errorMessage ?? "");
  if (code) {
    const hint = ERROR_MAP[code];
    if (hint) return hint;
  }
  const text = (errorMessage ?? "").toLowerCase();
  for (const [mapped, hint] of Object.entries(ERROR_MAP)) {
    if (text.includes(mapped)) return hint;
  }
  return errorMessage ? errorMessage.slice(0, 240) : "Request failed.";
}

// Early-warning usage alerts. Fires once per 75/90/100% threshold per
// window per reset. Usage poll never re-notifies within the same reset window.
// Pre-flight size guard. Estimates prompt size from chars/4 like tokens.bd's
// own admission check does. Not a token count; see /v1/messages/count_tokens.
// Only notifies; never mutates the payload or blocks the request.
const PREFLIGHT_WARN_AT = 0.80;
const PREFLIGHT_STRICT_AT = 0.95;
const PREFLIGHT_COOLDOWN_MS = 60_000;
let lastPreflightWarn = 0;

function roughPromptTokens(payload: unknown): number {
  try {
    return Math.ceil(JSON.stringify(payload).length / 4);
  } catch {
    return 0;
  }
}

// Rough model ceiling from id strings. Prefer explicit catalog/Pi values when present.
const CONTEXT_HINTS: Record<string, number> = {
  "kimi-k3": 1_000_000,
  "glm-5.3": 1_000_000,
  "deepseek/deepseek-v4.1-flash": 1_000_000,
  "deepseek/deepseek-v4-pro-latest": 1_000_000,
};

function guessContextCap(modelIdHint: string | undefined): number {
  const hint = String(modelIdHint ?? "").toLowerCase();
  if (!hint) return 1_048_576;
  const direct = CONTEXT_HINTS[hint];
  if (direct) return direct;
  if (hint.includes("codex") || hint.includes("response")) return 400_000;
  if (hint.includes("kimi")) return 1_000_000;
  if (hint.includes("gemini")) return 1_000_000;
  return 128_000;
}

// Compact-overflow hint. One fire per overflow, 120 s cooldown.
let lastCompactOverflowHint = 0;
const COMPACT_OVERFLOW_COOLDOWN_MS = 120_000;

const USAGE_ALERT_THRESHOLDS = [
  { percent: 75, level: "info" as const, note: "75% used" },
  { percent: 90, level: "warning" as const, note: "90% used — compact in Pi (/compact) or switch cheaper model" },
  { percent: 100, level: "warning" as const, note: "window exhausted — expect 429 window_exhausted until reset" },
];

function checkUsageAlerts(usage: any, ui?: { notify?: (msg: string, level: string) => void }): void {
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
      try {
        ui?.notify?.(msg, threshold.level);
      } catch {
        // swallow
      }
      break;
    }
  }
}

function humanTimeLeft(iso: string | undefined): string {
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

function formatWindow(w: any): string {
  const label = String(w?.label ?? w?.type ?? "window");
  const percent = num(w?.percentUsed, 0);
  const used = num(w?.used, 0);
  const limit = num(w?.limit, 0);
  const remaining = w?.remaining !== undefined && w?.remaining !== null ? num(w.remaining, Math.max(0, limit - used)) : Math.max(0, limit - used);
  const unit = String(w?.unit ?? "");
  const timeLeft = humanTimeLeft(w?.resetsAt ?? "");
  return `${label}: ${remaining} remaining of ${limit}${unit ? ` ${unit}` : ""} (${percent}%, used ${used}, resets in ${timeLeft})`;
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
  const ids = deriveLadder(lastCatalog)[role] ?? [];
  if (!ids.length) {
    throw new Error(`No ladder for ${role}. Catalog offline and no tokens-ladder.json override. Check /v1/models.`);
  }
  const sticky = request.failed ?? request.previous;
  if (request.reason === "retry" && sticky?.model) {
    const failedId = sticky.model.id;
    const message = request.failed?.message?.errorMessage ?? sticky.message?.errorMessage ?? "";
    if (classifyFailure(message) === "non_retryable") {
      // Fail fast: retrying another ladder step cannot fix auth, billing,
      // spend caps, or malformed input, and would only burn usage.
      const suffix = lastRetryAfterSeconds !== null ? ` (Retry-After: ${lastRetryAfterSeconds}s)` : "";
      throw new Error(errorHint(message) + suffix);
    }
    const next = pickNextPhysical(ctx, ids, failedId);
    if (next) return { model: next, thinkingLevel: request.thinkingLevel ?? sticky.thinkingLevel ?? "medium" };
    const suffix = lastRetryAfterSeconds !== null ? ` (Retry-After: ${lastRetryAfterSeconds}s)` : "";
    throw new Error(`Ladder ${role} exhausted after ${failedId}. ${errorHint(message)}${suffix}`);
  }
  if (request.reason !== "user" && sticky?.model) {
    return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? request.thinkingLevel ?? "medium" };
  }
  const first = pickNextPhysical(ctx, ids);
  if (first) return { model: first, thinkingLevel: request.thinkingLevel ?? "medium" };
  throw new Error(`Ladder ${role} has no available model. Check /v1/models and account limits.`);
}

export default function (pi: ExtensionAPI) {
  let lastUsage: any = null;
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
      checkUsageAlerts(lastUsage, ctx?.ui);
    }
  };

  // Native providers: Pi owns auth order, offline snapshot, SSE streaming,
  // and usage accounting. The extension owns discovery + costs + ladders.
  // Register all three wire protocols so users can pick the backend that
  // matches their tool (completions / responses / messages).
  const makeProvider = (id: string, name: string) => createProvider({
    id,
    name,
    baseUrl: providerApiAndBaseUrl(id).baseUrl,
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
    fetchModels: (ctx) => fetchNativeModels(ctx, id),
    api: providerApiAndBaseUrl(id).api,
  });

  const provider = makeProvider(PROVIDER_ID, "Tokens.bd");
  pi.registerProvider(provider);
  pi.registerProvider(makeProvider(PROVIDER_ID_RESPONSES, "Tokens.bd (Responses)"));
  pi.registerProvider(makeProvider(PROVIDER_ID_MESSAGES, "Tokens.bd (Messages)"));

  // Ladder virtual models: Pi owns selection/store/sticky; extension owns
  // order. Order is derived from the live catalog at refresh time.
  for (const role of ALL_ROLES) {
    const label = role.replace("-", " ");
    pi.registerVirtualModel({
      provider: PROVIDER_ID,
      id: role,
      name: `Tokens ${label} (ladder)`,
      thinkingLevels: ROLE_THINKING_LEVELS[role] ?? ["low", "medium", "high"],
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
    thinkingLevels: ROLE_THINKING_LEVELS.fast,
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

  pi.on("after_provider_response" as any, async (event: any, ctx: any) => {
    try {
      const headers = event?.headers ?? {};
      const id = headers["x-tokens-request-id"] ?? headers["X-Tokens-Request-Id"] ?? headers["x-request-id"];
      if (id) {
        lastRequestId = String(id);
        pi.events.emit("tokens:request-logged", { requestId: lastRequestId, status: event?.status });
      }
      const retryAfterRaw = headers["retry-after"] ?? headers["Retry-After"];
      if (retryAfterRaw !== undefined && retryAfterRaw !== null) {
        const parsed = Number(retryAfterRaw);
        lastRetryAfterSeconds = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      }
      // Notify on rate limit right here so it is visible during a run.
      // Pi UI may swallow it outside an agent run; events always fire.
      const status = event?.status;
      if (status === 429 && retryAfterRaw !== undefined) {
        try {
          ctx?.ui?.notify?.(`tokens.bd 429 — wait ${retryAfterRaw}s (Retry-After). /tokens-status shows windows.`, "warning");
        } catch {
          // swallow: never break provider flow
        }
      }
    } catch {
      // never break provider flow
    }
  });

  // Pre-flight size guard. Runs once per request; never blocks; safe if payload
  // is one half of a websocket turn. Pi stores last window; we just warn.
  pi.on("before_provider_request", async (event: any, ctx: any) => {
    try {
      const payload = event?.payload;
      if (payload === undefined || typeof payload !== "object") return undefined;
      const chars = JSON.stringify(payload).length;
      const approxTokens = roughPromptTokens(payload);
      const hint = String(payload.model ?? ctx?.model?.id ?? "").toLowerCase();
      const piContext = Number(ctx?.model?.contextWindow ?? 0);
      const cap = piContext > 8192 ? piContext : guessContextCap(hint);
      const strict = cap * PREFLIGHT_STRICT_AT;
      const warn = cap * PREFLIGHT_WARN_AT;
      if (approxTokens >= strict) {
        if (Date.now() - lastPreflightWarn >= PREFLIGHT_COOLDOWN_MS) {
          lastPreflightWarn = Date.now();
          const line = `tokens.bd preflight: ~${approxTokens.toLocaleString()} tokens vs context ${cap.toLocaleString()} on ${hint || "current model"}. Compact NOW (/compact) or drop large files from context.`;
          try { pi.events.emit("tokens:preflight-warn", { approxTokens, cap, hint }); } catch {}
          try { ctx?.ui?.notify?.(line, "warning"); } catch {}
        }
      } else if (approxTokens >= warn) {
        if (Date.now() - lastPreflightWarn >= PREFLIGHT_COOLDOWN_MS) {
          lastPreflightWarn = Date.now();
          const line = `tokens.bd preflight: ~${approxTokens.toLocaleString()} of ${cap.toLocaleString()} context used. /tokens-count --model ${hint || "<id>"} for exact count (not billed).`;
          try { pi.events.emit("tokens:preflight-watch", { approxTokens, cap, hint }); } catch {}
          try { ctx?.ui?.notify?.(line, "info"); } catch {}
        }
      }
      return undefined;
    } catch {
      return undefined; // never break provider flow
    }
  });

  // Compact-overflow hint. Surfaces the cheapest ladder model and a pointer
  // to /tokens-count for exact sizing. Never overrides compaction itself.
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    try {
      if (event?.reason !== "overflow") return undefined;
      if (Date.now() - lastCompactOverflowHint < COMPACT_OVERFLOW_COOLDOWN_MS) return undefined;
      lastCompactOverflowHint = Date.now();
      try { ctx?.ui?.notify?.("tokens.bd overflow: choose /tokens-suggest and confirm /compact; exact count needs /tokens-count --model <id>.", "warning"); } catch {}
      try { pi.events.emit("tokens:compact-overflow", { reason: "overflow", willRetry: event?.willRetry ?? false, tokensBefore: event?.preparation?.tokensBefore }); } catch {}
      return undefined;
    } catch {
      return undefined;
    }
  });

  // Commands: Pi defaults cover /model, /login, /scoped-models.
  // Consolidates six /tokens-* into one /tokens <mode> root; old names kept as deprecated shims.
  const handlers = {
    status: async (_args: any, ctx: any) => {
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
        lines.push(formatWindow(w));
      }
      if (usage.wallet && usage.wallet.balanceUsd !== null) lines.push(`Wallet: $${usage.wallet.balanceUsd.toFixed(2)} USD (BDT balance shown on dashboard only)`);
      if (usage.key?.monthlySpendCapUsd) lines.push(`Key cap: $${usage.key.monthlySpendCapUsd}/mo`);
      if (usage.key?.allowedModels) lines.push(`Allowed: ${usage.key.allowedModels.join(", ")}`);
      if (lastRequestId) lines.push(`Last request id: ${lastRequestId}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
    errors: async (_args: any, ctx: any) => {
      const lines = Object.entries(ERROR_MAP).map(([code, msg]) => `${code}: ${msg}`);
      if (lastRequestId) lines.unshift(`Last request id: ${lastRequestId}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
    count: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      let modelArg: string | undefined;
      const textParts: string[] = [];
      for (const part of parts) {
        if (part.startsWith("--model=")) {
          modelArg = part.slice("--model=".length).trim();
        } else if (part.startsWith("--model ")) {
          modelArg = part.slice("--model ".length).trim();
        } else {
          textParts.push(part);
        }
      }
      const text = textParts.join(" ").trim();
      if (!text) {
        ctx.ui.notify("Provide text. Example: /tokens-count --model deepseek/deepseek-v4.1-flash Explain idempotency.", "info");
        return;
      }
      if (text.length > 8000) {
        ctx.ui.notify("Text too large — split and retry.", "warning");
        return;
      }
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const currentModel = ctx?.model?.id ?? ctx?.currentModel?.id;
      const model = modelArg?.trim()
        || (currentModel && ctx?.modelRegistry?.find?.(PROVIDER_ID, currentModel) ? currentModel : undefined)
        || Object.values(deriveLadder(lastCatalog) ?? {}).flat()[0];
      if (!model) {
        ctx.ui.notify("Missing model and live catalog empty. Pass: /tokens-count --model <id> <text>", "warning");
        return;
      }
      try {
        const res = await fetch(COUNT_TOKENS_URL, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
        });
        const raw = await res.json().catch(() => undefined);
        if (!res.ok) {
          const code = String(raw?.error?.code ?? raw?.code ?? `HTTP ${res.status}`).toLowerCase();
          const message = raw?.error?.message ?? raw?.message ?? "count failed";
          ctx.ui.notify(`count failed: ${code} — ${message}`, "error");
          return;
        }
        const inputTokens = Number(raw?.input_tokens ?? 0);
        ctx.ui.notify(`${model}: input_tokens=${inputTokens} (not billed)`, "info");
      } catch (err) {
        ctx.ui.notify(`count failed: ${(err as Error).message || "(network)"}`, "error");
      }
    },
    history: async (_args: any, ctx: any) => {
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
    compare: async (_args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const models = await fetchModelsRaw(apiKey);
      const costs = effectiveCosts();
      const lines = models
        .map((m: any) => {
          const c = costs[m.id];
          const always = isAlwaysThinking(String(m.id));
          if (!c) return `${m.id}: (no cost data)${always ? " (always-on thinking)" : ""}`;
          const note = always ? " (always-on thinking: effort=max)" : "";
          return `${m.id}: in=$${c.input}/M out=$${c.output}/M cacheRead=$${c.cacheRead}/M ctx=${c.contextWindow}${note}`;
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (lastCostSource) lines.unshift(`Source: ${lastCostSource}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
    suggest: async (_args: any, ctx: any) => {
      const costs = effectiveCosts();
      const entries = Object.entries(costs);
      if (entries.length === 0) {
        ctx.ui.notify("No costs loaded.", "warning");
        return;
      }
      const cheapest = entries.sort((a: any, b: any) => a[1].input + a[1].output - (b[1].input + b[1].output))[0];
      ctx.ui.notify(`Cheapest: ${cheapest[0]} ($${cheapest[1].input}/M in, $${cheapest[1].output}/M out)`, "info");
    },
  };

  // Deprecation shim: once-per-name notice, call through.
  const MODEL_ALIASES: [string, keyof typeof handlers][] = [
    ["tokens-status", "status"],
    ["tokens-errors", "errors"],
    ["tokens-count", "count"],
    ["tokens-history", "history"],
    ["tokens-compare", "compare"],
    ["tokens-suggest", "suggest"],
  ];

  const deprecationWarned = new Set<string>();
  for (const [oldName, key] of MODEL_ALIASES) {
    pi.registerCommand(oldName, {
      description: `Deprecated alias of /tokens ${key}; will call through`,
      handler: async (args: any, ctx: any) => {
        if (!deprecationWarned.has(oldName)) {
          deprecationWarned.add(oldName);
          try { ctx?.ui?.notify?.(`/${oldName} is deprecated; use /tokens ${key}`, "warning"); } catch {}
        }
        return handlers[key](args, ctx);
      },
    });
  }

  function tokensRootHandler(args: any, ctx: any): Promise<void> {
    const raw: string = Array.isArray(args) ? args.join(" ") : String(args ?? "");
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    const mode = (parts[0] ?? "status").toLowerCase();
    const h = (handlers as any)[mode];
    if (typeof h !== "function") {
      const names = Object.keys(handlers).join(", ");
      try { ctx?.ui?.notify?.(`Usage: /tokens [${names}]`, "info"); } catch {}
      return Promise.resolve();
    }
    return h(parts.slice(1), ctx);
  }

  pi.registerCommand("tokens", {
    description: "Tokens.bd one-stop: /tokens (status|compare|suggest|count|history|errors)",
    handler: tokensRootHandler,
  });
}
