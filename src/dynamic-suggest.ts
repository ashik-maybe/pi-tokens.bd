// Dynamic catalog-backed recommendation for the EXPANDED pool.
//
// Selection contract:
//   - Candidates: every model on the account's /v1/models with a live catalog
//     price > $0. Models without catalog pricing are excluded entirely.
//   - Non-hard prompts are restricted to input < $2.00/M ("cheap tier") to
//     avoid casually routing to premium/inflated picks; hard prompts may pick
//     from the full pool.
//   - Scoring is deterministic price/context heuristics (1/avgPrice, +log10
//     context for hard prompts, 2x for explicit cheap hints). No LLM call.
//   - These are SUGGESTIONS only — nothing here is applied automatically.
//
// virtual-router (router.ts) is a different thing: it routes the request.
// This module answers "what would you pick for this text?" for /tokens
// suggest-all|rank|explain. Pure price/context scoring; no LLM classifier.

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
  return mapped
    .map((m: any) => ({
      id: m.id,
      input: Number(m.cost?.input ?? NaN),
      output: Number(m.cost?.output ?? NaN),
      contextWindow: Number(m.contextWindow ?? 128000),
    }))
    .filter((m: CatalogModel) => Number.isFinite(m.input) && Number.isFinite(m.output) && m.input > 0 && m.output > 0);
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

// Return top N models by score for the given text.
export async function rankFromCatalog(text: string, apiKey: string, limit = 10): Promise<CatalogModel[] | null> {
  const pool = await fetchDynamicPool(apiKey);
  if (!pool.length) return null;

  const lower = String(text ?? "").toLowerCase();
  const isHard = /complex|refactor|debug|implement|design|architect|security|performance|optimize/.test(lower) || lower.length > 1500;
  const isCheap = /\[cheap\]/.test(lower) || /\bfix typo\b|\brenam|\bcomment\b/.test(lower) || lower.length < 200;

  const filtered = isHard ? pool : pool.filter((m) => m.input < 2.0);
  if (!filtered.length) return null;

  return [...filtered]
    .sort((a, b) => scoreModel(b, isHard, isCheap) - scoreModel(a, isHard, isCheap))
    .slice(0, Math.max(1, Math.min(20, limit)));
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
