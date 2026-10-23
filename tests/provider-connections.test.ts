import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatProviderConnectionLabel,
  hasProviderIdCollision,
  nextAvailableProviderId,
  nextAvailableProviderLabel,
  normalizeProviderIdBase,
  PROVIDER_ID_MAX_LEN,
  PROVIDER_ID_RE,
} from "../frontend/src/lib/providerConnections.js";
import { getSecret } from "../src/config/secretStore.js";
import {
  getProvider,
  getProvidersState,
  getStagesConfig,
  listProviders,
  putStagesConfig,
  readStudioAuditLog,
  StudioProviderConflictError,
  upsertProvider,
} from "../src/config/studioConfig.js";
import * as llm from "../src/llm/client.js";
import { handleStudioRoute } from "../src/player/studio.js";

let root: string;
let outDir: string;

async function studioRequest(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  pathname: string,
  body?: Record<string, unknown>,
) {
  const payload = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = Readable.from(payload) as IncomingMessage;
  req.method = method;
  req.headers = {
    host: "studio.local",
    origin: "http://studio.local",
    "x-csrf-token": "test-csrf",
    ...(body !== undefined ? { "content-type": "application/json" } : {}),
  };
  let result!: { status: number; body: any };
  await handleStudioRoute(
    req,
    {} as ServerResponse,
    pathname,
    new URL(pathname, "http://studio.local"),
    {
      user: "test-admin",
      exp: Date.now() + 60_000,
      isTemp: false,
      privileged: true,
      csrfToken: "test-csrf",
    },
    (_res, status, response) => {
      result = { status, body: response };
    },
  );
  return result;
}

