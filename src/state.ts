// Shared extension state. Pi runs one extension instance per process, so a
// single mutable holder is safe. It is NOT persisted: Pi owns session
// history (usage history entries are appended via appendEntry and reloaded
// through session_start); these fields are request-scoped.
//
//   lastRequestId         — x-tokens-request-id header of the last response
//                           (support/trace reference for ladder errors)
//   lastRetryAfterSeconds — parsed Retry-After header, surfaced in error
//                           hints when the ladder exhausts
//   lastUsage             — latest /v1/tokens/usage poll result (footer-ish)
//   routerPlan / Mode     — virtual-router selection; also overridable via
//                           TOKENS_ROUTER_PLAN / TOKENS_ROUTER_MODE env
//   modelUsage            — per-model call tally this session (see
//                           /tokens history --by-model)
export const extensionState = {
  lastRequestId: null as string | null,
  lastRetryAfterSeconds: null as number | null,
  lastUsage: null as any,
  routerPlan: null as "weekly" | "monthly" | null,
  routerMode: null as "auto" | "economy" | "hard" | null,
  modelUsage: {} as Record<string, number>,
};
