import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import {
  BASE_URL,
  MESSAGES_BASE_URL,
  CATALOG_URL,
  MODELS_URL,
  PROVIDER_ID,
  PROVIDER_ID_MESSAGES,
  PROVIDER_ID_RESPONSES,
} from "./config.js";
import {
  agentDir,
  packageRootDir,
  readJson,
  num,
  extractApiKey,
} from "./utils.js";
import { extensionState } from "./state.js";

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
export const ALL_ROLES = ["fast", "coder", "reasoner", "long-context", "private", "research"] as const;

// Last live catalog + costs fetched during refreshNativeModels. Used to derive
// ladder roles dynamically at route time instead of from a file.
let lastCatalog: CatalogModel[] = [];
let lastCosts: Record<string, CostEntry> = {};
let lastCostSource = "none";
let lastCostFetchedAt: Date | null = null;

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

const ALWAYS_THINKING_HINTS = [/kimi-?k3/i, /glm-?5\.3/i];
export function isAlwaysThinking(alias: string, description?: unknown): boolean {
  if (description && /always.+(think|reason)/i.test(String(description))) return true;
  return ALWAYS_THINKING_HINTS.some((re) => re.test(alias));
}

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

export function buildCosts(catalog: CatalogModel[]): Record<string, CostEntry> {
  const costs: Record<string, CostEntry> = {};
  for (const m of catalog) {
    if (!Number.isFinite(m.input) || !Number.isFinite(m.output)) continue;
    // tokens.bd bills unknown cache prices at the input price.
    costs[m.alias] = {
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead ?? m.input,
      cacheWrite: m.cacheWrite ?? m.input,
      contextWindow: m.contextWindow || 128000,
    };
  }
  return costs;
}

// Roles are derived from the live catalog on each refresh. Explicit user
// ladders (agent file, then env) override the algorithm per role.
export function deriveLadder(catalog: CatalogModel[]): LadderMap {
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

function normalizeInput(value: unknown): ("text" | "image")[] {
  if (Array.isArray(value)) {
    const filtered = value.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image");
    if (filtered.length) return filtered;
  }
  if (typeof value === "string" && (value === "text" || value === "image")) return [value];
  return ["text"];
}

export function mapModels(
  models: any[],
  costs: Record<string, CostEntry>,
  provider: string,
  baseUrl: string,
) {
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
    const always = isAlwaysThinking(id, raw?.description ?? raw?.about ?? raw?.notes);
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
    if (always) {
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

// Bundled costs.json is a fallback only. The live /api/models catalogue is
// the source of truth for prices and context windows.
export function loadFallbackCosts(): Record<string, CostEntry> {
  const candidates = [
    join(agentDir(), "tokens-costs.json"),
    join(packageRootDir(), "costs.json"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const data = readJson(candidate);
    if (data?.models && typeof data.models === "object") return data.models as Record<string, CostEntry>;
    if (data && typeof data === "object" && !data._note && !data.roles) {
      const values = Object.values(data);
      if (values.length && typeof values[0] === "object" && values[0] !== null && "input" in (values[0] as any)) {
        return data as Record<string, CostEntry>;
      }
    }
  }
  return {};
}

export async function fetchModelsRaw(apiKey: string, signal?: AbortSignal): Promise<any[]> {
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

export function providerApiAndBaseUrl(provider: string) {
  if (provider === PROVIDER_ID_MESSAGES) return { api: anthropicMessagesApi(), baseUrl: MESSAGES_BASE_URL };
  if (provider === PROVIDER_ID_RESPONSES) return { api: openAIResponsesApi(), baseUrl: BASE_URL };
  return { api: openAICompletionsApi(), baseUrl: BASE_URL };
}

export async function fetchNativeModels(context: RefreshModelsContext, provider: string = PROVIDER_ID): Promise<any[]> {
  const apiKey = extractApiKey(context.credential) ?? process.env.TOKENS_API_KEY;
  if (!apiKey) return storedFallback(context);
  const live = await fetchModelsRaw(apiKey, context.signal);
  if (!live.length) {
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

export function getRetryAfterSeconds(): number | null {
  // Commands should not read mutable extensionState directly to avoid coupling.
  // The retry hint stays inside usage.ts / state.ts; if not yet wired, return null.
  return extensionState.lastRetryAfterSeconds;
}

export function getLastCatalog(): CatalogModel[] { return lastCatalog; }
export function getLastCosts(): Record<string, CostEntry> { return lastCosts; }
export function getLastCostSource(): string { return lastCostSource; }
export function getLastCostFetchedAt(): Date | null { return lastCostFetchedAt; }
export function effectiveCosts(): Record<string, CostEntry> {
  if (Object.keys(lastCosts).length) return lastCosts;
  return loadFallbackCosts();
}