beforeEach(() => {
  fs.mkdirSync("/tmp/opencode", { recursive: true });
  root = fs.mkdtempSync("/tmp/opencode/provider-connections-");
  outDir = path.join(root, "out");
  vi.stubEnv("MANHWA_OUT_DIR", outDir);
  vi.stubEnv("MANHWA_NO_AUTO_WORKER", "1");
  llm._resetSnapshotForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  llm._resetSnapshotForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("providerConnections helper: collision-free IDs, bounds, and labels", () => {
  it("preserves legacy first preset ID and increments -2, -3 on collision", () => {
    expect(nextAvailableProviderId("custom-openai", [])).toBe("custom-openai");
    expect(nextAvailableProviderId("custom-openai", [{ id: "custom-openai" }])).toBe("custom-openai-2");
    expect(
      nextAvailableProviderId("custom-openai", [
        { id: "custom-openai" },
        { id: "custom-openai-2" },
      ]),
    ).toBe("custom-openai-3");
    // Fills the lowest available suffix when -2 was deleted
    expect(
      nextAvailableProviderId("custom-openai", [
        { id: "custom-openai" },
        { id: "custom-openai-3" },
      ]),
    ).toBe("custom-openai-2");
  });

  it("retains editingId verbatim in edit mode even when present in existingProviders", () => {
    const existing = [{ id: "custom-openai" }, { id: "custom-openai-2" }];
    expect(nextAvailableProviderId("custom-openai", existing, "custom-openai")).toBe("custom-openai");
    expect(nextAvailableProviderId("custom-openai", existing, "custom-openai-2")).toBe("custom-openai-2");
    expect(hasProviderIdCollision("custom-openai", existing, "custom-openai")).toBe(false);
    expect(hasProviderIdCollision("custom-openai-2", existing, "custom-openai")).toBe(true);
  });

  it("does not use label or baseUrl as authoritative collision keys", () => {
    const existing = [
      {
        id: "custom-openai",
        label: "Custom OpenAI-Compatible",
        baseUrl: "https://api.shared-gateway.example/v1",
      },
    ];
    expect(nextAvailableProviderId("custom-openai", existing)).toBe("custom-openai-2");
    expect(nextAvailableProviderId("openrouter", existing)).toBe("openrouter");
  });

  it("honors max 64 chars and PROVIDER_ID_RE for long or dirty inputs", () => {
    const longBase = "a".repeat(64);
    expect(nextAvailableProviderId(longBase, [])).toBe(longBase);
    const secondLong = nextAvailableProviderId(longBase, [{ id: longBase }]);
    expect(secondLong.length).toBeLessThanOrEqual(PROVIDER_ID_MAX_LEN);
    expect(PROVIDER_ID_RE.test(secondLong)).toBe(true);
    expect(secondLong).toBe(`${"a".repeat(62)}-2`);

    const dirty = normalizeProviderIdBase("---My Custom Gateway!!---");
    expect(PROVIDER_ID_RE.test(dirty)).toBe(true);
    expect(dirty).toBe("My-Custom-Gateway");
  });

  it("derives disambiguated default and display labels when presets or labels repeat", () => {
    expect(nextAvailableProviderLabel("Custom OpenAI-Compatible", "custom-openai", "custom-openai", [])).toBe(
      "Custom OpenAI-Compatible",
    );
    expect(
      nextAvailableProviderLabel("Custom OpenAI-Compatible", "custom-openai-2", "custom-openai", [
        { id: "custom-openai", label: "Custom OpenAI-Compatible" },
      ]),
    ).toBe("Custom OpenAI-Compatible 2");

    const providers = [
      { id: "custom-openai", label: "Shared Name" },
      { id: "custom-openai-2", label: "Shared Name" },
      { id: "openrouter", label: "OpenRouter" },
    ];
    expect(formatProviderConnectionLabel(providers[0]!, providers)).toBe("Shared Name (custom-openai)");
    expect(formatProviderConnectionLabel(providers[1]!, providers)).toBe("Shared Name (custom-openai-2)");
    expect(formatProviderConnectionLabel(providers[2]!, providers)).toBe("OpenRouter");
  });
});

describe("Multiple OpenAI-compatible provider connections: CRUD, isolation, and guards", () => {
  it("supports 3 connections on the same custom-openai preset (different URLs and same URL with separate keys)", async () => {
    const c1 = await studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai",
      preset: "custom-openai",
      label: "Together Gateway",
      kind: "cloud-api",
      protocol: "openai-compatible",
      baseUrl: "https://api.together.example/v1",
      apiKey: "sk-together-secret-1111",
      models: ["meta-llama/Llama-4-Scout"],
      createOnly: true,
    });
    expect(c1.status).toBe(201);

    const c2 = await studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai-2",
      preset: "custom-openai",
      label: "Fireworks Gateway",
      kind: "cloud-api",
      protocol: "openai-compatible",
      baseUrl: "https://api.fireworks.example/v1",
      apiKey: "sk-fireworks-secret-2222",
      models: ["accounts/fireworks/models/deepseek-v3"],
      createOnly: true,
    });
    expect(c2.status).toBe(201);

    // Same endpoint URL as c1, but separate account/key
    const c3 = await studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai-3",
      preset: "custom-openai",
      label: "Together Backup Account",
      kind: "cloud-api",
      protocol: "openai-compatible",
      baseUrl: "https://api.together.example/v1",
      apiKey: "sk-together-acct2-3333",
      models: ["Qwen/Qwen2.5-VL-72B"],
      createOnly: true,
    });
    expect(c3.status).toBe(201);

    // GET /api/studio/providers and /api/studio/catalog retain all 3 connections
    const listRes = await studioRequest("GET", "/api/studio/providers");
    expect(listRes.status).toBe(200);
    expect(listRes.body.providers.map((p: any) => p.id)).toEqual([
      "custom-openai",
      "custom-openai-2",
      "custom-openai-3",
    ]);

    const catalogRes = await studioRequest("GET", "/api/studio/catalog");
    expect(catalogRes.status).toBe(200);
    expect(catalogRes.body.providers.map((p: any) => p.id)).toEqual([
      "custom-openai",
      "custom-openai-2",
      "custom-openai-3",
    ]);

    // Per-provider secrets are isolated and never leaked in GET responses
    const serialized = JSON.stringify(listRes.body);
    expect(serialized).not.toContain("sk-together-secret-1111");
    expect(serialized).not.toContain("sk-fireworks-secret-2222");
    expect(serialized).not.toContain("sk-together-acct2-3333");
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-together-secret-1111");
    expect(getSecret("provider:custom-openai-2", outDir)).toBe("sk-fireworks-secret-2222");
    expect(getSecret("provider:custom-openai-3", outDir)).toBe("sk-together-acct2-3333");

    // Editing connection 2 does not touch connection 1 or 3
    const patchRes = await studioRequest("PATCH", "/api/studio/providers/custom-openai-2", {
      label: "Fireworks Gateway Edited",
      baseUrl: "https://api.fireworks-v2.example/v1",
      apiKey: "sk-fireworks-updated-9999",
    });
    expect(patchRes.status).toBe(200);
    expect(getProvider("custom-openai", outDir)).toMatchObject({
      id: "custom-openai",
      label: "Together Gateway",
      baseUrl: "https://api.together.example/v1",
    });
    expect(getProvider("custom-openai-2", outDir)).toMatchObject({
      id: "custom-openai-2",
      label: "Fireworks Gateway Edited",
      baseUrl: "https://api.fireworks-v2.example/v1",
    });
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-together-secret-1111");
    expect(getSecret("provider:custom-openai-2", outDir)).toBe("sk-fireworks-updated-9999");
    expect(getSecret("provider:custom-openai-3", outDir)).toBe("sk-together-acct2-3333");

    // Deleting connection 2 leaves connection 1 and 3 and their secrets intact
    const delRes = await studioRequest("DELETE", "/api/studio/providers/custom-openai-2");
    expect(delRes.status).toBe(200);
    expect(listProviders(outDir).map((p) => p.id)).toEqual(["custom-openai", "custom-openai-3"]);
    expect(getSecret("provider:custom-openai-2", outDir)).toBeNull();
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-together-secret-1111");
    expect(getSecret("provider:custom-openai-3", outDir)).toBe("sk-together-acct2-3333");
  });

  it("rejects createOnly duplicate ID with 409 before any secret, config, audit, routing, or fetch side effect", async () => {
    upsertProvider(
      {
        id: "custom-openai",
        preset: "custom-openai",
        label: "Primary Custom",
        baseUrl: "https://primary.example/v1",
        apiKey: "sk-primary-keep-me",
        models: ["vision-model-1"],
      },
      outDir,
    );
    putStagesConfig(
      {
        stages: {
          reader: { chain: ["custom-openai:vision-model-1"], concurrency: 1, temperature: 0.2, inheritFrom: null },
          writer: { chain: ["custom-openai:vision-model-1"], concurrency: 1, temperature: 0.7, inheritFrom: null },
        },
      },
      outDir,
    );

    const providersFile = path.join(outDir, "config", "providers.json");
    const secretsFile = path.join(outDir, "config", "secrets.json");
    const stagesFile = path.join(outDir, "config", "stages.json");
    const auditFile = path.join(outDir, "config", "studio-audit.log");

    const beforeProvidersRaw = fs.readFileSync(providersFile, "utf8");
    const beforeSecretsRaw = fs.readFileSync(secretsFile, "utf8");
    const beforeStagesRaw = fs.readFileSync(stagesFile, "utf8");
    const beforeAuditRaw = fs.readFileSync(auditFile, "utf8");
    const beforeRevision = getProvidersState(outDir).revision;

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const dupRes = await studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai",
      preset: "custom-openai",
      label: "Accidental Overwrite",
      baseUrl: "https://overwrite.example/v1",
      apiKey: "sk-overwrite-do-not-save",
      codeOrUrl: "https://localhost:1455/auth/callback?code=oauth_should_not_run",
      codeVerifier: "v".repeat(43),
      verifyBeforeSave: true,
      createOnly: true,
    });

    expect(dupRes.status).toBe(409);
    expect(dupRes.body.code).toBe("provider_already_exists");
    expect(dupRes.body.error).toMatch(/already exists/i);
    expect(JSON.stringify(dupRes.body)).not.toContain("sk-overwrite-do-not-save");
    expect(JSON.stringify(dupRes.body)).not.toContain("sk-primary-keep-me");
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(fs.readFileSync(providersFile, "utf8")).toBe(beforeProvidersRaw);
    expect(fs.readFileSync(secretsFile, "utf8")).toBe(beforeSecretsRaw);
    expect(fs.readFileSync(stagesFile, "utf8")).toBe(beforeStagesRaw);
    expect(fs.readFileSync(auditFile, "utf8")).toBe(beforeAuditRaw);
    expect(getProvidersState(outDir).revision).toBe(beforeRevision);
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-primary-keep-me");

    // Direct store call also enforces createOnly
    expect(() =>
      upsertProvider(
        {
          id: "custom-openai",
          baseUrl: "https://direct-overwrite.example/v1",
          apiKey: "sk-direct-overwrite",
          createOnly: true,
        },
        outDir,
      ),
    ).toThrow(StudioProviderConflictError);
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-primary-keep-me");
  });

  it("protects against concurrent/stale double-create races after async verification", async () => {
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(
          JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const p1 = studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai",
      preset: "custom-openai",
      label: "First Tab",
      baseUrl: "https://first-tab.example/v1",
      apiKey: "sk-first-tab-winner",
      verifyBeforeSave: true,
      createOnly: true,
    });
    const p2 = studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai",
      preset: "custom-openai",
      label: "Stale Second Tab",
      baseUrl: "https://second-tab.example/v1",
      apiKey: "sk-second-tab-loser",
      verifyBeforeSave: true,
      createOnly: true,
    });

    releaseFetch();
    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winnerKey = r1.status === 201 ? "sk-first-tab-winner" : "sk-second-tab-loser";
    const winnerUrl = r1.status === 201 ? "https://first-tab.example/v1" : "https://second-tab.example/v1";
    expect(getProvider("custom-openai", outDir)?.baseUrl).toBe(winnerUrl);
    expect(getSecret("provider:custom-openai", outDir)).toBe(winnerKey);
    expect(listProviders(outDir)).toHaveLength(1);
  });

  it("preserves first provider, secrets, audit log, and stage routing when second provider verification fails", async () => {
    // First provider has empty models catalog (custom-openai default before /models sync),
    // with explicit stage routing pointing at custom-openai:custom-model-v1.
    upsertProvider(
      {
        id: "custom-openai",
        preset: "custom-openai",
        label: "Working First Provider",
        baseUrl: "https://working-one.example/v1",
        apiKey: "sk-working-first-key",
        models: [],
      },
      outDir,
    );
    putStagesConfig(
      {
        stages: {
          reader: { chain: ["custom-openai:custom-vision-v1"], concurrency: 1, temperature: 0.2, inheritFrom: null },
          writer: { chain: ["custom-openai:custom-writer-v1"], concurrency: 1, temperature: 0.7, inheritFrom: null },
        },
      },
      outDir,
    );

    const beforeProvidersRev = getProvidersState(outDir).revision;
    const beforeStages = getStagesConfig(outDir);
    const beforeAuditCount = readStudioAuditLog(outDir).length;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized key", { status: 401 })),
    );

    const failRes = await studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai-2",
      preset: "custom-openai",
      label: "Broken Second Provider",
      baseUrl: "https://broken-two.example/v1",
      apiKey: "sk-broken-second-key",
      verifyBeforeSave: true,
      createOnly: true,
    });

    expect(failRes.status).toBe(400);
    expect(String(failRes.body.error)).toMatch(/^Provider verification failed:/);
    expect(listProviders(outDir).map((p) => p.id)).toEqual(["custom-openai"]);
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-working-first-key");
    expect(getSecret("provider:custom-openai-2", outDir)).toBeNull();
    expect(getProvidersState(outDir).revision).toBe(beforeProvidersRev);
    expect(readStudioAuditLog(outDir).length).toBe(beforeAuditCount);

    const afterStages = getStagesConfig(outDir);
    expect(afterStages.revision).toBe(beforeStages.revision);
    expect(afterStages.reader.chain).toEqual(["custom-openai:custom-vision-v1"]);
    expect(afterStages.writer.chain).toEqual(["custom-openai:custom-writer-v1"]);

    // Adding a valid second provider also preserves custom-openai's stage routing even when custom-openai.models is []
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ id: "second-model-v1" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const okSecond = await studioRequest("POST", "/api/studio/providers", {
      id: "custom-openai-2",
      preset: "custom-openai",
      label: "Working Second Provider",
      baseUrl: "https://working-two.example/v1",
      apiKey: "sk-working-second-key",
      verifyBeforeSave: true,
      createOnly: true,
    });
    expect(okSecond.status).toBe(201);
    const stagesAfterSecond = getStagesConfig(outDir);
    expect(stagesAfterSecond.reader.chain).toEqual(["custom-openai:custom-vision-v1"]);
    expect(stagesAfterSecond.writer.chain).toEqual(["custom-openai:custom-writer-v1"]);
  });

  it("dispatches stage model refs (<providerId>:<modelId>) to the exact provider instance", async () => {
    upsertProvider(
      {
        id: "custom-openai",
        preset: "custom-openai",
        label: "Gateway One",
        baseUrl: "https://gw-one.example/v1",
        apiKey: "sk-gw-one-token",
        models: [
          {
            id: "shared-model",
            label: "Shared Model",
            enabled: true,
            capabilities: { vision: true, writer: true, json: true, reasoning: false, streaming: true, tts: false },
          },
        ],
      },
      outDir,
    );
    upsertProvider(
      {
        id: "custom-openai-2",
        preset: "custom-openai",
        label: "Gateway Two",
        baseUrl: "https://gw-two.example/v1",
        apiKey: "sk-gw-two-token",
        models: [
          {
            id: "shared-model",
            label: "Shared Model",
            enabled: true,
            capabilities: { vision: true, writer: true, json: true, reasoning: false, streaming: true, tts: false },
          },
        ],
      },
      outDir,
    );
    putStagesConfig(
      {
        stages: {
          reader: { chain: ["custom-openai:shared-model"], concurrency: 1, temperature: 0.2, inheritFrom: null },
          writer: { chain: ["custom-openai-2:shared-model"], concurrency: 1, temperature: 0.6, inheritFrom: null },
        },
      },
      outDir,
    );
    llm._resetSnapshotForTests();

    const seen: Array<{ url: string; auth: string; model: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const parsed = init?.body ? JSON.parse(String(init.body)) : {};
        seen.push({
          url: String(input),
          auth: headers.get("authorization") || "",
          model: parsed.model || "",
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: `ok from ${String(input)}` } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await llm.call([{ role: "user", content: "read panel" }], { stage: "reader" });
    await llm.call([{ role: "user", content: "write script" }], { stage: "writer" });

    expect(seen).toEqual([
      {
        url: "https://gw-one.example/v1/chat/completions",
        auth: "Bearer sk-gw-one-token",
        model: "shared-model",
      },
      {
        url: "https://gw-two.example/v1/chat/completions",
        auth: "Bearer sk-gw-two-token",
        model: "shared-model",
      },
    ]);
  });

  it("keeps legacy POST upsert working when createOnly is not set", async () => {
    const first = await studioRequest("POST", "/api/studio/providers", {
      id: "claude-oauth",
      preset: "claude-oauth",
      label: "Claude Subscription",
      kind: "subscription",
    });
    expect(first.status).toBe(201);

    const second = await studioRequest("POST", "/api/studio/providers", {
      id: "claude-oauth",
      preset: "claude-oauth",
      label: "Claude Subscription Reconnect",
      kind: "subscription",
      apiKey: "sk-ant-oat01-reconnect-token",
    });
    expect(second.status).toBe(201);
    expect(listProviders(outDir)).toHaveLength(1);
    expect(getProvider("claude-oauth", outDir)?.label).toBe("Claude Subscription Reconnect");
    expect(getSecret("provider:claude-oauth", outDir)).toBe("sk-ant-oat01-reconnect-token");
  });

  it("PATCH with verifyBeforeSave rejects bad key/URL or revokeSecret without mutating providers, secrets, stages, or audit log, and updates only target on success", async () => {
    upsertProvider(
      {
        id: "custom-openai",
        preset: "custom-openai",
        label: "Alpha Connection",
        baseUrl: "https://alpha.example/v1",
        apiKey: "sk-alpha-good-1111",
        models: ["alpha-model"],
      },
      outDir,
    );
    upsertProvider(
      {
        id: "custom-openai-2",
        preset: "custom-openai",
        label: "Beta Connection",
        baseUrl: "https://beta.example/v1",
        apiKey: "sk-beta-good-2222",
        models: ["beta-model"],
      },
      outDir,
    );
    putStagesConfig(
      {
        stages: {
          reader: { chain: ["custom-openai:alpha-model"], concurrency: 1, temperature: 0.2, inheritFrom: null },
          writer: { chain: ["custom-openai-2:beta-model"], concurrency: 1, temperature: 0.7, inheritFrom: null },
        },
      },
      outDir,
    );

    const providersFile = path.join(outDir, "config", "providers.json");
    const secretsFile = path.join(outDir, "config", "secrets.json");
    const stagesFile = path.join(outDir, "config", "stages.json");
    const auditFile = path.join(outDir, "config", "studio-audit.log");

    const snapProviders = fs.readFileSync(providersFile, "utf8");
    const snapSecrets = fs.readFileSync(secretsFile, "utf8");
    const snapStages = fs.readFileSync(stagesFile, "utf8");
    const snapAudit = fs.readFileSync(auditFile, "utf8");
    const currentRevision = getProvidersState(outDir).revision;

    // 1. Bad key/URL on PATCH with verifyBeforeSave:true leaves all files byte-identical
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("invalid key", { status: 401 })),
    );
    const badPatch = await studioRequest("PATCH", "/api/studio/providers/custom-openai-2", {
      id: "custom-openai", // body attempts to override id; path id must stay pinned
      label: "Should Not Persist",
      baseUrl: "https://beta-bad.example/v1",
      apiKey: "sk-beta-invalid-0000",
      verifyBeforeSave: true,
    });
    expect(badPatch.status).toBe(400);
    expect(String(badPatch.body.error)).toMatch(/^Provider verification failed:/);
    expect(fs.readFileSync(providersFile, "utf8")).toBe(snapProviders);
    expect(fs.readFileSync(secretsFile, "utf8")).toBe(snapSecrets);
    expect(fs.readFileSync(stagesFile, "utf8")).toBe(snapStages);
    expect(fs.readFileSync(auditFile, "utf8")).toBe(snapAudit);

    // 2. Incompatible revokeSecret + verifyBeforeSave without replacement key is rejected before deleting secret
    const badRevoke = await studioRequest("PATCH", "/api/studio/providers/custom-openai-2", {
      revokeSecret: true,
      verifyBeforeSave: true,
    });
    expect(badRevoke.status).toBe(400);
    expect(getSecret("provider:custom-openai-2", outDir)).toBe("sk-beta-good-2222");
    expect(fs.readFileSync(secretsFile, "utf8")).toBe(snapSecrets);

    // 3. Stale expectedRevision fails with 409 before probing (zero fetch calls) and before any write
    const spyFetch = vi.fn();
    vi.stubGlobal("fetch", spyFetch);
    const stalePatch = await studioRequest("PATCH", "/api/studio/providers/custom-openai-2", {
      label: "Stale Revision Edit",
      baseUrl: "https://beta-stale.example/v1",
      expectedRevision: currentRevision - 1,
      verifyBeforeSave: true,
    });
    expect(stalePatch.status).toBe(409);
    expect(spyFetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(providersFile, "utf8")).toBe(snapProviders);
    expect(fs.readFileSync(secretsFile, "utf8")).toBe(snapSecrets);

    // 4. Valid verified PATCH updates only custom-openai-2 (pinned to path id) and leaves custom-openai untouched
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(String(input)).toBe("https://beta-v2.example/v1/models");
        expect(headers.get("authorization")).toBe("Bearer sk-beta-good-2222");
        return new Response(
          JSON.stringify({ data: [{ id: "beta-model-v2", display_name: "Beta Model V2" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const goodPatch = await studioRequest("PATCH", "/api/studio/providers/custom-openai-2", {
      id: "custom-openai", // path id custom-openai-2 must win
      label: "Beta Connection V2",
      baseUrl: "https://beta-v2.example/v1",
      expectedRevision: currentRevision,
      verifyBeforeSave: true,
    });
    expect(goodPatch.status).toBe(200);
    expect(getProvider("custom-openai", outDir)).toMatchObject({
      id: "custom-openai",
      label: "Alpha Connection",
      baseUrl: "https://alpha.example/v1",
    });
    expect(getSecret("provider:custom-openai", outDir)).toBe("sk-alpha-good-1111");
    expect(getProvider("custom-openai-2", outDir)).toMatchObject({
      id: "custom-openai-2",
      label: "Beta Connection V2",
      baseUrl: "https://beta-v2.example/v1",
    });
    expect(getProvider("custom-openai-2", outDir)?.models.map((m) => m.id)).toEqual(["beta-model-v2"]);
    expect(getSecret("provider:custom-openai-2", outDir)).toBe("sk-beta-good-2222");
  });
});
