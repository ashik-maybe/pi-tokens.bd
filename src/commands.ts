// /tokens root handler + deprecated /tokens-* shims.
// All wiring goes here to keep index.ts thin: provider + hooks + poller only.

import {
  resolveApiKey,
  agentDir,
  readJson,
} from "./utils.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchModelsRaw,
  effectiveCosts,
  getLastCatalog,
  isAlwaysThinking,
  deriveLadder,
} from "./catalog.js";
import {
  fetchUsage,
  formatWindow,
  projectedMonthlySpend,
} from "./usage.js";
import { extensionState } from "./state.js";
import { ERROR_MAP } from "./errors.js";
import { COUNT_TOKENS_URL } from "./config.js";
import {
  getRouterMode,
  getRouterPlan,
  recommendModel,
  setRouterMode,
  setRouterPlan,
} from "./router.js";
import {
  fetchDynamicPool,
  recommendFromCatalog,
  rankFromCatalog,
} from "./dynamic-suggest.js";

export function registerTokensCommands(pi: any): void {
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
      extensionState.lastUsage = usage;
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
      if (extensionState.lastRequestId) lines.push(`Last request id: ${extensionState.lastRequestId}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },

    errors: async (_args: any, ctx: any) => {
      const lines = Object.entries(ERROR_MAP).map(([code, msg]) => `${code}: ${msg}`);
      if (extensionState.lastRequestId) lines.unshift(`Last request id: ${extensionState.lastRequestId}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },

    health: async (_args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const models = await fetchModelsRaw(apiKey);
      if (!models.length) {
        ctx.ui.notify("Health: live catalog fetch failed (offline or auth).", "error");
        return;
      }
      const costs = effectiveCosts();
      const lines = models.map((m: any) => {
        const c: any = costs[m.id];
        const costStr = c ? `in=${c.input}/M out=${c.output}/M` : "(no cost)";
        const ctxStr = c?.contextWindow ? `ctx=${c.contextWindow}` : "";
        return `${m.id}: ${costStr} ${ctxStr}`;
      });
      ctx.ui.notify(`tokens.bd: ${models.length} models via live catalog. ${lines.slice(0, 30).join(", ")}`, "info");
    },

    forecast: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      const blockArg = parts.find((p: string) => p.startsWith("--block="))?.split("=")[1];
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
      extensionState.lastUsage = usage;
      const lines: string[] = [];
      if (usage.plan) {
        lines.push(`Plan: ${usage.plan.name} (${usage.plan.tier})`);
        if (usage.plan.periodEnd) lines.push(`Period ends: ${usage.plan.periodEnd}`);
      } else {
        lines.push("Plan: pay-as-you-go");
      }
      for (const w of usage.windows ?? []) lines.push(formatWindow(w));
      if (usage.wallet && usage.wallet.balanceUsd !== null) lines.push(`Wallet: $${usage.wallet.balanceUsd.toFixed(2)} USD (BDT balance shown on dashboard only)`);
      const projected = projectedMonthlySpend(usage);
      lines.push(`Projected monthly spend: $${projected.toFixed(2)} USD`);
      if (blockArg && Number.isFinite(Number(blockArg)) && projected > Number(blockArg)) {
        lines.push(`Blocked: projection exceeds $${Number(blockArg).toFixed(2)} USD; switching will not auto-pick higher tier.`);
      }
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
        ctx.ui.notify("Provide text. Example: /tokens count --model deepseek/deepseek-v4.1-flash Explain idempotency.", "info");
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
      const findFlag = (id: string): boolean => !!ctx?.modelRegistry?.find?.("tokens.bd", id);
      const inferredId = !findFlag(currentModel) ? (getLastCatalog()[0]?.alias ?? undefined) : currentModel;
      const model =
        (modelArg && modelArg.trim() ? modelArg.trim() : undefined)
        || (currentModel && findFlag(currentModel) ? currentModel : inferredId)
        || Object.values(deriveLadder(getLastCatalog()) ?? {}).flat()[0];
      if (!model) {
        ctx.ui.notify("Missing model and live catalog empty. Pass: /tokens count --model <id> <text>", "warning");
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
        const costEntry: any = effectiveCosts()[model];
        const inPrice = Number(costEntry?.input ?? 0);
        const outPrice = Number(costEntry?.output ?? 0);
        const estInputCostUsd = (inputTokens * inPrice) / 1_000_000;
        const outTokens = Math.max(256, Math.min(1024, Math.ceil(inputTokens / 2)));
        const estOutputCostUsd = (outTokens * outPrice) / 1_000_000;
        const estTotalCostUsd = estInputCostUsd + estOutputCostUsd;
        ctx.ui.notify(`Est. cost: $${estTotalCostUsd.toFixed(5)} USD (input $${estInputCostUsd.toFixed(5)} + est. out $${estOutputCostUsd.toFixed(5)} @ ${outTokens} tok)`, "info");
      } catch (err) {
        ctx.ui.notify(`count failed: ${(err as Error).message || "(network)"}`, "error");
      }
    },

    history: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      const byModel = parts.includes("--by-model");
      if (byModel) {
        const entries = Object.entries(extensionState.modelUsage).sort((a, b) => b[1] - a[1]);
        if (!entries.length) {
          ctx?.ui?.notify?.("No model usage recorded this session.", "info");
          return;
        }
        const lines = entries.slice(0, 10).map(([model, count]) => `${model}: ${count} call(s)`);
        ctx?.ui?.notify?.("Model usage (session): \n" + lines.join("\n"), "info");
        return;
      }
      const wantsGraph = parts.includes("--graph") || parts.includes("--history-graph");
      const branch = ctx.sessionManager.getBranch();
      const entries = branch.filter((e: any) => e.type === "custom" && e.customType === "tokens-usage");
      if (entries.length === 0) {
        ctx.ui.notify("No usage history in this session yet.", "info");
        return;
      }
      const rows = entries.slice(-7);
      const lines = rows.map((e: any) => {
        const d = new Date(e.data.date).toLocaleDateString();
        const w = e.data.windows?.[0];
        return `${d}: $${e.data.wallet?.toFixed(2) ?? "?"} | ${w ? `${w.percentUsed}%` : "n/a"}`;
      });
      if (wantsGraph) {
        const samples = rows.map((e: any) => Number(e.data.wallet ?? 0));
        const max = Math.max(...samples, 1);
        const bars = samples.map((s: number) => {
          const blocks = Math.round((s / max) * 16);
          return "█".repeat(Math.max(1, blocks));
        });
        lines.push("--- graph ---");
        for (let i = 0; i < rows.length; i += 1) {
          const d = new Date(rows[i].data.date).toLocaleDateString();
          lines.push(`${d} ${bars[i]} $${samples[i].toFixed(2)}`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },

    compare: async (args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const parts = (args ?? []).map(String);
      const cwIdx = parts.indexOf("--compare-with");
      const compareText = cwIdx >= 0 ? parts.slice(cwIdx + 1).join(" ").trim() : "";
      if (compareText) {
        const tokensIn = Math.ceil(compareText.length / 4);
        const entries = Object.entries(effectiveCosts());
        if (!entries.length) {
          ctx.ui.notify("No costs loaded.", "warning");
          return;
        }
        const sorted = entries.map(([id, c]) => {
          const inC = Number(c?.input ?? 0);
          const outC = Number(c?.output ?? 0);
          const outTokens = Math.max(256, Math.min(1024, Math.ceil(tokensIn / 2)));
          const costUsd = (tokensIn * inC + outTokens * outC) / 1_000_000;
          return { id, costUsd };
        }).sort((a, b) => a.costUsd - b.costUsd).slice(0, 10);
        ctx.ui.notify(`Cost for ~${tokensIn} input tokens (top 10 cheapest):\n${sorted.map((x) => `${x.id}: $${x.costUsd.toFixed(5)}`).join("\n")}`, "info");
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
      ctx.ui.notify(lines.join("\n"), "info");
    },

    suggest: async (args: any, ctx: any) => {
      const costs = effectiveCosts();
      const entries = Object.entries(costs);
      if (entries.length === 0) {
        ctx.ui.notify("No costs loaded.", "warning");
        return;
      }
      const cheapest = entries.sort((a: any, b: any) => a[1].input + a[1].output - (b[1].input + b[1].output))[0];
      let line = `Cheapest: ${cheapest[0]} ($${cheapest[1].input}/M in, $${cheapest[1].output}/M out)`;
      const parts = (args ?? []).map(String);
      const text = parts.join(" ").trim();
      if (text) {
        const recommended = recommendModel(text);
        line += ` | Recommended: ${recommended}`;
      }
      ctx.ui.notify(line, "info");
    },

    "suggest-all": async (args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const parts = (args ?? []).map(String);
      const text = parts.join(" ").trim();
      if (!text) {
        ctx.ui.notify("Usage: /tokens suggest-all <prompt text>", "warning");
        return;
      }
      const res = await recommendFromCatalog(text, apiKey);
      if (!res) {
        ctx.ui.notify("No affordable models available (catalog empty or key restricted).", "warning");
        return;
      }
      ctx.ui.notify(`Recommend: ${res.model} (${res.rationale})`, "info");
    },

    models: async (args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const parts = (args ?? []).map(String);
      const limitArg = parts.find((p: string) => p.startsWith("--limit="))?.split("=")[1];
      const limit = limitArg ? Math.max(1, Math.min(50, Number(limitArg) || 20)) : 20;
      const cheap = parts.includes("--cheap");
      const countOnly = parts.includes("--count");
      const pool = await fetchDynamicPool(apiKey);
      if (!pool.length) {
        ctx.ui.notify("No models returned (catalog empty or key restricted).", "warning");
        return;
      }
      if (countOnly) {
        ctx.ui.notify(`Models available: ${pool.length}`, "info");
        return;
      }
      const mapped = pool.map((m) => ({ m, price: (m.input + m.output) / 2 })).sort((a, b) => a.price - b.price).map((x) => x.m);
      const slice = cheap ? mapped.slice(0, limit) : pool.slice(0, limit);
      const lines = slice.map((m) => `${m.id}: $${m.input.toFixed(2)}/M in, $${m.output.toFixed(2)}/M out, ctx=${(m.contextWindow / 1000).toFixed(0)}K`);
      ctx.ui.notify(`Models (${pool.length}):\n${lines.join("\n")}`, "info");
    },

    rank: async (args: any, ctx: any) => {
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify("Run /login tokens.bd first.", "warning");
        return;
      }
      const parts = (args ?? []).map(String);
      const cheapFlag = parts.includes("--cheap");
      const textParts = parts.filter((p: string) => p !== "--cheap");
      const text = textParts.join(" ").trim();
      if (!text) {
        ctx.ui.notify("Usage: /tokens rank [--cheap] <prompt text>", "warning");
        return;
      }
      if (cheapFlag) {
        const pool = await fetchDynamicPool(apiKey);
        if (!pool.length) {
          ctx.ui.notify("No models returned (catalog empty or key restricted).", "warning");
          return;
        }
        const sorted = pool.map((m) => ({ m, price: (m.input + m.output) / 2 })).sort((a, b) => a.price - b.price).map((x) => x.m);
        const slice = sorted.slice(0, 10);
        const lines = slice.map((m, i) => {
          const marker = m.input < 2.0 ? "cheap" : "premium";
          return `${i + 1}. [${marker}] ${m.id}: $${m.input.toFixed(2)}/M in, $${m.output.toFixed(2)}/M out, ctx=${(m.contextWindow / 1000).toFixed(0)}K`;
        });
        ctx.ui.notify(`Cheapest rank:\n${lines.join("\n")}`, "info");
        return;
      }
      const ranked = await rankFromCatalog(text, apiKey, 10);
      if (!ranked) {
        ctx.ui.notify("No models returned (catalog empty or key restricted).", "warning");
        return;
      }
      const lines = ranked.map((m, i) => {
        const marker = m.input < 2.0 ? "cheap" : "premium";
        return `${i + 1}. [${marker}] ${m.id}: $${m.input.toFixed(2)}/M in, $${m.output.toFixed(2)}/M out, ctx=${(m.contextWindow / 1000).toFixed(0)}K`;
      });
      ctx.ui.notify(`Ranked:\n${lines.join("\n")}`, "info");
    },

    pin: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      const sessionOnly = parts.includes("--session") || parts.includes("--only");
      const modelId = parts.find((p: string) => !p.startsWith("--"));
      if (!modelId) {
        ctx?.ui?.notify?.("Usage: /tokens pin <model-id> [--session]", "warning");
        return;
      }
      if (sessionOnly) {
        extensionState.sessionPinnedModel = modelId;
        extensionState.lastPinnedModel = modelId;
        ctx?.ui?.notify?.(`Pinned model for this session: ${modelId}. Clears when the extension reloads.`, "info");
        return;
      }
      try {
        const file = join(agentDir(), "pinned-model.json");
        mkdirSync(agentDir(), { recursive: true });
        writeFileSync(file, JSON.stringify({ model: modelId }), "utf8");
        extensionState.lastPinnedModel = modelId;
        ctx?.ui?.notify?.(`Pinned model saved: ${modelId}. Picks up next time you /login or /reload.`, "info");
      } catch (err) {
        ctx?.ui?.notify?.(`Pin failed: ${String(err)}`, "error");
      }
    },

    cost: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      const text = parts.join(" ").trim();
      if (!text) {
        ctx?.ui?.notify?.("Usage: /tokens cost <prompt text>", "warning");
        return;
      }
      const entries = Object.entries(effectiveCosts());
      if (!entries.length) {
        ctx?.ui?.notify?.("No costs loaded.", "warning");
        return;
      }
      const tokensIn = Math.ceil(text.length / 4);
      const cheapest = entries.sort((a, b) => a[1].input + a[1].output - (b[1].input + b[1].output))[0];
      const [model, cost] = cheapest;
      const inCost = (tokensIn * (cost.input ?? 0)) / 1_000_000;
      const outTokens = Math.max(256, Math.min(1024, Math.ceil(tokensIn / 2)));
      const outCost = (outTokens * (cost.output ?? 0)) / 1_000_000;
      ctx?.ui?.notify?.(`≈${model}: input≈${tokensIn} tok → $${(inCost + outCost).toFixed(5)} USD (in $${inCost.toFixed(5)} + est. out $${outCost.toFixed(5)} @ ${outTokens} tok)`, "info");
    },

    explain: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      const text = parts.join(" ").trim();
      if (!text) {
        ctx?.ui?.notify?.("Usage: /tokens explain <prompt text>", "warning");
        return;
      }
      const lower = text.toLowerCase();
      const isHard = /complex|refactor|debug|implement|design|architect|security|performance|optimize/.test(lower) || lower.length > 1500;
      const isCheap = /\[cheap\]|\bfix typo\b|\brenam|\bcomment\b/i.test(lower) || lower.length < 200;
      const reason = isHard ? "hard (context/quality)" : isCheap ? "cheap (small edit)" : "default/balanced";
      const model = recommendModel(text);
      ctx?.ui?.notify?.(`Explain: ${reason} → ${model}`, "info");
    },

    router: async (args: any, ctx: any) => {
      const parts = (args ?? []).map(String);
      const sub = (parts[0] ?? "status").toLowerCase();
      try {
        if (sub === "status") {
          ctx?.ui?.notify?.(`Router: plan=${getRouterPlan()} mode=${getRouterMode()}`, "info");
          return;
        }
        if (sub === "plan" && (parts[1] === "weekly" || parts[1] === "monthly")) {
          setRouterPlan(parts[1] as any);
          ctx?.ui?.notify?.(`Router: plan set to ${parts[1]}`, "info");
          return;
        }
        if (sub === "mode" && (parts[1] === "auto" || parts[1] === "economy" || parts[1] === "hard")) {
          setRouterMode(parts[1] as any);
          ctx?.ui?.notify?.(`Router: mode set to ${parts[1]}`, "info");
          return;
        }
        ctx?.ui?.notify?.("Usage: /tokens router status | plan weekly|monthly | mode auto|economy|hard", "info");
      } catch (e) {
        try { ctx?.ui?.notify?.(`Router: ${String(e)}`, "error"); } catch {}
      }
    },
  };

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
    description: "Tokens.bd one-stop: /tokens (status|compare|suggest|count|history|errors|health|forecast|suggest-all|models|rank|pin|cost|explain|router)",
    handler: tokensRootHandler,
  });
}