// Dynamic catalog-backed recommendation for expanded pool.
// Distinct from virtual-router, which only uses plan-allowlists.
// Pure price/context scoring. No LLM classifier. No network fetch per request.

import { fetchModelsRaw, effectiveCosts, mapModels } from "./catalog.js";
import { BASE_URL, PROVIDER_ID } from "./config.js";

export interface CatalogModel {
  id: string;
  input: number;
  output: number;
  contextWindow: number;
}

export async function fetchDynamicPool(apiKey: string): Promise<CatalogModel[]> {
  const raw = await fetchModelsRaw(apiKey);
  const costs = effectiveCosts();
  const mapped = mapModels(raw, costs, PROVIDER_ID, BASE_URL);
  return mapped.map((m: any) => ({
    id: m.id,
    input: Number(m.cost?.input ?? 0),
    output: Number(m.cost?.output ?? 0),
    contextWindow: Number(m.contextWindow ?? 128000),
  }));
}

function scoreModel(m: CatalogModel, isHard: boolean, isCheap: boolean): number {
  const price = (m.input + m.output) / 2;
  if (price <= 0) return 0;
  let score = 1 / price;
  if (isHard) {
    score += Math.log10(Math.max(m.contextWindow, 1)) * 2;
  }
  if (isCheap) {
    score *= 2;
  }
  return score;
}

// Choose the best affordable model for `text` from the live catalog.
// Returns null if the catalogue is empty. Filters premium models unless hard.
export async function recommendFromCatalog(text: string, apiKey: string): Promise<{ model: string; rationale: string } | null> {
  const pool = await fetchDynamicPool(apiKey);
  if (!pool.length) return null;

  const lower = String(text ?? "").toLowerCase();
  const isHard = /complex|refactor|debug|implement|design|architect|security|performance|optimize/.test(lower) || lower.length > 1500;
  const isCheap = /\[cheap\]/.test(lower) || /\bfix typo\b|\brenam|\bcomment\b/.test(lower) || lower.length < 200;

  const filtered = isHard
    ? pool
    : pool.filter((m) => m.input < 2.0); // avoid premium/inflated models outside hard hint

  if (!filtered.length) return null;

  const scored = [...filtered].sort(
    (a, b) => scoreModel(b, isHard, isCheap) - scoreModel(a, isHard, isCheap),
  );
  const chosen = scored[0];
  const priceStr = `$${chosen.input.toFixed(2)}/M in`;
  return {
    model: chosen.id,
    rationale: `price=${priceStr} ctx=${(chosen.contextWindow / 1000).toFixed(0)}K`,
  };
}
