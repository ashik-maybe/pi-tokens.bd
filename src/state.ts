// Shared extension state. One default-export per Pi extension, so a single
// mutable holder is fine here.
export const extensionState = {
  lastRequestId: null as string | null,
  lastRetryAfterSeconds: null as number | null,
  lastUsage: null as any,
  routerPlan: null as "weekly" | "monthly" | null,
  routerMode: null as "auto" | "economy" | "hard" | null,
  routerDisable: false as boolean,
  lastPinnedModel: null as string | null,
};
