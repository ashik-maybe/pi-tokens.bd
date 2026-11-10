// Ladder routing for Tokens.bd virtual models.
// Pure router: reads live catalog state + extension state.

import {
  PROVIDER_ID,
} from "./config.js";
import {
  classifyFailure,
  errorHint,
} from "./errors.js";
import {
  deriveLadder,
  getLastCatalog,
} from "./catalog.js";
import { extensionState } from "./state.js";

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
      // Fail fast: retrying another ladder step cannot fix auth, billing,
      // spend caps, or malformed input, and would only burn usage.
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
