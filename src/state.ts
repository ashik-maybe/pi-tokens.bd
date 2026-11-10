// Shared extension state. One default-export per Pi extension, so a single
// mutable holder is fine here.
export const extensionState = {
  lastRequestId: null as string | null,
  lastRetryAfterSeconds: null as number | null,
  lastUsage: null as any,
};
