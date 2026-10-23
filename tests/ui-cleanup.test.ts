import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildIntakeLanes,
  conciseNodeLabel,
  formatRenderNodeSubtitle,
  getRenderKindMeta,
  parseIntakeJob,
  RENDER_KIND_META,
} from "../frontend/src/lib/renderLanes.js";
import {
  buildTtsProviders,
  conciseProviderLabel,
  conciseVoiceName,
  inferVoiceModel,
  normalizeHttpUrl,
} from "../frontend/src/lib/tts.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("UI cleanup & behavioral contracts", () => {
  it("uses concise human render lane labels while preserving canonical IDs", () => {
    expect(RENDER_KIND_META.inherit.label).toBe("Auto");
    expect(RENDER_KIND_META.local.label).toBe("Local");
    expect(RENDER_KIND_META["docker-sbx"].label).toBe("Sandbox");
    expect(RENDER_KIND_META.ssh.label).toBe("SSH");
    expect(getRenderKindMeta("docker-sbx", "sbx-1").shortLabel).toBe("Sandbox");
    expect(getRenderKindMeta("ssh", "ssh-1").shortLabel).toBe("SSH");
    expect(conciseNodeLabel("Local Host Worker", "local", "local")).toBe("Local");
    expect(conciseNodeLabel("Docker Cloud Sandbox", "docker-sbx", "sbx-1")).toBe("Sandbox");
    expect(conciseNodeLabel("Render Box 2", "ssh", "ssh-2")).toBe("Render Box 2");
    expect(formatRenderNodeSubtitle({ kind: "docker-sbx", box: "manhwa-box-1" })).toBe("Sandbox · manhwa-box-1");

    const catalogWithUnconfiguredBuiltins = {
      renderLanes: [
        { id: "inherit", label: "Auto", available: true, kind: "inherit" },
        { id: "local", label: "Local Host Worker", available: true, kind: "local" },
        { id: "cloud", label: "Docker Cloud Sandbox", available: false, unavailableReason: "MANHWA_RENDER_CLOUD=0", kind: "docker-sbx" },
        { id: "laptop", label: "Remote SSH", available: false, unavailableReason: "MANHWA_RENDER_REMOTE=0", kind: "ssh" },
        { id: "sbx-1", label: "Cloud Sandbox", available: true, kind: "docker-sbx" },
      ],
    };
    const configuredNodes = [
      { id: "local", label: "Local Host Worker", kind: "local", enabled: true },
      { id: "sbx-1", label: "Cloud Sandbox", kind: "docker-sbx", enabled: true },
    ];

    // Working sbx-1 selected: unconfigured builtin cloud/laptop placeholders are hidden
    const activeLanes = buildIntakeLanes(catalogWithUnconfiguredBuiltins, configuredNodes, "sbx-1", "sbx-1");
    expect(activeLanes.map((l) => l.id)).toEqual(["inherit", "local", "sbx-1"]);
    expect(activeLanes.filter((l) => !l.available)).toEqual([]);

    // Saved default is unconfigured 'cloud': 'cloud' is retained as unavailable to block launch
    const pinnedCloudLanes = buildIntakeLanes(catalogWithUnconfiguredBuiltins, configuredNodes, "cloud", "cloud");
    const cloudOpt = pinnedCloudLanes.find((l) => l.id === "cloud");
    expect(cloudOpt).toBeDefined();
    expect(cloudOpt?.available).toBe(false);
  });

  it("validates http(s) URLs and rejects CLI commands like 'sbx login'", () => {
    expect(normalizeHttpUrl("https://login.docker.com/activate?user_code=ABCD")).toBe(
      "https://login.docker.com/activate?user_code=ABCD",
    );
    expect(normalizeHttpUrl("http://127.0.0.1:4176/studio.html")).toBe("http://127.0.0.1:4176/studio.html");
    expect(normalizeHttpUrl("sbx login")).toBeNull();
    expect(normalizeHttpUrl("Run `sbx login` in a terminal")).toBeNull();
    expect(normalizeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeHttpUrl("")).toBeNull();
    expect(normalizeHttpUrl(null)).toBeNull();
  });

  it("checks Studio and Neural2 family IDs before generic raw.engine='chirp'", () => {
    expect(
      inferVoiceModel("en-US-Studio-O", { label: "Studio-O · Studio", engine: "chirp" }, "vertex"),
    ).toEqual({
      modelId: "studio",
      modelLabel: "Studio",
    });
    expect(
      inferVoiceModel("en-US-Neural2-F", { label: "Neural2-F · Neural2", engine: "chirp" }, "vertex"),
    ).toEqual({
      modelId: "neural2",
      modelLabel: "Neural2",
    });
    expect(
      inferVoiceModel("en-US-Chirp3-HD-Charon", { label: "Charon · Chirp 3 HD", engine: "chirp" }, "vertex"),
    ).toEqual({
      modelId: "chirp-3-hd",
      modelLabel: "Chirp 3 HD",
    });
    expect(
      inferVoiceModel("gemini-tts:Charon", { label: "Charon · Gemini 3.8 Flash TTS", engine: "gemini" }, "vertex"),
    ).toEqual({
      modelId: "gemini-3.8-flash-tts",
      modelLabel: "Gemini 3.8 Flash TTS",
    });
  });

  it("never fabricates voices or overrides backend available:false", () => {
    expect(conciseProviderLabel("edge", "Edge TTS (Free, Default)", "edge")).toBe("Edge");
    expect(conciseProviderLabel("vertex", "Google Vertex AI TTS (Chirp 3 HD & Gemini 3.8)", "vertex")).toBe("Vertex");
    expect(conciseProviderLabel("grok", "xAI Grok TTS (Studio subscription)", "grok")).toBe("Grok");

    expect(conciseVoiceName("en-US-Chirp3-HD-Charon", "Charon · Chirp 3 HD")).toBe("Charon");
    expect(conciseVoiceName("gemini-tts:Charon", "Charon · Gemini 3.8 Flash TTS")).toBe("Charon");
    expect(conciseVoiceName("en-US-AndrewMultilingualNeural", "Andrew Multilingual (en-US, Default)")).toBe(
      "Andrew Multilingual",
    );

    // Null or failed catalog returns empty array (never invents Edge)
    expect(buildTtsProviders(null, [])).toEqual([]);

    // Chirp-only catalog never fabricates Gemini voices
    const chirpOnly = buildTtsProviders(
      {
        defaultProvider: "edge",
        providers: [
          {
            id: "vertex",
            label: "Google Vertex AI TTS",
            engine: "vertex",
            defaultVoice: "en-US-Chirp3-HD-Puck",
            available: true,
            voices: [
              { id: "en-US-Chirp3-HD-Charon", label: "Charon · Chirp 3 HD" },
              { id: "en-US-Chirp3-HD-Puck", label: "Puck · Chirp 3 HD" },
            ],
          },
        ],
      },
      [],
    );
    expect(chirpOnly).toHaveLength(1);
    expect(chirpOnly[0]!.models.map((m) => m.id)).toEqual(["chirp-3-hd"]);
    expect(chirpOnly[0]!.voices.find((v) => v.default)?.id).toBe("en-US-Chirp3-HD-Puck");

    // Backend available:false stays false even when Studio has connected Vertex credentials
    const unavailableVertex = buildTtsProviders(
      {
        defaultProvider: "edge",
        providers: [
          {
            id: "vertex",
            label: "Google Vertex AI TTS",
            engine: "vertex",
            available: false,
            unavailableReason: "Quota project missing",
            voices: [{ id: "en-US-Chirp3-HD-Charon", label: "Charon · Chirp 3 HD", default: true }],
          },
        ],
      },
      [
        {
          id: "vertex-ai",
          preset: "vertex-ai",
          protocol: "vertex-openai",
          enabled: true,
          auth: { mode: "vertex-oauth", hasSecret: true },
        },
      ],
    );
    expect(unavailableVertex[0]!.available).toBe(false);
    expect(unavailableVertex[0]!.unavailableReason).toBe("Quota project missing");

    // Non-Vertex cloud-iam provider is not assumed to be Vertex
    const nonVertexIam = buildTtsProviders(
      { defaultProvider: "edge", providers: [] },
      [
        {
          id: "aws-bedrock",
          kind: "cloud-iam",
          protocol: "openai-compatible",
          enabled: true,
          auth: { mode: "bearer", hasSecret: true },
        },
      ],
    );
    expect(nonVertexIam).toEqual([]);

    // Complete backend catalog supports both Chirp 3 HD and Gemini 3.8 Flash TTS
    const complete = buildTtsProviders(
      {
        defaultProvider: "edge",
        providers: [
          {
            id: "edge",
            label: "Edge TTS",
            engine: "edge",
            available: true,
            voices: [{ id: "en-US-AndrewMultilingualNeural", label: "Andrew Multilingual (en-US, Default)", default: true }],
          },
          {
            id: "vertex",
            label: "Google Vertex AI TTS",
            engine: "vertex",
            available: true,
            voices: [
              { id: "en-US-Chirp3-HD-Charon", label: "Charon · Chirp 3 HD", modelId: "chirp-3-hd", modelLabel: "Chirp 3 HD", default: true },
              { id: "gemini-tts:Charon", label: "Charon · Gemini 3.8 Flash TTS", modelId: "gemini-3.8-flash-tts", modelLabel: "Gemini 3.8 Flash TTS" },
            ],
          },
        ],
      },
      [],
    );
    const vtx = complete.find((g) => g.id === "vertex")!;
    expect(vtx.available).toBe(true);
    expect(vtx.models.map((m) => m.label)).toEqual(["Chirp 3 HD", "Gemini 3.8 Flash TTS"]);
    expect(vtx.models[1]!.voices[0]!.id).toBe("gemini-tts:Charon");
  });

  it("preserves authoritative empty controlActions in parseIntakeJob", () => {
    const emptyControls = parseIntakeJob({ id: "job-1", status: "running", controlActions: [] });
    expect(emptyControls.controlActions).toEqual([]);

    const unadvertised = parseIntakeJob({ id: "job-2", status: "running" });
    expect(unadvertised.controlActions).toBeUndefined();
  });

  it("enforces StatusPage, StudioPage, NewSeriesPage, and CopyButton cleanup invariants", () => {
    const statusSrc = fs.readFileSync(path.join(REPO_ROOT, "frontend/src/pages/StatusPage.tsx"), "utf8");
    expect(statusSrc).not.toContain("onControlLane");
    expect(statusSrc).not.toContain("controlLane(");
    expect(statusSrc).not.toContain("0.62");
    expect(statusSrc).not.toContain("0.12");
    expect(statusSrc).not.toContain("16 * 1024 ** 3");
    expect(statusSrc).not.toContain("100 * 1024 ** 3");
    expect(statusSrc).toContain("Confirm stop");

    const studioSrc = fs.readFileSync(path.join(REPO_ROOT, "frontend/src/pages/StudioPage.tsx"), "utf8");
    expect(studioSrc).toContain('id="studioDefaultLane"');
    expect(studioSrc).toContain('id="studioTtsProvider"');
    expect(studioSrc).toContain('id="studioTtsModel"');
    expect(studioSrc).not.toContain('value="sbx login"');
    expect(studioSrc).not.toContain("Chain is held for this session");
    expect(studioSrc).not.toContain("Saved · rev");
    expect(studioSrc).not.toContain("worker.metrics.mem_gb / 16");
    expect(studioSrc).not.toContain("worker.metrics.disk_gb / 100");

    const newSeriesSrc = fs.readFileSync(path.join(REPO_ROOT, "frontend/src/pages/NewSeriesPage.tsx"), "utf8");
    expect(newSeriesSrc).not.toContain("Quick Start (Default Voice & 720p)");
    expect(newSeriesSrc).not.toContain('qualityOverride: "720p"');
    expect(newSeriesSrc).toContain('id="ttsModel"');
    expect(newSeriesSrc).toContain("Start series");

    const copyBtnSrc = fs.readFileSync(path.join(REPO_ROOT, "frontend/src/components/ui/copy-button.tsx"), "utf8");
    expect(copyBtnSrc).not.toContain("data-copy-value");
    expect(copyBtnSrc).not.toContain("raw.trim()");
  });
});
