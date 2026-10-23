import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Activity,
  ArrowRight,
  AudioLines,
  Box,
  Check,
  Cloud,
  FileText,
  HardDrive,
  Info,
  Monitor,
  Plus,
  Radio,
  RotateCcw,
  Server,
  Waves,
} from "lucide-react";

import {
  api,
  type Session,
  isConflict,
  type AuditEntry,
  type IntakeCatalog,
  type PipelineWorker,
  type PipelineStatus,
  type PromptStageId,
  type ProviderModel,
  type ProviderPreset,
  type ProviderView,
  type ReasoningEffort,
  type RenderNode,
  type RenderNodeKind,
  type RenderQuality,
  type StageId,
  type StageRoute,
  type StagesState,
  type StudioPromptsState,
  type StudioSettingsState,
  type StudioStorageReport,
  type TrashItem,
  type VertexDetectedProject,
} from "@/lib/api";
import { errorLine } from "@/lib/errors";
import { navigateClient } from "@/components/layout/AppShell";
import { StorageTrashDrawer, StorageTrashPanel, fmtStorageBytes } from "@/components/shared/StorageTrashDrawer";
import { AppearanceSection, AccountSection, ShortcutsSection } from "@/components/layout/SettingsDialog";
import { MeterPage } from "@/pages/MeterPage";
import {
  BOX_RE,
  clampSlotsForKind,
  conciseNodeLabel,
  DEFAULT_LANE_ID,
  DEFAULT_SANDBOX_IDLE_PAUSE_S,
  DEFAULT_SANDBOX_MAX_HOURS,
  DEFAULT_SANDBOX_TEMPLATE,
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_REMOTE_DIR,
  DEFAULT_SSH_USER,
  getRenderKindMeta,
  HOST_RE,
  LANE_ID_RE,
  maxSlotsForKind,
  NODE_ID_RE,
} from "@/lib/renderLanes";
import {
  buildTtsProviders,
  isPaidTtsProvider,
  normalizeHttpUrl,
  readPreferredVoice,
  writePreferredVoice,
  type TtsProviderGroup,
} from "@/lib/tts";
import {
  formatProviderConnectionLabel,
  hasProviderIdCollision,
  nextAvailableProviderId,
  nextAvailableProviderLabel,
} from "@/lib/providerConnections";
import { StudioTabs } from "@/components/layout/StudioTabs";
import { DefaultOutroSettings } from '@/components/library/DefaultOutroSettings';
import { Button } from "@/components/ui/button";
import { Notice, NoticeButton } from "@/components/ui/notice";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Dropzone, DropzoneContent, DropzoneEmptyState } from "@/components/ui/dropzone";
import { ModelSelector, type ModelOption } from "@/components/ui/model-selector";
import {
  ParameterSlider,
  ParameterSliderControl,
  ParameterSliderHeader,
  ParameterSliderInput,
  ParameterSliderLabel,
  ParameterSliderReset,
} from "@/components/ui/parameter-slider";
import { PasswordInput, PasswordInputField } from "@/components/ui/password";
import { Sortable, SortableHandle, SortableItem } from "@/components/ui/sortable";
import { Terminal, TerminalBody, TerminalHeader, TerminalLine } from "@/components/ui/terminal";
import { cn } from "@/lib/utils";

type FilterId = "all" | "cloud-api" | "subscription" | "cloud-iam" | "local" | "tts";
type UiStage = StageId;
type NoticeTone = "info" | "danger" | "success" | "warning";
type OnNotice = (message: string, tone?: NoticeTone) => void;
type CapName = "vision" | "writer" | "reasoning" | "tts" | "image" | "json" | "streaming";
type VertexAuthMode = "vertex-service-account" | "vertex-oauth";

const REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const SUBSCRIPTION_PROVIDER_IDS = new Set([
  "codex-oauth",
  "claude-oauth",
  "github-copilot",
  "grok-subscription",
  "subscription-bridge",
]);
const DEVICE_CODE_PROVIDER_IDS = new Set(["codex-oauth", "grok-subscription", "github-copilot"]);

function deviceClientIdFor(providerOrPresetId: string): string {
  if (providerOrPresetId === "codex-oauth") return "app_EMoamEEZ73f0CkXaXp7hrann";
  if (providerOrPresetId === "grok-subscription") return "b1a00492-073a-47ea-816f-4c329264a828";
  return "Ov23li8tweQw6odWQebz";
}

function deviceButtonLabelFor(providerOrPresetId: string): string {
  if (providerOrPresetId === "codex-oauth") return "Sign in with ChatGPT";
  if (providerOrPresetId === "grok-subscription") return "Sign in with SuperGrok";
  return "Sign in with GitHub Copilot";
}

function formatProviderEndpoint(provider: ProviderView): string {
  if (provider.id === "vertex-ai" || provider.preset === "vertex-ai" || provider.kind === "cloud-iam") {
    return `Vertex AI · ${provider.auth.location || "global"}${provider.auth.projectId ? ` · ${provider.auth.projectId}` : ""}`;
  }
  const labels: Record<string, string> = {
    "codex-oauth": "ChatGPT Backend · OAuth",
    "grok-subscription": "xAI API · OAuth",
    "github-copilot": "GitHub Copilot · OAuth",
    "claude-oauth": "Anthropic Claude · OAuth",
  };
  const label = labels[provider.preset || provider.id] || labels[provider.id];
  if (label) return label;
  try { return new URL(provider.baseUrl).host; } catch { return provider.baseUrl; }
}

function deviceProviderTitleFor(providerOrPresetId: string): string {
  if (providerOrPresetId === "codex-oauth") return "ChatGPT";
  if (providerOrPresetId === "grok-subscription") return "SuperGrok";
  return "GitHub Copilot";
}
const VERTEX_LOCATIONS = [
  "global",
  "us-central1",
  "us-east4",
  "us-east5",
  "us-west1",
  "europe-west1",
  "europe-west4",
  "asia-northeast1",
  "asia-southeast1",
] as const;

const DEFAULT_GOOGLE_OAUTH_CLIENT_ID =
  "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";

const PROMPT_STAGES: Array<{ id: PromptStageId; title: string; subtitle: string }> = [
  { id: "reader", title: "Reader", subtitle: "Panel vision extraction, overlay/world split & box coordinates" },
  { id: "matcher", title: "Visual Matcher", subtitle: "Beat-to-panel visual alignment & contiguous slice rules" },
  { id: "story_writer", title: "Story Writer", subtitle: "Causal backbone retelling & qualitative story contract" },
  { id: "writer", title: "Writer", subtitle: "Chapter story recap narration & expressive delivery" },
  { id: "outro", title: "Episode Outro", subtitle: "Closing episode call-to-action narration & hook" },
];

function stripProviderPrefixUi(modelId: string, providerId?: string): string {
  const raw = String(modelId || "").trim();
  if (!raw) return "";
  const normProvider = (providerId || "").trim().toLowerCase();
  if (normProvider) {
    const colonPrefix = `${normProvider}:`;
    if (raw.toLowerCase().startsWith(colonPrefix)) {
      const stripped = raw.slice(colonPrefix.length).trim();
      if (stripped) return stripProviderPrefixUi(stripped, providerId);
    }
    const slashPrefix = `${normProvider}/`;
    if (raw.toLowerCase().startsWith(slashPrefix)) {
      const stripped = raw.slice(slashPrefix.length).trim();
      if (stripped) return stripProviderPrefixUi(stripped, providerId);
    }
  }
  if ((normProvider === "vertex-ai" || normProvider === "vertex") && raw.toLowerCase().startsWith("google/")) {
    const stripped = raw.slice("google/".length).trim();
    if (stripped) return stripped;
  }
  return raw;
}

function splitStageModelRef(
  lane: string,
  providers: ProviderView[],
): { modelId: string; providerId: string; providerLabel: string } {
  const raw = String(lane || "").trim();
  const colonIdx = raw.indexOf(":");
  if (colonIdx > 0) {
    const candidateProviderId = raw.slice(0, colonIdx).trim();
    const restModelId = raw.slice(colonIdx + 1).trim();
    const matched = providers.find((p) => p.id.toLowerCase() === candidateProviderId.toLowerCase());
    if (matched) {
      return {
        modelId: stripProviderPrefixUi(restModelId, matched.id) || restModelId,
        providerId: matched.id,
        providerLabel: formatProviderConnectionLabel(matched, providers),
      };
    }
    if (
      SUBSCRIPTION_PROVIDER_IDS.has(candidateProviderId) ||
      ["openrouter", "openai", "anthropic", "gemini", "xai", "deepseek", "vertex-ai", "ollama", "lmstudio", "vllm", "groq", "dashscope"].includes(
        candidateProviderId,
      )
    ) {
      return {
        modelId: stripProviderPrefixUi(restModelId, candidateProviderId) || restModelId,
        providerId: candidateProviderId,
        providerLabel: candidateProviderId,
      };
    }
  }
  return {
    modelId: raw,
    providerId: "",
    providerLabel: "",
  };
}

interface StageDraft {
  chain: string[];
  concurrency: number;
  temperature: number;
  llmVerify: boolean;
  inheritFrom: "reader" | null;
}

interface ServiceAccountPreview {
  projectId: string;
  clientEmail: string;
  json: string;
}

const STAGE_META: Array<{ id: UiStage; title: string; purpose: string; gate: "vision" | "text" }> = [
  { id: "reader", title: "Reader", purpose: "Panel vision extraction", gate: "vision" },
  { id: "matcher", title: "Matcher", purpose: "Contact-sheet and semantic matching", gate: "vision" },
  { id: "writer", title: "Writer", purpose: "Recap and story script", gate: "text" },
  { id: "scout", title: "Scout", purpose: "Promo, watermark, and credit detection", gate: "vision" },
  { id: "fact_check", title: "Fact Check", purpose: "Deterministic rules plus optional LLM verify", gate: "text" },
];

const LOCAL_PRESETS = [
  { id: "ollama", label: "Ollama", port: "11434", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", port: "1234", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "vllm", label: "vLLM", port: "8000", baseUrl: "http://127.0.0.1:8000/v1" },
] as const;

function buildLocalPresets(presets: Record<string, ProviderPreset>): Array<{ id: string; label: string; port: string; baseUrl: string }> {
  const byId = new Map<string, { id: string; label: string; port: string; baseUrl: string }>(
    LOCAL_PRESETS.map((item) => [item.id, { ...item }]),
  );
  for (const preset of Object.values(presets)) {
    if (!preset?.id) continue;
    if (preset.category === "local" || preset.kind === "local" || preset.authMode === "none") {
      const portMatch = /:(\d+)/.exec(preset.baseUrl || "");
      byId.set(preset.id, {
        id: preset.id,
        label: preset.label || preset.id,
        port: portMatch?.[1] || "local",
        baseUrl: preset.baseUrl || byId.get(preset.id)?.baseUrl || "http://127.0.0.1:11434/v1",
      });
    }
  }
  return [...byId.values()];
}

function buildSubscriptionSuggestions(
  provider: ProviderView,
  presets: Record<string, ProviderPreset>,
  _isSub: boolean,
): Array<{ id: string; label: string; reasoningEffort: ReasoningEffort; capabilities: ProviderModel["capabilities"] }> {
  const key = provider.preset || provider.id;
  const presetModels = (presets[key]?.defaultModels || presets[provider.id]?.defaultModels || []).map((m) => {
    const cleanId = stripProviderPrefixUi(m.id, provider.id);
    return {
      id: cleanId,
      label: m.label || cleanId,
      reasoningEffort: (m.reasoningEffort || "medium") as ReasoningEffort,
      capabilities: m.capabilities,
    };
  });
  const merged = new Map<string, (typeof presetModels)[number]>();
  for (const item of presetModels) {
    if (item.id && !merged.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

function fmtAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function errText(error: unknown): string {
  return errorLine(error);
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function latencyFill(ms: number | null, ok: boolean | null): { bars: number; tone: "ok" | "warn" | "bad" | "idle" } {
  if (ms == null) return { bars: 0, tone: "idle" };
  if (ok === false || ms > 2500) return { bars: 1, tone: "bad" };
  if (ms >= 800) return { bars: 2, tone: "warn" };
  if (ms < 250) return { bars: 5, tone: "ok" };
  if (ms < 500) return { bars: 4, tone: "ok" };
  return { bars: 3, tone: "ok" };
}

function monogram(label: string): string {
  const parts = label.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  return (parts[0] || "PR").slice(0, 2).toUpperCase();
}

function kindOf(provider: ProviderView): FilterId {
  if (
    provider.kind === "subscription" ||
    provider.auth.mode === "oauth-pkce" ||
    provider.auth.mode === "device-code" ||
    SUBSCRIPTION_PROVIDER_IDS.has(provider.id) ||
    SUBSCRIPTION_PROVIDER_IDS.has(provider.preset || "")
  ) {
    return "subscription";
  }
  if (
    provider.kind === "cloud-iam" ||
    provider.auth.mode === "vertex-service-account" ||
    provider.auth.mode === "vertex-oauth" ||
    provider.protocol === "vertex-openai"
  ) {
    return "cloud-iam";
  }
  if (provider.kind === "local" || provider.auth.mode === "none") return "local";
  return "cloud-api";
}

function draftFrom(route: StageRoute): StageDraft {
  return {
    chain: [...(route.chain?.length ? route.chain : route.primary ? [route.primary, ...route.fallbacks] : [])],
    concurrency: route.concurrency || 1,
    temperature: route.temperature ?? 0.2,
    llmVerify: Boolean(route.llmVerify),
    inheritFrom: route.inheritFrom === "reader" ? "reader" : null,
  };
}

function emptyDraft(stage: UiStage): StageDraft {
  return {
    chain: [],
    concurrency: 1,
    temperature: stage === "writer" ? 0.6 : 0.2,
    llmVerify: false,
    inheritFrom: stage === "matcher" || stage === "scout" ? "reader" : null,
  };
}

async function readServiceAccount(file: File): Promise<ServiceAccountPreview | { error: string }> {
  if (!file.name.toLowerCase().endsWith(".json")) return { error: "File must be a .json service account key." };
  if (file.size > 64 * 1024) return { error: "Service account JSON must be under 64 KB." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return { error: "File is not valid JSON." };
  }
  if (!parsed || typeof parsed !== "object") return { error: "JSON object required." };
  const record = parsed as Record<string, unknown>;
  if (record.type !== "service_account") return { error: 'JSON type must be "service_account".' };
  if (typeof record.project_id !== "string" || !record.project_id) return { error: "Missing project_id." };
  if (typeof record.client_email !== "string" || !record.client_email) return { error: "Missing client_email." };
  if (typeof record.private_key !== "string" || !record.private_key.includes("PRIVATE KEY")) {
    return { error: "Missing private_key." };
  }
  return { projectId: record.project_id, clientEmail: record.client_email, json: JSON.stringify(parsed) };
}

export function StudioSettingsSections() {
  const [sessionState, setSessionState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNoticeMessage] = useState("");
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("info");
  const setNotice = useCallback((message: string, tone: NoticeTone = "info") => {
    setNoticeMessage(message);
    setNoticeTone(tone);
  }, []);
  const [privileged, setPrivileged] = useState(true);
  const [presets, setPresets] = useState<Record<string, ProviderPreset>>({});
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [stages, setStages] = useState<StagesState | null>(null);
  const [nodes, setNodes] = useState<RenderNode[]>([]);
  const [workers, setWorkers] = useState<PipelineWorker[]>([]);
  const [systemSnap, setSystemSnap] = useState<PipelineStatus["system"] | null>(null);
  const [intakeCatalog, setIntakeCatalog] = useState<IntakeCatalog | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [promptsState, setPromptsState] = useState<StudioPromptsState | null>(null);
  const [settingsState, setSettingsState] = useState<StudioSettingsState | null>(null);

  const ttsProviders = useMemo(
    () => buildTtsProviders(intakeCatalog, providers),
    [intakeCatalog, providers],
  );

  const refreshAudit = useCallback(() => {
    if (!privileged) return;
    void api.studio
      .audit()
      .then((res) => setAuditEntries(res.entries || []))
      .catch(() => {});
  }, [privileged]);

  const refreshIntakeCatalog = useCallback(async () => {
    const intake = await api.intake.catalog().catch(() => null);
    if (intake) setIntakeCatalog(intake);
  }, []);

  const refreshWorkers = useCallback(async () => {
    const status = await api.status().catch(() => null);
    if (status) {
      setWorkers(status.workers || []);
      setSystemSnap(status.system || null);
    }
  }, []);

  async function reload() {
    const session = await api.session();
    setPrivileged(session.privileged);
    setSessionState(session);
    const [catalog, intake, auditRes, promptsRes, settingsRes] = await Promise.all([
      api.studio.catalog(),
      api.intake.catalog().catch(() => null),
      session.privileged ? api.studio.audit().catch(() => null) : Promise.resolve(null),
      api.studio.getPrompts().catch(() => null),
      api.studio.getSettings().catch(() => null),
    ]);
    if (session) { setPrivileged(session.privileged); setSessionState(session); }
    setPresets(catalog.presets || {});
    setProviders(catalog.providers || []);
    setStages(catalog.stages);
    setNodes(catalog.nodes || []);
    if (auditRes) setAuditEntries(auditRes.entries || []);
    if (promptsRes || catalog.prompts) setPromptsState(promptsRes || catalog.prompts || null);
    if (settingsRes || catalog.settings) setSettingsState(settingsRes || catalog.settings || null);
    if (intake) setIntakeCatalog(intake);
  }

  useEffect(() => {
    let stop = false;
    reload()
      .catch((err) => {
        if (!stop) setError(errText(err));
      })
      .finally(() => {
        if (!stop) setLoading(false);
      });
    const loadWorkers = () => {
      if (document.hidden) return;
      api.status().then((status) => { if (!stop) { setWorkers(status.workers || []); setSystemSnap(status.system || null); } }).catch(() => {});
    };
    const onReturn = () => {
      if (!document.hidden && !stop) {
        void refreshIntakeCatalog();
        void refreshWorkers();
      }
    };
    loadWorkers();
    const timer = window.setInterval(loadWorkers, 5000);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      stop = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [refreshIntakeCatalog, refreshWorkers]);

  return (
    <div className="settings-sections-root">
      {error ? (
        <Notice
          tone="danger"
          title="Settings didn’t load"
          className="mb-4"
          actions={<NoticeButton onClick={() => {
            setError(""); setLoading(true);
            void reload().catch((err) => setError(errText(err))).finally(() => setLoading(false));
          }}>Retry loading</NoticeButton>}
        >
          {error}
        </Notice>
      ) : null}
      {notice ? <Notice tone={noticeTone} className="mb-4" onDismiss={() => setNotice("")}>{notice}</Notice> : null}
      {!privileged ? (
        <Notice tone="info" className="mb-4">Read only</Notice>
      ) : null}
      {loading ? (
        <div className="studio-loading" role="status"><RotateCcw size={20} aria-hidden /><span>Loading settings…</span></div>
      ) : (
        <>
          <StudioTabs
            tabs={[
              { id: "appearance", label: "Appearance", content: <AppearanceSection /> },
              { id: "account", label: "Account", content: <AccountSection session={sessionState} /> },
              {
                id: "providers",
                label: "Providers",
                content: (
                  <ProvidersTab
                    stages={stages}
                    presets={presets}
                    providers={providers}
                    privileged={privileged}
                    onChange={(next) => {
                      setProviders(next);
                      void refreshIntakeCatalog();
                      refreshAudit();
                    }}
                    onStagesSaved={(next) => {
                      setStages(next);
                      refreshAudit();
                    }}
                    onNotice={setNotice}
                  />
                ),
              },
              {
                id: "routing",
                label: "Stage routing",
                content: (
                  <RoutingTab
                    providers={providers}
                    stages={stages}
                    privileged={privileged}
                    onProvidersChange={(next) => {
                      setProviders(next);
                      void refreshIntakeCatalog();
                      refreshAudit();
                    }}
                    onSaved={(next) => {
                      setStages(next);
                      refreshAudit();
                    }}
                    onReload={async () => {
                      const fresh = await api.studio.stages();
                      setStages(fresh);
                      refreshAudit();
                      return fresh;
                    }}
                    onNotice={setNotice}
                  />
                ),
              },
              {
                id: "nodes",
                label: "Render nodes",
                content: (
                  <NodesTab
                    system={systemSnap}
                    nodes={nodes}
                    workers={workers}
                    privileged={privileged}
                    settings={settingsState}
                    onSettingsSaved={(next) => {
                      setSettingsState(next);
                      void refreshIntakeCatalog();
                      refreshAudit();
                    }}
                    onChange={(next) => {
                      setNodes(next);
                      void refreshIntakeCatalog();
                      refreshAudit();
                    }}
                    onRefreshWorkers={refreshWorkers}
                    onNotice={setNotice}
                  />
                ),
              },
              {
                id: "voice",
                label: "Voice",
                content: (
                  <VoiceTab
                    providers={ttsProviders}
                    privileged={privileged}
                    onRefreshCatalog={refreshIntakeCatalog}
                  />
                ),
              },
              {
                id: "prompts",
                label: "Prompts",
                content: (
                  <PromptsTab
                    promptsState={promptsState}
                    privileged={privileged}
                    onSaved={(next) => {
                      setPromptsState(next);
                      refreshAudit();
                    }}
                    onNotice={setNotice}
                  />
                ),
              },
              { id: "outro", label: "Default outro", content: <DefaultOutroSettings settings={settingsState} privileged={privileged} onSaved={setSettingsState} /> },
              { id: "usage", label: "Usage", content: <MeterPage embedded privileged={privileged} /> },
              { id: "storage", label: "Storage and trash", content: <StorageTrashPanel privileged={privileged} /> },
              { id: "shortcuts", label: "Shortcuts", content: <ShortcutsSection /> },
            ]}
          />
        </>
      )}
    </div>
  );
}

function openAsyncPopup(): Window | null {
  try {
    return window.open("about:blank", "_blank");
  } catch {
    return null;
  }
}

function ConnectedAccountBanner({
  provider,
  projects,
  privileged = true,
  showDisconnected = false,
  onSelectProject,
}: {
  provider: ProviderView;
  projects?: VertexDetectedProject[];
  privileged?: boolean;
  showDisconnected?: boolean;
  onSelectProject?: (projectId: string) => void;
}) {
  if (!provider.auth.hasSecret) {
    if (!showDisconnected) return null;
    return (
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-background px-3 py-2 text-xs text-muted-foreground">
        <span>Not connected</span>
        <span className="font-mono text-[12px]">
          {provider.models.filter((model) => model.enabled !== false).length} models
        </span>
      </div>
    );
  }
  const email = provider.auth.accountEmail?.trim();
  const name = provider.auth.accountName?.trim();
  const primaryIdentity =
    email && name && email !== name
      ? `${email} (${name})`
      : email || name || provider.label;
  const planOrProjectPill =
    provider.auth.accountPlan ||
    (provider.auth.projectId
      ? `Project: ${provider.auth.projectId}`
      : provider.auth.secretHint
        ? `Key ${provider.auth.secretHint}`
        : "Verified");
  const detectedProjects = (projects && projects.length > 0 ? projects : provider.auth.projects) || [];
  return (
    <div className="mt-2.5 flex flex-col gap-2 rounded-2xl bg-info-soft px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-info-soft px-2 py-0.5 font-mono text-[12px] font-semibold text-info">
            <Check className="size-3" aria-hidden /> Connected
          </span>
          <strong className="break-all font-medium text-foreground">{primaryIdentity}</strong>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md border border-info/40 bg-background/60 px-2 py-0.5 font-mono text-[12px] text-info">
            {planOrProjectPill}
          </span>
          {provider.auth.accountPlan && provider.auth.projectId ? (
            <span className="rounded-md border border-info/40 bg-background/60 px-2 py-0.5 font-mono text-[12px] text-info">
              Project: {provider.auth.projectId}
            </span>
          ) : null}
        </div>
      </div>
      {detectedProjects.length > 1 && onSelectProject ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-info/30 pt-2">
          <label htmlFor={`connected-gcp-proj-${provider.id}`} className="font-mono text-[12px] text-muted-foreground">
            GCP Project
          </label>
          <select
            id={`connected-gcp-proj-${provider.id}`}
            className="field min-h-9 w-full flex-1 font-mono text-xs sm:w-auto"
            value={provider.auth.projectId || detectedProjects[0]?.projectId || ""}
            disabled={!privileged}
            onChange={(event) => onSelectProject(event.target.value)}
          >
            {detectedProjects.map((proj) => (
              <option key={proj.projectId} value={proj.projectId}>
                {proj.name ? `${proj.name} (${proj.projectId})` : proj.projectId}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

export function ProvidersTab({
  stages,
  presets,
  providers,
  privileged,
  onChange,
  onStagesSaved,
  onNotice,
}: {
  stages: StagesState | null;
  presets: Record<string, ProviderPreset>;
  providers: ProviderView[];
  privileged: boolean;
  onChange: (providers: ProviderView[]) => void;
  onStagesSaved?: (stages: StagesState) => void;
  onNotice: OnNotice;
}) {
  const [selectedId, setSelectedId] = useState<string>("__new__");
  const [editingConnection, setEditingConnection] = useState(false);
  const [probing, setProbing] = useState("");
  const [syncingAll, setSyncingAll] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const [newModelId, setNewModelId] = useState<Record<string, string>>({});
  const [newModelEffort, setNewModelEffort] = useState<Record<string, ReasoningEffort>>({});
  const [newModelCaps, setNewModelCaps] = useState<Record<string, Record<CapName, boolean>>>({});

  const selectedProvider = useMemo(
    () => (selectedId === "__new__" ? null : providers.find((p) => p.id === selectedId) ?? null),
    [providers, selectedId],
  );

  useEffect(() => {
    if (selectedId !== "__new__" && !providers.some((p) => p.id === selectedId)) {
      setSelectedId(providers[0]?.id ?? "__new__");
      setEditingConnection(false);
    }
  }, [providers, selectedId]);

  async function test(id: string) {
    setProbing(id);
    try {
      const result = await api.studio.testProvider(id);
      const fresh = await api.studio.providers();
      onChange(fresh.providers);
      onNotice(result.ok ? `${id} answered in ${formatLatency(result.latencyMs)}` : result.error || "Probe failed", result.ok ? "info" : "danger");
    } catch (error) {
      onNotice(errText(error), "danger");
    } finally {
      setProbing("");
    }
  }

  async function discover(id: string) {
    setProbing(id);
    try {
      const result = await api.studio.discoverModels(id, true);
      const fresh = await api.studio.providers();
      onChange(fresh.providers);
      onNotice(`Synced ${result.models.length} models from /models for ${id}`);
    } catch (error) {
      onNotice(errText(error), "danger");
    } finally {
      setProbing("");
    }
  }

  async function syncAllModels() {
    if (!privileged || syncingAll) return;
    const enabledProviders = providers.filter((p) => p.enabled !== false);
    if (enabledProviders.length === 0) {
      onNotice("No enabled providers to sync.");
      return;
    }
    setSyncingAll(true);
    try {
      let totalModels = 0;
      let syncedProviders = 0;
      for (const p of enabledProviders) {
        try {
          const res = await api.studio.discoverModels(p.id, true);
          totalModels += res.models.length;
          syncedProviders += 1;
        } catch {
          /* continue syncing remaining providers */
        }
      }
      const fresh = await api.studio.providers();
      onChange(fresh.providers);
      onNotice(`Synced ${totalModels} models from /models across ${syncedProviders}/${enabledProviders.length} providers.`);
    } catch (error) {
      onNotice(errText(error), "danger");
    } finally {
      setSyncingAll(false);
    }
  }

  async function updateReasoningEffort(provider: ProviderView, modelId: string, effort: ReasoningEffort) {
    const models = provider.models.map((model) =>
      model.id === modelId
        ? {
            ...model,
            reasoningEffort: effort,
            capabilities: { ...model.capabilities, reasoning: true },
          }
        : model,
    );
    const result = await api.studio.updateProvider(provider.id, { models });
    onChange(result.providers);
    onNotice(`Updated reasoning effort (${effort}) for ${modelId}`);
  }

  async function updateModelTuning(
    provider: ProviderView,
    modelId: string,
    patch: { thinking?: boolean | null; maxOutputTokens?: number | null },
  ) {
    const models = provider.models.map((model) => {
      if (model.id !== modelId) return model;
      const next: ProviderModel = { ...model };
      if ("thinking" in patch) next.thinking = patch.thinking ?? null;
      if ("maxOutputTokens" in patch) {
        if (patch.maxOutputTokens == null) delete next.maxOutputTokens;
        else next.maxOutputTokens = patch.maxOutputTokens;
      }
      return next;
    });
    const result = await api.studio.updateProvider(provider.id, { models });
    onChange(result.providers);
    const what = "thinking" in patch
      ? `thinking ${patch.thinking === false ? "off" : "on"}`
      : `max output ${patch.maxOutputTokens ?? "uncapped"}`;
    onNotice(`Updated ${what} for ${modelId}`);
  }

  async function addProviderModel(
    provider: ProviderView,
    entry: {
      id: string;
      label?: string;
      reasoningEffort?: ReasoningEffort;
      capabilities?: Partial<ProviderModel["capabilities"]>;
    },
  ) {
    const trimmed = stripProviderPrefixUi(entry.id, provider.id);
    if (!trimmed) return;
    if (provider.models.some((m) => stripProviderPrefixUi(m.id, provider.id) === trimmed || m.id === trimmed)) {
      onNotice(`Model ${trimmed} is already in ${provider.label}`);
      return;
    }
    const caps: ProviderModel["capabilities"] = {
      vision: entry.capabilities?.vision ?? true,
      writer: entry.capabilities?.writer ?? true,
      json: entry.capabilities?.json ?? true,
      reasoning: entry.capabilities?.reasoning ?? Boolean(entry.reasoningEffort),
      streaming: entry.capabilities?.streaming ?? true,
      tts: entry.capabilities?.tts ?? false,
      image: entry.capabilities?.image ?? false,
    };
    const roles: Array<"vision" | "writer" | "reasoning" | "tts" | "image"> = [];
    if (caps.vision) roles.push("vision");
    if (caps.writer) roles.push("writer");
    if (caps.reasoning) roles.push("reasoning");
    if (caps.tts) roles.push("tts");
    if (caps.image) roles.push("image");
    const nextModel: ProviderModel = {
      id: trimmed,
      label: entry.label || trimmed,
      enabled: true,
      roles: roles.length ? roles : ["writer"],
      capabilities: caps,
      reasoningEffort: entry.reasoningEffort ?? "medium",
    };
    const result = await api.studio.updateProvider(provider.id, {
      models: [...provider.models, nextModel],
    });
    onChange(result.providers);
    setNewModelId((current) => ({ ...current, [provider.id]: "" }));
    onNotice(`Added ${trimmed} to ${provider.label}`);
  }

  async function activateModelForStages(provider: ProviderView, modelId: string) {
    if (!privileged) return;
    try {
      const current = await api.studio.stages();
      const cleanModelId = stripProviderPrefixUi(modelId, provider.id);
      const model = provider.models.find((item) => stripProviderPrefixUi(item.id, provider.id) === cleanModelId);
      const laneId = `${provider.id}:${cleanModelId}`;
      const routes: Record<string, Partial<StageRoute>> = {};
      for (const stage of ["reader", "matcher", "scout", "writer", "fact_check"] as StageId[]) {
        if (!(stage === "writer" || stage === "fact_check" ? model?.capabilities?.writer : model?.capabilities?.vision)) continue;
        const chain = [laneId, ...current[stage].chain.filter((item) => item !== laneId)];
        routes[stage] = { ...current[stage], primary: laneId, chain, fallbacks: chain.slice(1) };
      }
      const savedStages = await api.studio.putStages({ revision: current.revision, stages: routes });
      onStagesSaved?.(savedStages);
      onNotice(`Active model set to ${cleanModelId}`);
    } catch (error) {
      onNotice(errText(error), "danger");
    }
  }

  async function removeProviderModel(provider: ProviderView, modelId: string) {
    const models = provider.models.filter((m) => m.id !== modelId);
    const removedLane = `${provider.id}:${stripProviderPrefixUi(modelId, provider.id)}`;
    const current = await api.studio.stages();
    const routes: Record<string, Partial<StageRoute>> = {};
    for (const stage of ["reader", "matcher", "scout", "writer", "fact_check"] as StageId[]) {
      const route = current[stage];
      if (route.primary !== removedLane && !route.chain.includes(removedLane) && !route.fallbacks.includes(removedLane)) continue;
      const replacement = models.find((model) => stage === "writer" || stage === "fact_check" ? model.capabilities?.writer : model.capabilities?.vision);
      const chain = route.chain.filter((lane) => lane !== removedLane);
      if (replacement && (route.primary === removedLane || route.chain[0] === removedLane)) {
        const lane = `${provider.id}:${stripProviderPrefixUi(replacement.id, provider.id)}`;
        const index = chain.indexOf(lane);
        if (index !== -1) chain.splice(index, 1);
        chain.unshift(lane);
      }
      routes[stage] = { ...route, primary: chain[0] || null, chain, fallbacks: chain.slice(1) };
    }
    if (Object.keys(routes).length) {
      const saved = await api.studio.putStages({ revision: current.revision, stages: routes });
      onStagesSaved?.(saved);
    }
    const result = await api.studio.updateProvider(provider.id, { models });
    onChange(result.providers);
    onNotice(`Removed ${modelId} from ${provider.label}`);
  }

  function draftCapsFor(providerId: string): Record<CapName, boolean> {
    return (
      newModelCaps[providerId] || {
        vision: true,
        writer: true,
        reasoning: true,
        tts: false,
        image: false,
        json: true,
        streaming: true,
      }
    );
  }

  const isSetupView = selectedId === "__new__" || editingConnection || !selectedProvider;

  return (
    <div className="studio-split">
      <aside className="studio-split-left" aria-label="Connections">
        <div className="studio-split-left-head">
          <span>Connections <span className="font-normal text-caption tabular-nums">{providers.length}</span></span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[12px] font-medium tracking-normal normal-case text-muted-foreground hover:text-foreground"
            disabled={!privileged || syncingAll || providers.length === 0}
            title="Sync models across all providers"
            onClick={() => void syncAllModels()}
          >
            <RotateCcw className={cn("size-3", syncingAll && "animate-spin")} aria-hidden />
            <span>{syncingAll ? "Syncing…" : "Sync"}</span>
          </button>
        </div>

        <div className="studio-conn-list" role="group" aria-label="Connections">
          {providers.map((provider) => {
            const isSelected = selectedId === provider.id;
            const isConnected = Boolean(
              provider.lastTest?.ok || provider.auth.hasSecret || provider.auth.mode === "none",
            );
            return (
              <button
                key={provider.id}
                type="button"
                aria-pressed={isSelected}
                className={cn("studio-conn-row", isSelected && "is-active")}
                onClick={() => {
                  setSelectedId(provider.id);
                  setEditingConnection(false);
                }}
              >
                <span className="studio-conn-mark" aria-hidden>
                  {monogram(provider.label)}
                </span>
                <span className="studio-conn-body">
                  <span className="studio-conn-title" title={`${provider.label} (${provider.id})`}>
                    {provider.label.replace(/\s*\(.*?\)\s*/g, "").trim() || provider.id}
                  </span>
                  <span className="studio-conn-sub">
                    {provider.models.length} {provider.models.length === 1 ? "model" : "models"} · {provider.id}
                  </span>
                </span>
                <span className="studio-conn-status">
                  <span className={cn("studio-status-dot", isConnected && "is-online")} aria-hidden />
                  <span>{isConnected ? "Connected" : "Offline"}</span>
                  <span className="studio-conn-chevron" aria-hidden>
                    ›
                  </span>
                </span>
              </button>
            );
          })}

          <button
            type="button"
            aria-pressed={selectedId === "__new__"}
            disabled={!privileged}
            className={cn("studio-conn-row", selectedId === "__new__" && "is-active")}
            onClick={() => {
              setSelectedId("__new__");
              setEditingConnection(false);
            }}
          >
            <span className="studio-conn-mark" aria-hidden>
              +
            </span>
            <span className="studio-conn-body">
              <span className="studio-conn-title">New connection</span>
            </span>
            <span className="studio-conn-status">
              <span className="studio-conn-chevron" aria-hidden>
                ›
              </span>
            </span>
          </button>
        </div>

        <button
          type="button"
          className="studio-add-link"
          disabled={!privileged}
          onClick={() => {
            setSelectedId("__new__");
            setEditingConnection(false);
          }}
        >
          <span>+</span>
          <span>Add connection</span>
        </button>
      </aside>

      <div className="studio-split-right">
        {isSetupView ? (
          <ProviderSetupPane
            editing={selectedId === "__new__" ? null : selectedProvider}
            providers={providers}
            presets={presets}
            privileged={privileged}
            onCancel={() => {
              if (editingConnection && selectedProvider) {
                setEditingConnection(false);
              } else if (providers[0]) {
                setSelectedId(providers[0].id);
                setEditingConnection(false);
              }
            }}
            onSaved={(nextProviders, savedProviderId) => {
              onChange(nextProviders);
              if (savedProviderId) {
                setSelectedId(savedProviderId);
                setEditingConnection(false);
              }
            }}
            onStagesSaved={onStagesSaved}
            onNotice={onNotice}
          />
        ) : (
          (() => {
            const provider = selectedProvider;
            const meter = latencyFill(
              provider.lastTest?.latencyMs ?? null,
              provider.lastTest ? provider.lastTest.ok : null,
            );
            const isExpanded = Boolean(expandedModels[provider.id]);
            const visibleModels = isExpanded ? provider.models : provider.models.slice(0, 8);
            const isSub =
              kindOf(provider) === "subscription" ||
              presets[provider.preset || provider.id]?.category === "subscription" ||
              SUBSCRIPTION_PROVIDER_IDS.has(provider.id) ||
              SUBSCRIPTION_PROVIDER_IDS.has(provider.preset || "");
            const subSuggestions = buildSubscriptionSuggestions(provider, presets, isSub);
            const draftCaps = draftCapsFor(provider.id);
            const draftEffort = newModelEffort[provider.id] || "medium";
            const needsInitialAuth = !provider.auth.hasSecret && provider.auth.mode !== "none";

            return (
              <>
                <div className="flex flex-col gap-5">
                  <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
                    <div className="studio-pane-heading min-w-0">
                      <h2>{provider.label}</h2>
                      <p className="font-mono text-xs">
                        {formatProviderEndpoint(provider)} · <span className="opacity-75">{provider.id}</span>
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        className={cn("probe mr-2 text-xs", `is-${meter.tone}`)}
                        title={provider.lastTest ? `HTTP ${provider.lastTest.status}` : "Not tested"}
                      >
                        <span className={cn("bars", probing === provider.id && "is-live")} aria-hidden>
                          {[0, 1, 2, 3, 4].map((bar) => (
                            <i key={bar} className={bar < meter.bars ? "on" : ""} />
                          ))}
                        </span>
                        <span className="font-mono text-xs">
                          {probing === provider.id
                            ? "Checking…"
                            : provider.lastTest
                              ? `${provider.lastTest.ok ? "Connected" : "Failed"} · ${formatLatency(provider.lastTest.latencyMs)}`
                              : provider.auth.hasSecret || provider.auth.mode === "none"
                                ? "Connected"
                                : "Offline"}
                        </span>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!privileged || probing === provider.id}
                        onClick={() => void test(provider.id)}
                      >
                        Test
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!privileged || probing === provider.id}
                        onClick={() => void discover(provider.id)}
                      >
                        <RotateCcw className={cn("size-3.5", probing === provider.id && "animate-spin")} /> Sync
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={!privileged}
                        onClick={() => setEditingConnection(true)}
                      >
                        Configure
                      </Button>
                      <InlineConfirm
                        label="Remove"
                        subject={provider.label}
                        description="Remove provider?"
                        disabled={!privileged}
                        onConfirm={async () => {
                          try {
                            const result = await api.studio.deleteProvider(provider.id);
                            onChange(result.providers);
                            setSelectedId(result.providers[0]?.id ?? "__new__");
                            onNotice(`${provider.label} removed`);
                          } catch (error) {
                            onNotice(errText(error), "danger");
                          }
                        }}
                      />
                    </div>
                  </div>

                  <ConnectedAccountBanner
                    provider={provider}
                    projects={provider.auth.projects}
                    privileged={privileged}
                    onSelectProject={(nextProject) => {
                      void api.studio
                        .updateProvider(provider.id, {
                          auth: {
                            mode: provider.auth.mode || "vertex-oauth",
                            clientId: provider.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
                            projectId: nextProject || undefined,
                            location: provider.auth.location || "global",
                          },
                        })
                        .then((res) => {
                          const preserved = provider.auth.projects;
                          const nextProviders = preserved?.length
                            ? res.providers.map((p) =>
                                p.id === provider.id && !p.auth.projects?.length
                                  ? { ...p, auth: { ...p.auth, projects: preserved } }
                                  : p,
                              )
                            : res.providers;
                          onChange(nextProviders);
                          onNotice(`Switched Vertex project to ${nextProject}`);
                        })
                        .catch((err) => onNotice(errText(err), "danger"));
                    }}
                  />

                  {needsInitialAuth ? (
                    <div className="desk-card">
                      <p className="mb-2 text-[13px] font-semibold text-muted-foreground">
                        Authenticate connection
                      </p>
                      <AuthFlow provider={provider} privileged={privileged} onChange={onChange} onNotice={onNotice} />
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[13px] font-semibold text-muted-foreground">
                        Models ({provider.models.length})
                      </span>
                      {provider.models.length > 8 ? (
                        <button
                          type="button"
                          className="text-xs font-medium text-primary-text hover:underline"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpandedModels((current) => ({ ...current, [provider.id]: !current[provider.id] }))
                          }
                        >
                          {isExpanded ? "Show fewer" : `Show all ${provider.models.length}`}
                        </button>
                      ) : null}
                    </div>

                    <ul className="studio-model-table" aria-label={`Models in ${provider.label}`}>
                      {visibleModels.map((model) => {
                        const cleanModelId = stripProviderPrefixUi(model.id, provider.id);
                        const laneId = `${provider.id}:${cleanModelId}`;
                        const wantsVision = Boolean(model.capabilities?.vision);
                        const wantsWriter = Boolean(model.capabilities?.writer);
                        const isReaderActive =
                          stages?.reader?.primary === laneId || stages?.reader?.chain?.[0] === laneId;
                        const isWriterActive =
                          stages?.writer?.primary === laneId || stages?.writer?.chain?.[0] === laneId;
                        const isFullyActive =
                          (wantsVision || wantsWriter) &&
                          (!wantsVision || isReaderActive) &&
                          (!wantsWriter || isWriterActive);
                        const isPartiallyActive =
                          !isFullyActive && ((wantsVision && isReaderActive) || (wantsWriter && isWriterActive));
                        const capTags = (["vision", "writer", "reasoning", "tts"] as const).filter(
                          (cap) => model.capabilities?.[cap],
                        );
                        return (
                          <li key={model.id} className="studio-model-row">
                            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                              <strong className="font-mono text-xs font-semibold text-foreground">{cleanModelId}</strong>
                              {model.contextWindow ? (
                                <span className="cap font-mono">{Math.round(model.contextWindow / 1000)}k</span>
                              ) : null}
                              {capTags.map((cap) => (
                                <span key={cap} className="cap font-mono">
                                  {cap}
                                </span>
                              ))}
                            </div>
                            <div className="flex items-center gap-1.5">
                              {isFullyActive ? <span className="cap is-on">Active</span> : null}
                              {isPartiallyActive ? (
                                <span className="cap is-on">{isReaderActive ? "Vision" : "Writer"}</span>
                              ) : null}
                              {!isFullyActive && (wantsVision || wantsWriter) ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="min-h-7 px-2.5 text-xs"
                                  disabled={!privileged}
                                  onClick={() => void activateModelForStages(provider, cleanModelId)}
                                >
                                  Use
                                </Button>
                              ) : null}
                              {model.capabilities?.reasoning ? (
                                <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                  <input
                                    type="checkbox"
                                    className="size-3.5"
                                    aria-label={`Thinking for ${cleanModelId}`}
                                    checked={model.thinking !== false}
                                    disabled={!privileged}
                                    onChange={(event) =>
                                      void updateModelTuning(provider, model.id, {
                                        thinking: event.target.checked ? null : false,
                                      }).catch((error) => onNotice(errText(error), "danger"))
                                    }
                                  />
                                  think
                                </label>
                              ) : null}
                              {model.capabilities?.reasoning ? (
                                <select
                                  className="field min-h-7 w-auto px-2 py-0.5 font-mono text-xs"
                                  aria-label={`Reasoning effort for ${cleanModelId}`}
                                  value={model.reasoningEffort || "medium"}
                                  disabled={!privileged || model.thinking === false}
                                  title={model.thinking === false ? "Thinking is off for this model" : undefined}
                                  onChange={(event) =>
                                    void updateReasoningEffort(
                                      provider,
                                      model.id,
                                      event.target.value as ReasoningEffort,
                                    ).catch((error) => onNotice(errText(error), "danger"))
                                  }
                                >
                                  {REASONING_EFFORTS.map((effort) => (
                                    <option key={effort} value={effort}>
                                      {effort}
                                    </option>
                                  ))}
                                </select>
                              ) : null}
                              <input
                                type="number"
                                inputMode="numeric"
                                min={256}
                                step={1024}
                                className="field min-h-7 w-24 px-2 py-0.5 font-mono text-xs"
                                aria-label={`Max output tokens for ${cleanModelId}`}
                                title="Provider output cap (blank = no cap). Requests never exceed it."
                                placeholder="max out"
                                defaultValue={model.maxOutputTokens ?? ""}
                                disabled={!privileged}
                                onBlur={(event) => {
                                  const raw = event.target.value.trim();
                                  const next = raw === "" ? null : Number(raw);
                                  if ((next ?? undefined) === model.maxOutputTokens) return;
                                  void updateModelTuning(provider, model.id, { maxOutputTokens: next }).catch(
                                    (error) => onNotice(errText(error), "danger"),
                                  );
                                }}
                              />
                              {provider.models.length > 1 ? (
                                <button
                                  type="button"
                                  className="inline-flex min-h-7 min-w-7 items-center justify-center rounded text-xs text-muted-foreground hover:text-destructive"
                                  aria-label={`Remove model ${cleanModelId}`}
                                  disabled={!privileged}
                                  onClick={() =>
                                    void removeProviderModel(provider, model.id).catch((error) =>
                                      onNotice(errText(error), "danger"),
                                    )
                                  }
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <div className="mt-3 rounded-md border border-border bg-card p-3">
                      {subSuggestions.length > 0 ? (
                        <div className="mb-2.5 flex flex-wrap gap-1">
                          {subSuggestions.map((tpl) => {
                            const cleanTplId = stripProviderPrefixUi(tpl.id, provider.id);
                            const exists = provider.models.some(
                              (m) => stripProviderPrefixUi(m.id, provider.id) === cleanTplId || m.id === tpl.id,
                            );
                            return (
                              <button
                                key={tpl.id}
                                type="button"
                                className={cn("cap", exists && "is-on")}
                                disabled={!privileged || exists}
                                onClick={() =>
                                  void addProviderModel(provider, { ...tpl, id: cleanTplId }).catch((error) =>
                                    onNotice(errText(error), "danger"),
                                  )
                                }
                              >
                                <Plus className="size-3" /> {cleanTplId} ({tpl.reasoningEffort})
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className="field min-w-[180px] flex-1 font-mono text-xs"
                          aria-label={`New model ID for ${provider.label}`}
                          placeholder="Add model ID (e.g. anthropic/claude-sonnet-4)"
                          value={newModelId[provider.id] || ""}
                          disabled={!privileged}
                          onChange={(event) =>
                            setNewModelId((current) => ({ ...current, [provider.id]: event.target.value }))
                          }
                        />
                        <select
                          className="field w-auto font-mono text-xs"
                          aria-label={`Reasoning effort for new model in ${provider.label}`}
                          value={draftEffort}
                          disabled={!privileged}
                          onChange={(event) =>
                            setNewModelEffort((current) => ({
                              ...current,
                              [provider.id]: event.target.value as ReasoningEffort,
                            }))
                          }
                        >
                          {REASONING_EFFORTS.map((effort) => (
                            <option key={effort} value={effort}>
                              effort: {effort}
                            </option>
                          ))}
                        </select>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!privileged || !(newModelId[provider.id] || "").trim()}
                          onClick={() =>
                            void addProviderModel(provider, {
                              id: newModelId[provider.id] || "",
                              reasoningEffort: draftEffort,
                              capabilities: draftCaps,
                            }).catch((error) => onNotice(errText(error), "danger"))
                          }
                        >
                          <Plus className="size-3.5" /> Add model
                        </Button>
                      </div>
                      <div
                        className="mt-2 flex flex-wrap gap-1"
                        role="group"
                        aria-label={`New model capabilities for ${provider.label}`}
                      >
                        {(["vision", "writer", "reasoning", "tts", "image"] as const).map((cap) => (
                          <button
                            key={cap}
                            type="button"
                            className={cn("cap", draftCaps[cap] && "is-on")}
                            aria-pressed={Boolean(draftCaps[cap])}
                            disabled={!privileged}
                            onClick={() =>
                              setNewModelCaps((current) => ({
                                ...current,
                                [provider.id]: { ...draftCaps, [cap]: !draftCaps[cap] },
                              }))
                            }
                          >
                            {cap}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {!needsInitialAuth ? (
                    <details className="studio-accordion">
                      <summary>
                        <span>Credentials &amp; re-authentication</span>
                        <span className="studio-accordion-icon" aria-hidden />
                      </summary>
                      <div className="studio-accordion-body">
                        <AuthFlow provider={provider} privileged={privileged} onChange={onChange} onNotice={onNotice} />
                      </div>
                    </details>
                  ) : null}
                </div>

                <div className="studio-pane-footer">
                  <span>{provider.label}</span>
                  <span>{provider.models.length} models configured</span>
                </div>
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}

function AuthFlow({
  provider,
  privileged,
  onChange,
  onNotice,
}: {
  provider: ProviderView;
  privileged: boolean;
  onChange: (providers: ProviderView[]) => void;
  onNotice: OnNotice;
}) {
  const mode = provider.auth.mode;
  const isVertex =
    mode === "vertex-service-account" ||
    mode === "vertex-oauth" ||
    provider.id === "vertex-ai" ||
    provider.preset === "vertex-ai" ||
    provider.protocol === "vertex-openai" ||
    provider.kind === "cloud-iam";
  const [reauthOpen, setReauthOpen] = useState(false);
  const [vertexMode, setVertexMode] = useState<VertexAuthMode>(
    mode === "vertex-service-account" ? "vertex-service-account" : "vertex-oauth",
  );
  const [vertexProjectId, setVertexProjectId] = useState(provider.auth.projectId || "");
  const [vertexProjects, setVertexProjects] = useState<VertexDetectedProject[]>(provider.auth.projects || []);
  const [vertexLocation, setVertexLocation] = useState(provider.auth.location || "global");
  const [vertexClientId, setVertexClientId] = useState(provider.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID);
  const [vertexOauthToken, setVertexOauthToken] = useState("");
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [verifier, setVerifier] = useState("");
  const [callback, setCallback] = useState("");
  const [userCode, setUserCode] = useState("");
  const [verifyUrl, setVerifyUrl] = useState("");
  const [waited, setWaited] = useState(0);
  const [pending, setPending] = useState(false);
  const [tokenPaste, setTokenPaste] = useState("");
  const [saError, setSaError] = useState("");
  const [sa, setSa] = useState<ServiceAccountPreview | null>(null);
  const pollInFlightRef = useRef(false);
  const pollIntervalMsRef = useRef(5000);

  useEffect(() => {
    setVertexProjectId(provider.auth.projectId || "");
    if (provider.auth.projects?.length) {
      setVertexProjects(provider.auth.projects);
    }
    setVertexLocation(provider.auth.location || "global");
    setVertexClientId(provider.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID);
    if (provider.auth.mode === "vertex-oauth" || provider.auth.mode === "vertex-service-account") {
      setVertexMode(provider.auth.mode);
    }
  }, [provider.auth.mode, provider.auth.projectId, provider.auth.projects, provider.auth.location, provider.auth.clientId]);

  const onSaved = useCallback(() => {
    void (async () => {
      try {
        await api.studio.discoverModels(provider.id, true).catch(() => null);
        const fresh = await api.studio.providers();
        onChange(fresh.providers);
        setReauthOpen(false);
        onNotice("Device authorized · Synced /models catalog");
      } catch (error) {
        onNotice(errText(error), "danger");
      }
    })();
  }, [provider.id, onChange, onNotice]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer = 0;
    const started = performance.now();
    const tick = () => {
      if (cancelled) return;
      setWaited((performance.now() - started) / 1000);
      if (pollInFlightRef.current) {
        timer = window.setTimeout(tick, pollIntervalMsRef.current);
        return;
      }
      pollInFlightRef.current = true;
      void api.studio
        .devicePoll({ providerId: provider.id, preset: provider.preset || provider.id })
        .then((res) => {
          const pollHint = res as { interval?: number; slowDown?: boolean };
          if (typeof pollHint.interval === "number" && pollHint.interval > 0) {
            const nextMs = pollHint.interval >= 1000 ? pollHint.interval : pollHint.interval * 1000;
            pollIntervalMsRef.current = Math.max(pollIntervalMsRef.current, nextMs);
          } else if (pollHint.slowDown) {
            pollIntervalMsRef.current += 5000;
          }
          if (res.status === "authorized") {
            setPending(false);
            onSaved();
            return;
          }
          if (!cancelled) {
            timer = window.setTimeout(tick, pollIntervalMsRef.current);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setPending(false);
            onNotice(errText(error), "danger");
          }
        })
        .finally(() => {
          pollInFlightRef.current = false;
        });
    };
    timer = window.setTimeout(tick, pollIntervalMsRef.current);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pending, provider.id, onSaved, onNotice]);

  if (provider.auth.hasSecret && !reauthOpen) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged}
            onClick={() => setReauthOpen(true)}
          >
            Re-authenticate
          </Button>
          <InlineConfirm
            label="Revoke"
            subject={provider.label}
            description="Revoke stored credential?"
            disabled={!privileged}
            onConfirm={async () => {
              try {
                await api.studio.revokeSecret(provider.id);
                const fresh = await api.studio.providers();
                onChange(fresh.providers);
                onNotice("Key revoked");
              } catch (error) {
                onNotice(errText(error), "danger");
              }
            }}
          />
        </div>
      </div>
    );
  }

  const effectiveSubKey = provider.preset || provider.id;
  const isDeviceSub =
    mode === "device-code" ||
    DEVICE_CODE_PROVIDER_IDS.has(provider.id) ||
    DEVICE_CODE_PROVIDER_IDS.has(effectiveSubKey);
  const isClaudeSub =
    !isDeviceSub &&
    (mode === "oauth-pkce" || provider.id === "claude-oauth" || effectiveSubKey === "claude-oauth");

  if (!isVertex && !isDeviceSub && !isClaudeSub && (mode === "bearer" || mode === "none")) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <label htmlFor={`provider-key-${provider.id}`}>
            {provider.auth.hasSecret ? `Replace key · hint ${provider.auth.secretHint || "saved"}` : "API key"}
          </label>
          <PasswordInput id={`provider-key-${provider.id}`} value={key} onValueChange={setKey} disabled={!privileged}>
            <PasswordInputField
              className="min-h-11 font-mono [&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
              autoComplete="off"
              spellCheck={false}
              placeholder="Write-only. Never echoed back."
              toggleLabel={{ show: "Show API key", hide: "Hide API key" }}
            />
          </PasswordInput>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged || !key.trim()}
            onClick={() => {
              const secret = key.trim();
              setKey("");
              void api.studio
                .updateProvider(provider.id, { apiKey: secret })
                .then(async (result) => {
                  const disc = await api.studio.discoverModels(provider.id, true).catch(() => null);
                  const fresh = await api.studio.providers().catch(() => null);
                  onChange(fresh?.providers || result.providers);
                  setReauthOpen(false);
                  onNotice(
                    disc?.models?.length
                      ? `Key stored & synced ${disc.models.length} models from /models.`
                      : "Key stored. The field was cleared.",
                  );
                })
                .catch((error) => onNotice(errText(error), "danger"));
            }}
          >
            Save key
          </Button>
          {provider.auth.hasSecret ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="min-h-11 w-full sm:w-auto md:min-h-8"
                onClick={() => setReauthOpen(false)}
              >
                Cancel
              </Button>
              <InlineConfirm
                label="Revoke"
                subject={provider.label}
                description="Revoke stored credential?"
                disabled={!privileged}
                onConfirm={async () => {
                  try {
                    await api.studio.revokeSecret(provider.id);
                    const fresh = await api.studio.providers();
                    onChange(fresh.providers);
                    setReauthOpen(false);
                    onNotice("Key revoked");
                  } catch (error) {
                    onNotice(errText(error), "danger");
                  }
                }}
              />
            </>
          ) : null}
        </div>
      </div>
    );
  }

  if (!isVertex && isClaudeSub) {
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-xl bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-muted-foreground">OAuth PKCE · {provider.label}</p>
          {provider.auth.hasSecret ? (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setReauthOpen(false)}>
              Cancel
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="cap is-on">Step 1</span>
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged}
            onClick={() => {
              const popup = openAsyncPopup();
              void api.studio.pkceStart({ providerId: provider.id, preset: provider.preset || provider.id }).then((start) => {
                setVerifier(start.codeVerifier);
                setLoginUrl(start.authorizeUrl || "");
                if (start.authorizeUrl) {
                  if (popup && !popup.closed) popup.location.href = start.authorizeUrl;
                  else window.open(start.authorizeUrl, "_blank", "noopener,noreferrer");
                } else {
                  popup?.close();
                }
              }).catch((error) => {
                popup?.close();
                onNotice(errText(error), "danger");
              });
            }}
          >
            Open Claude Sign-In
          </Button>
          {loginUrl ? (
            <>
              <a
                href={loginUrl}
                target="_blank"
                rel="noreferrer"
                className="btn inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-card px-3 text-xs text-info hover:border-primary sm:w-auto md:min-h-8"
              >
                Open sign-in link
              </a>
              <CopyButton value={loginUrl} label="Copy link" />
            </>
          ) : null}
        </div>
        {loginUrl ? <p className="break-all font-mono text-[12px] text-info">{loginUrl}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="cap">Step 2</span>
          <input
            className="field min-h-11 flex-1 font-mono"
            aria-label="Claude authorization code or setup token"
            value={callback}
            autoComplete="off"
            spellCheck={false}
            placeholder="code#state or sk-ant-oat01-..."
            onChange={(event) => setCallback(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged || !callback.trim() || (!verifier && !callback.trim().startsWith("sk-ant-"))}
            onClick={() => {
              const pasted = callback.trim();
              setCallback("");
              void api.studio.pkceExchange({ providerId: provider.id, codeOrUrl: pasted, codeVerifier: verifier || undefined }).then(async () => {
                setVerifier("");
                const disc = await api.studio.discoverModels(provider.id, true).catch(() => null);
                const fresh = await api.studio.providers();
                onChange(fresh.providers);
                setReauthOpen(false);
                onNotice(
                  disc?.models?.length
                    ? `Subscription token stored & synced ${disc.models.length} models from /models.`
                    : "Subscription token stored",
                );
              }).catch((error) => onNotice(errText(error), "danger"));
            }}
          >
            Connect
          </Button>
        </div>
      </div>
    );
  }

  if (!isVertex && isDeviceSub) {
    const subKey = DEVICE_CODE_PROVIDER_IDS.has(effectiveSubKey) ? effectiveSubKey : provider.id;
    const deviceClientId = deviceClientIdFor(subKey);
    return (
      <div className="mt-3 flex flex-col gap-2 rounded-xl bg-background p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-medium text-muted-foreground">Device code · {provider.label}</p>
          {provider.auth.hasSecret ? (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setReauthOpen(false)}>
              Cancel
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="cap is-on">Step 1</span>
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged}
            onClick={() => {
              const popup = openAsyncPopup();
              void api.studio.deviceStart(provider.id, { clientId: deviceClientId, preset: subKey }).then((start) => {
                const targetUri = start.verificationUriComplete || start.verificationUri;
                pollIntervalMsRef.current = Math.max(5, Number(start.interval) || 5) * 1000;
                setUserCode(start.userCode);
                setVerifyUrl(targetUri);
                setPending(true);
                setWaited(0);
                if (targetUri) {
                  if (popup && !popup.closed) popup.location.href = targetUri;
                  else window.open(targetUri, "_blank", "noopener,noreferrer");
                } else {
                  popup?.close();
                }
              }).catch((error) => {
                popup?.close();
                onNotice(errText(error), "danger");
              });
            }}
          >
            {deviceButtonLabelFor(subKey)}
          </Button>
          {verifyUrl ? (
            <a
              href={verifyUrl}
              target="_blank"
              rel="noreferrer"
              className="btn inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-card px-3 break-all text-xs text-info hover:border-primary sm:w-auto md:min-h-8"
            >
              Open verification
            </a>
          ) : null}
        </div>
        {userCode ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-card px-3 py-2">
            <span className="font-mono text-2xl tracking-[0.2em] text-foreground">{userCode}</span>
            <CopyButton value={userCode} label="Copy code" />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <span className="cap">Step 2</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged || (!tokenPaste.trim() && !userCode)}
            onClick={() => {
              if (pollInFlightRef.current) return;
              const token = tokenPaste.trim();
              setTokenPaste("");
              pollInFlightRef.current = true;
              void api.studio
                .devicePoll(
                  token
                    ? { providerId: provider.id, preset: subKey, accessToken: token }
                    : { providerId: provider.id, preset: subKey },
                )
                .then(async (result) => {
                  const pollHint = result as { interval?: number; slowDown?: boolean };
                  if (typeof pollHint.interval === "number" && pollHint.interval > 0) {
                    const nextMs = pollHint.interval >= 1000 ? pollHint.interval : pollHint.interval * 1000;
                    pollIntervalMsRef.current = Math.max(pollIntervalMsRef.current, nextMs);
                  } else if (pollHint.slowDown) {
                    pollIntervalMsRef.current += 5000;
                  }
                  if (result.provider || result.status === "authorized") {
                    setPending(false);
                    setReauthOpen(false);
                    await api.studio.discoverModels(provider.id, true).catch(() => null);
                    const fresh = await api.studio.providers();
                    onChange(fresh.providers);
                  }
                  onNotice(result.status === "authorized" ? "Device authorized · Synced /models" : "Still waiting");
                })
                .catch((error) => onNotice(errText(error), "danger"))
                .finally(() => {
                  pollInFlightRef.current = false;
                });
            }}
          >
            Connect
          </Button>
          {pending ? (
            <span className="font-mono text-xs text-info">
              Polling · {waited.toFixed(0)}s
            </span>
          ) : null}
        </div>
        {subKey === "codex-oauth" ? (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Browser redirect (PKCE)</summary>
            <div className="mt-2 flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="cap is-on">Step 1</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 w-full sm:w-auto md:min-h-8"
                  disabled={!privileged}
                  onClick={() => {
                    const popup = openAsyncPopup();
                    void api.studio
                      .pkceStart({ providerId: provider.id, preset: provider.preset || provider.id })
                      .then((start) => {
                        setVerifier(start.codeVerifier);
                        setLoginUrl(start.authorizeUrl || "");
                        if (start.authorizeUrl) {
                          if (popup && !popup.closed) popup.location.href = start.authorizeUrl;
                          else window.open(start.authorizeUrl, "_blank", "noopener,noreferrer");
                        } else {
                          popup?.close();
                        }
                      })
                      .catch((error) => {
                        popup?.close();
                        onNotice(errText(error), "danger");
                      });
                  }}
                >
                  Open Redirect
                </Button>
                {loginUrl ? (
                  <>
                    <a
                      href={loginUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-card px-3 text-xs text-info hover:border-primary sm:w-auto md:min-h-8"
                    >
                      Open sign-in link
                    </a>
                    <CopyButton value={loginUrl} label="Copy link" />
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="cap">Step 2</span>
                <input
                  className="field min-h-11 flex-1 font-mono"
                  aria-label="Callback URL or code"
                  placeholder="Callback URL or code"
                  value={callback}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setCallback(event.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 w-full sm:w-auto md:min-h-8"
                  disabled={!privileged || !callback.trim() || !verifier}
                  onClick={() => {
                    const pasted = callback.trim();
                    setCallback("");
                    void api.studio
                      .pkceExchange({ providerId: provider.id, codeOrUrl: pasted, codeVerifier: verifier || undefined })
                      .then(async () => {
                        setVerifier("");
                        setReauthOpen(false);
                        const disc = await api.studio.discoverModels(provider.id, true).catch(() => null);
                        const fresh = await api.studio.providers();
                        onChange(fresh.providers);
                        onNotice(
                          disc?.models?.length
                            ? `Subscription token stored & synced ${disc.models.length} models from /models.`
                            : "Subscription token stored",
                        );
                      })
                      .catch((error) => onNotice(errText(error), "danger"));
                  }}
                >
                  Connect
                </Button>
              </div>
            </div>
          </details>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-xl bg-background p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-muted-foreground">GCP Vertex AI Sign-In</p>
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label="Vertex AI sign-in mode">
          <button
            type="button"
            role="tab"
            className={cn("chip", vertexMode === "vertex-oauth" && "is-on")}
            aria-selected={vertexMode === "vertex-oauth"}
            disabled={!privileged}
            onClick={() => setVertexMode("vertex-oauth")}
          >
            Google OAuth
          </button>
          <button
            type="button"
            role="tab"
            className={cn("chip", vertexMode === "vertex-service-account" && "is-on")}
            aria-selected={vertexMode === "vertex-service-account"}
            disabled={!privileged}
            onClick={() => setVertexMode("vertex-service-account")}
          >
            Service Account (.json)
          </button>
          {provider.auth.hasSecret ? (
            <button
              type="button"
              className="ml-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setReauthOpen(false)}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {vertexMode === "vertex-service-account" ? (
        <div>
          <Dropzone
            accept={{ "application/json": [".json"] }}
            maxFiles={1}
            maxSize={64 * 1024}
            disabled={!privileged}
            aria-label="Drop GCP service account JSON"
            onDrop={(files, rejections) => {
              if (rejections && rejections.length > 0) {
                setSa(null);
                setSaError("Rejected file: must be a .json file under 64 KB");
                return;
              }
              const file = files[0];
              if (!file) return;
              void readServiceAccount(file).then((result) => {
                if ("error" in result) {
                  setSa(null);
                  setSaError(result.error);
                  return;
                }
                setSaError("");
                setSa(result);
              });
            }}
          >
            <DropzoneEmptyState title="Drop .json key" description="Max 64 KB" />
            <DropzoneContent />
          </Dropzone>
          {sa ? <p className="mt-2 font-mono text-xs text-success">{sa.clientEmail} · {sa.projectId}</p> : null}
          {saError ? <p className="mt-2 text-xs text-destructive" role="alert">{saError}</p> : null}
          <Button
            type="button"
            size="sm"
            className="mt-2 min-h-11 w-full sm:w-auto md:min-h-8"
            disabled={!privileged || !sa}
            onClick={() => {
              if (!sa) return;
              const json = sa.json;
              setSa(null);
              void api.studio
                .updateProvider(provider.id, {
                  serviceAccountJson: json,
                  auth: { mode: "vertex-service-account", projectId: sa.projectId, location: vertexLocation },
                })
                .then(async () => {
                  const fresh = await api.studio.providers();
                  onChange(fresh.providers);
                  setReauthOpen(false);
                  onNotice("Service account stored. The file was dropped from memory.");
                })
                .catch((error) => onNotice(errText(error), "danger"));
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="cap is-on">Step 1</span>
            <Button
              type="button"
              size="sm"
              className="min-h-11 w-full sm:w-auto md:min-h-8"
              disabled={!privileged}
              onClick={() => {
                setError("");
                const customClientId = vertexClientId.trim();
                const popup = openAsyncPopup();
                void api.studio
                  .pkceStart({
                    providerId: provider.id || "vertex-ai",
                    mode: "vertex-oauth",
                    preset: "vertex-ai",
                    ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID
                      ? { clientId: customClientId }
                      : {}),
                  })
                  .then((start) => {
                    const resolvedClientId = customClientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
                    const url =
                      start.authorizeUrl ||
                      `https://accounts.google.com/o/oauth2/auth?client_id=${encodeURIComponent(resolvedClientId)}&redirect_uri=${encodeURIComponent("https://sdk.cloud.google.com/applicationdefaultauthcode.html")}&scope=${encodeURIComponent("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform")}&response_type=code&access_type=offline&prompt=consent&token_usage=remote`;
                    setVerifier(start.codeVerifier);
                    setLoginUrl(url);
                    if (popup && !popup.closed) {
                      popup.location.href = url;
                    } else {
                      window.open(url, "_blank", "noopener,noreferrer");
                    }
                  })
                  .catch((error) => {
                    popup?.close();
                    onNotice(errText(error), "danger");
                  });
              }}
            >
              Sign in with Google
            </Button>
            {loginUrl ? (
              <>
                <a
                  href={loginUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-card px-3 text-xs text-info hover:border-primary sm:w-auto md:min-h-8"
                >
                  Open sign-in link
                </a>
                <CopyButton value={loginUrl} label="Copy link" />
              </>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="cap">Step 2</span>
            <input
              className="field min-h-11 flex-1 font-mono"
              aria-label="Google verification code"
              value={vertexOauthToken}
              placeholder="4/0A... code"
              autoComplete="off"
              spellCheck={false}
              disabled={!privileged}
              onChange={(event) => setVertexOauthToken(event.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 w-full sm:w-auto md:min-h-8"
              disabled={!privileged || (!vertexOauthToken.trim() && !vertexProjectId.trim() && !provider.auth.hasSecret)}
              onClick={() => {
                setError("");
                const token = vertexOauthToken.trim();
                const customClientId = vertexClientId.trim();
                const resolvedClientId = customClientId || provider.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
                const isCodeOrCallback =
                  Boolean(token) &&
                  (token.startsWith("http://") ||
                    token.startsWith("https://") ||
                    (!token.startsWith("ya29.") && !token.startsWith("{")));
                setVertexOauthToken("");
                void (async () => {
                  try {
                    let exchanged = false;
                    let detectedProjectId = "";
                    let detectedList: VertexDetectedProject[] = [];
                    if (token) {
                      const exRes = await api.studio.pkceExchange({
                        providerId: provider.id,
                        mode: "vertex-oauth",
                        ...(isCodeOrCallback
                          ? { codeOrUrl: token, codeVerifier: verifier || undefined }
                          : { accessToken: token }),
                        ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID
                          ? { clientId: customClientId }
                          : {}),
                      });
                      if (isCodeOrCallback) setVerifier("");
                      exchanged = true;
                      detectedProjectId = exRes.provider?.auth?.projectId || exRes.projectId || "";
                      detectedList = exRes.projects || exRes.provider?.auth?.projects || [];
                    }
                    const effectiveProjectId =
                      vertexProjectId.trim() || detectedProjectId || provider.auth.projectId || "";
                    if (effectiveProjectId) setVertexProjectId(effectiveProjectId);
                    if (detectedList.length > 0) setVertexProjects(detectedList);
                    const res = await api.studio.updateProvider(provider.id, {
                      oauthToken: exchanged ? undefined : token || undefined,
                      auth: {
                        mode: "vertex-oauth",
                        clientId: resolvedClientId,
                        projectId: effectiveProjectId || undefined,
                        location: vertexLocation || "global",
                        accessToken: exchanged ? undefined : token || undefined,
                      },
                    });
                    await api.studio.discoverModels(provider.id, true).catch(() => null);
                    const fresh = await api.studio.providers().catch(() => null);
                    const baseProviders = fresh?.providers || res.providers;
                    const mergedProjects = detectedList.length > 0 ? detectedList : vertexProjects;
                    const nextProviders =
                      mergedProjects.length > 0
                        ? baseProviders.map((p) =>
                            p.id === provider.id ? { ...p, auth: { ...p.auth, projects: mergedProjects } } : p,
                          )
                        : baseProviders;
                    onChange(nextProviders);
                    setReauthOpen(false);
                    onNotice(
                      effectiveProjectId
                        ? `Google Account connected · Project ${effectiveProjectId}.`
                        : "Google Account connected.",
                    );
                  } catch (error) {
                    setError(errText(error));
                    onNotice(errText(error), "danger");
                  }
                })();
              }}
            >
              Connect
            </Button>
          </div>
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">
              Advanced settings (Location / Custom Client ID)
            </summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">
                Location
                <select
                  className="field mt-1 min-h-11 font-mono"
                  value={vertexLocation}
                  disabled={!privileged}
                  onChange={(event) => setVertexLocation(event.target.value)}
                >
                  {VERTEX_LOCATIONS.map((loc) => (
                    <option key={loc} value={loc}>
                      {loc}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                GCP Project ID (optional)
                <input
                  className="field mt-1 min-h-11 font-mono"
                  value={vertexProjectId}
                  placeholder="Auto-detected on sign-in"
                  disabled={!privileged}
                  onChange={(event) => setVertexProjectId(event.target.value)}
                />
              </label>
              {vertexProjects.length > 1 ? (
                <label className="text-xs text-muted-foreground sm:col-span-2">
                  Switch detected GCP Project
                  <select
                    className="field mt-1 min-h-11 font-mono"
                    value={vertexProjectId}
                    disabled={!privileged}
                    onChange={(event) => {
                      const nextProject = event.target.value;
                      setVertexProjectId(nextProject);
                      void api.studio
                        .updateProvider(provider.id, {
                          auth: {
                            mode: "vertex-oauth",
                            clientId: vertexClientId.trim() || provider.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
                            projectId: nextProject || undefined,
                            location: vertexLocation || "global",
                          },
                        })
                        .then((res) => {
                          onChange(res.providers);
                          onNotice(`Switched Vertex project to ${nextProject}`);
                        })
                        .catch((err) => onNotice(errText(err), "danger"));
                    }}
                  >
                    {vertexProjects.map((proj) => (
                      <option key={proj.projectId} value={proj.projectId}>
                        {proj.name ? `${proj.name} (${proj.projectId})` : proj.projectId}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="text-xs text-muted-foreground sm:col-span-2">
                Google OAuth Client ID
                <input
                  className="field mt-1 min-h-11 font-mono"
                  value={vertexClientId}
                  placeholder={DEFAULT_GOOGLE_OAUTH_CLIENT_ID}
                  disabled={!privileged}
                  onChange={(event) => setVertexClientId(event.target.value)}
                />
              </label>
            </div>
          </details>
          {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
        </div>
      )}
    </div>
  );
}

const FALLBACK_SUBSCRIPTION_PRESETS: ProviderPreset[] = [
  {
    id: "codex-oauth",
    label: "OpenAI Codex (ChatGPT Subscription)",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authMode: "device-code",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    allowPrivateNetwork: false,
    description: "ChatGPT Plus / Pro subscription via OpenAI Device Code (LLM vision + writer)",
  },
  {
    id: "claude-oauth",
    label: "Anthropic Claude (Claude Pro / Max OAuth)",
    category: "subscription",
    kind: "subscription",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    authMode: "oauth-pkce",
    allowPrivateNetwork: false,
    description: "Claude Pro / Max subscription via browser OAuth PKCE or claude setup-token (LLM vision + writer)",
  },
  {
    id: "github-copilot",
    label: "GitHub Copilot Subscription",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.githubcopilot.com",
    authMode: "device-code",
    clientId: "Ov23li8tweQw6odWQebz",
    allowPrivateNetwork: false,
    description: "GitHub Copilot subscription via GitHub Device Code (LLM vision + writer)",
  },
  {
    id: "grok-subscription",
    label: "xAI SuperGrok / Grok Subscription",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authMode: "device-code",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    allowPrivateNetwork: false,
    description: "xAI SuperGrok subscription via xAI Device Code with live /models discovery and Grok TTS support",
  },
  {
    id: "subscription-bridge",
    label: "Local CLI Subscription Proxy",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8317/v1",
    authMode: "none",
    allowPrivateNetwork: true,
    description: "Local OpenAI-compatible CLI proxy on 127.0.0.1:8317",
  },
];

async function autoRouteProviderStages(
  provider: ProviderView | null | undefined,
  fallbackId: string,
  presets: Record<string, ProviderPreset>,
  presetId?: string,
): Promise<StagesState | null> {
  const pid = provider?.id || fallbackId;
  const pKey = presetId || provider?.preset || pid;
  const rawModels =
    provider?.models && provider.models.length > 0
      ? provider.models
      : presets[pKey]?.defaultModels?.length
        ? presets[pKey]!.defaultModels!
        : [];
  const enabledModels = rawModels.filter((m) => m.enabled !== false);
  const candidates = (enabledModels.length > 0 ? enabledModels : rawModels).filter(
    (m) =>
      !(m.capabilities?.tts && !m.capabilities?.writer) &&
      !(m.capabilities?.image && !m.capabilities?.writer && !m.capabilities?.vision),
  );
  const visionModelObj = candidates.find((m) => Boolean(m.capabilities?.vision));
  const writerModelObj = candidates.find((m) => m.capabilities?.writer !== false) || candidates[0];
  const visionIdClean = visionModelObj ? stripProviderPrefixUi(visionModelObj.id, pid) : "";
  const writerIdClean = writerModelObj ? stripProviderPrefixUi(writerModelObj.id, pid) : "";
  const visionRef = visionIdClean ? `${pid}:${visionIdClean}` : "";
  const writerRef = writerIdClean ? `${pid}:${writerIdClean}` : "";
  if (!visionRef && !writerRef) return null;

  const currentStages = await api.studio.stages();
  const vChain = visionRef ? [visionRef] : currentStages.reader.chain;
  const wChain = writerRef ? [writerRef] : currentStages.writer.chain;

  return await api.studio.putStages({
    revision: currentStages.revision,
    stages: {
      reader: visionRef
        ? {
            ...currentStages.reader,
            stage: "reader",
            chain: vChain,
            primary: vChain[0] ?? null,
            fallbacks: vChain.slice(1),
            inheritFrom: null,
          }
        : currentStages.reader,
      matcher: visionRef
        ? {
            ...currentStages.matcher,
            stage: "matcher",
            chain: vChain,
            primary: vChain[0] ?? null,
            fallbacks: vChain.slice(1),
            inheritFrom: "reader",
          }
        : currentStages.matcher,
      writer: writerRef
        ? {
            ...currentStages.writer,
            stage: "writer",
            chain: wChain,
            primary: wChain[0] ?? null,
            fallbacks: wChain.slice(1),
            inheritFrom: null,
          }
        : currentStages.writer,
      scout: visionRef
        ? {
            ...currentStages.scout,
            stage: "scout",
            chain: vChain,
            primary: vChain[0] ?? null,
            fallbacks: vChain.slice(1),
            inheritFrom: "reader",
          }
        : currentStages.scout,
      fact_check: writerRef
        ? {
            ...currentStages.fact_check,
            stage: "fact_check",
            chain: wChain,
            primary: wChain[0] ?? null,
            fallbacks: wChain.slice(1),
            inheritFrom: null,
          }
        : currentStages.fact_check,
    },
  });
}

const SETUP_MODE_TABS: Array<{ id: FilterId; label: string }> = [
  { id: "cloud-api", label: "API key" },
  { id: "subscription", label: "Subscription" },
  { id: "cloud-iam", label: "Cloud account" },
  { id: "local", label: "Local" },
];

function ProviderSetupPane({
  presets,
  providers,
  editing,
  privileged,
  onCancel,
  onSaved,
  onStagesSaved,
  onNotice,
}: {
  presets: Record<string, ProviderPreset>;
  providers: ProviderView[];
  editing: ProviderView | null;
  privileged: boolean;
  onCancel: () => void;
  onSaved: (providers: ProviderView[], savedProviderId?: string) => void;
  onStagesSaved?: (stages: StagesState) => void;
  onNotice: OnNotice;
}) {
  const providersRef = useRef<ProviderView[]>(providers);
  providersRef.current = providers;
  const lastInitKeyRef = useRef<string>("");
  const [mode, setMode] = useState<FilterId>("cloud-api");
  const [presetId, setPresetId] = useState("openrouter");
  const [id, setId] = useState(() =>
    editing ? editing.id : nextAvailableProviderId("openrouter", providers),
  );
  const [userEditedId, setUserEditedId] = useState(false);
  const [userEditedLabel, setUserEditedLabel] = useState(false);
  const [label, setLabel] = useState("OpenRouter");
  const [protocolLabel, setProtocolLabel] = useState("OpenAI compatible");
  const [baseUrl, setBaseUrl] = useState("https://openrouter.ai/api/v1");
  const [apiKey, setApiKey] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [headersText, setHeadersText] = useState("");
  const [routeStages, setRouteStages] = useState(false);
  const [sa, setSa] = useState<ServiceAccountPreview | null>(null);
  const [saError, setSaError] = useState("");
  const [vertexMode, setVertexMode] = useState<VertexAuthMode>("vertex-oauth");
  const [vertexProjectId, setVertexProjectId] = useState("");
  const [vertexProjects, setVertexProjects] = useState<VertexDetectedProject[]>([]);
  const [vertexLocation, setVertexLocation] = useState("global");
  const [vertexClientId, setVertexClientId] = useState(DEFAULT_GOOGLE_OAUTH_CLIENT_ID);
  const [vertexOauthToken, setVertexOauthToken] = useState("");
  const [vertexLoginUrl, setVertexLoginUrl] = useState("");
  const [vertexVerifier, setVertexVerifier] = useState("");
  const [dialogConnectedProvider, setDialogConnectedProvider] = useState<ProviderView | null>(null);
  const [subLoginUrl, setSubLoginUrl] = useState("");
  const [subVerifier, setSubVerifier] = useState("");
  const [subCodeOrUrl, setSubCodeOrUrl] = useState("");
  const [deviceUserCode, setDeviceUserCode] = useState("");
  const [deviceVerifyUri, setDeviceVerifyUri] = useState("");
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceWaited, setDeviceWaited] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const pollInFlightRef = useRef(false);
  const pollIntervalMsRef = useRef(5000);

  useEffect(() => {
    const hasPresets = Object.keys(presets).length > 0;
    const initKey = editing ? `edit:${editing.id}` : `new:${hasPresets ? "ready" : "empty"}`;
    if (lastInitKeyRef.current === initKey) return;
    lastInitKeyRef.current = initKey;

    setApiKey("");
    setSa(null);
    setSaError("");
    setVertexOauthToken("");
    setVertexLoginUrl("");
    setVertexVerifier("");
    setSubLoginUrl("");
    setSubVerifier("");
    setSubCodeOrUrl("");
    setDeviceUserCode("");
    setDeviceVerifyUri("");
    setDevicePolling(false);
    setDeviceWaited(0);
    setRouteStages(false);
    setFormError("");
    setUserEditedId(false);
    setUserEditedLabel(false);
    setDialogConnectedProvider(editing);
    setHeadersText(editing?.headers ? JSON.stringify(editing.headers, null, 2) : "");
    if (editing) {
      const nextMode = kindOf(editing);
      setMode(nextMode === "all" || nextMode === "tts" ? "cloud-api" : nextMode);
      setId(editing.id);
      setLabel(editing.label);
      setProtocolLabel(
        editing.protocol === "anthropic-messages"
          ? "Anthropic messages"
          : editing.protocol === "vertex-openai" || editing.kind === "cloud-iam"
            ? "Vertex AI"
            : "OpenAI compatible",
      );
      setBaseUrl(editing.baseUrl);
      setAllowPrivate(editing.allowPrivateNetwork);
      setPresetId(editing.preset || editing.id);
      setVertexMode(editing.auth.mode === "vertex-service-account" ? "vertex-service-account" : "vertex-oauth");
      setVertexProjectId(editing.auth.projectId || "");
      setVertexProjects(editing.auth.projects || []);
      setVertexLocation(editing.auth.location || "global");
      setVertexClientId(editing.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID);
      return;
    }
    setVertexMode("vertex-oauth");
    setVertexProjectId("");
    setVertexProjects([]);
    setVertexLocation("global");
    setVertexClientId(DEFAULT_GOOGLE_OAUTH_CLIENT_ID);
    applyPreset(presets.openrouter || presets.openai, "openrouter", "cloud-api");
  }, [editing, presets]);

  useEffect(() => {
    if (
      editing ||
      userEditedId ||
      apiKey.trim() ||
      busy ||
      devicePolling ||
      subLoginUrl ||
      vertexLoginUrl
    ) {
      return;
    }
    if (hasProviderIdCollision(id, providers)) {
      const nextId = nextAvailableProviderId(presetId, providers);
      setId(nextId);
      if (!userEditedLabel) {
        const resolved = presets[presetId] || FALLBACK_SUBSCRIPTION_PRESETS.find((item) => item.id === presetId);
        const baseLabel =
          resolved?.label ||
          (presetId === "vertex-ai"
            ? "Google Cloud Vertex AI"
            : presetId === "ollama"
              ? "Ollama"
              : presetId === "openrouter"
                ? "OpenRouter"
                : presetId);
        setLabel(nextAvailableProviderLabel(baseLabel, nextId, presetId, providers));
      }
    }
  }, [
    providers,
    editing,
    userEditedId,
    userEditedLabel,
    apiKey,
    busy,
    devicePolling,
    subLoginUrl,
    vertexLoginUrl,
    id,
    presetId,
    presets,
  ]);

  function applyPreset(preset: ProviderPreset | undefined, fallbackId: string, fallbackMode?: FilterId) {
    const fallbackSub = FALLBACK_SUBSCRIPTION_PRESETS.find((item) => item.id === fallbackId);
    const resolved = preset || fallbackSub;
    const basePresetId = resolved?.id || fallbackId;
    const nextId = editing
      ? editing.id
      : nextAvailableProviderId(basePresetId, providersRef.current);
    setPresetId(basePresetId);
    setId(nextId);
    setUserEditedId(false);
    setUserEditedLabel(false);
    if (!editing) setDialogConnectedProvider(null);
    const baseLabel =
      resolved?.label ||
      (basePresetId === "vertex-ai"
        ? "Google Cloud Vertex AI"
        : basePresetId === "ollama"
          ? "Ollama"
          : basePresetId === "openrouter"
            ? "OpenRouter"
            : basePresetId);
    setLabel(
      editing
        ? editing.label
        : nextAvailableProviderLabel(baseLabel, nextId, basePresetId, providersRef.current),
    );
    setProtocolLabel(
      resolved?.protocol === "anthropic-messages" || basePresetId === "anthropic" || basePresetId === "claude-oauth"
        ? "Anthropic messages"
        : resolved?.protocol === "vertex-openai" || basePresetId === "vertex-ai" || fallbackMode === "cloud-iam"
          ? "Vertex AI"
          : "OpenAI compatible",
    );
    setBaseUrl(
      resolved?.baseUrl ||
        (basePresetId === "ollama"
          ? "http://127.0.0.1:11434/v1"
          : basePresetId === "vertex-ai"
            ? "https://aiplatform.googleapis.com/v1"
            : "https://openrouter.ai/api/v1"),
    );
    setAllowPrivate(
      Boolean(
        resolved?.allowPrivateNetwork ||
          basePresetId === "subscription-bridge" ||
          basePresetId === "ollama" ||
          fallbackMode === "local",
      ),
    );
    const derivedMode =
      resolved?.category === "local" || resolved?.category === "subscription" || resolved?.category === "cloud-iam"
        ? resolved.category
        : fallbackMode ||
          (SUBSCRIPTION_PROVIDER_IDS.has(basePresetId)
            ? "subscription"
            : basePresetId === "vertex-ai"
              ? "cloud-iam"
              : "cloud-api");
    setMode(derivedMode);
    setSubLoginUrl("");
    setSubVerifier("");
    setSubCodeOrUrl("");
    setDeviceUserCode("");
    setDeviceVerifyUri("");
    setDevicePolling(false);
    setDeviceWaited(0);
    setFormError("");
  }

  const resolvedProtocol: ProviderView["protocol"] =
    protocolLabel === "Anthropic messages"
      ? "anthropic-messages"
      : protocolLabel === "Vertex AI"
        ? "vertex-openai"
        : "openai-compatible";

  async function upsertCurrentProviderRecord(): Promise<{ provider: ProviderView; providers: ProviderView[] }> {
    const body = {
      id,
      label,
      preset: presetId,
      kind: mode,
      protocol: resolvedProtocol,
      baseUrl,
      allowPrivateNetwork: allowPrivate || presetId === "subscription-bridge",
      auth:
        mode === "cloud-iam" || presetId === "vertex-ai"
          ? {
              mode: vertexMode,
              clientId: vertexClientId.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
              projectId:
                (vertexMode === "vertex-service-account" ? sa?.projectId : vertexProjectId.trim()) ||
                vertexProjectId.trim() ||
                undefined,
              location: vertexLocation || "global",
            }
          : undefined,
      expectedRevision: editing?.revision,
    };
    const res = editing ? await api.studio.updateProvider(editing.id, body) : await api.studio.createProvider(body);
    return { provider: res.provider, providers: res.providers };
  }

  async function finishProviderActivation(
    savedProvider: ProviderView | null | undefined,
    allProviders: ProviderView[],
    message: string,
  ) {
    const targetId = savedProvider?.id || id;
    let latestProvider = savedProvider || null;
    let latestProviders = allProviders;
    let syncedCount = savedProvider?.models?.length || 0;
    if (targetId) {
      try {
        const discovered = await api.studio.discoverModels(targetId, true);
        if (discovered?.models?.length) {
          syncedCount = discovered.models.length;
        }
        const fresh = await api.studio.providers();
        latestProviders = fresh.providers;
        latestProvider = fresh.providers.find((p) => p.id === targetId) || discovered?.provider || latestProvider;
      } catch {
        /* Keep saved provider models if live /models endpoint is unreachable */
      }
    }
    if (routeStages) {
      try {
        const nextStages = await autoRouteProviderStages(latestProvider, targetId, presets, presetId);
        if (nextStages) onStagesSaved?.(nextStages);
      } catch {
        /* Keep provider activation successful even if stage routing update fails */
      }
    }
    setDialogConnectedProvider(latestProvider);
    const syncNote = syncedCount > 0 ? ` Synced ${syncedCount} models from /models.` : "";
    onNotice(
      routeStages
        ? `${message}${syncNote} Pipeline stages routed to ${label || targetId}.`
        : `${message}${syncNote}`,
    );
    onSaved(latestProviders, targetId);
  }

  useEffect(() => {
    if (!devicePolling || mode !== "subscription" || !DEVICE_CODE_PROVIDER_IDS.has(presetId)) return;
    let cancelled = false;
    let timer = 0;
    const targetProviderId = id || presetId;
    const started = performance.now();
    const tick = () => {
      if (cancelled) return;
      setDeviceWaited((performance.now() - started) / 1000);
      if (pollInFlightRef.current) {
        timer = window.setTimeout(tick, pollIntervalMsRef.current);
        return;
      }
      pollInFlightRef.current = true;
      void api.studio
        .devicePoll({ providerId: targetProviderId, preset: presetId })
        .then(async (res) => {
          const pollHint = res as { interval?: number; slowDown?: boolean };
          if (typeof pollHint.interval === "number" && pollHint.interval > 0) {
            const nextMs = pollHint.interval >= 1000 ? pollHint.interval : pollHint.interval * 1000;
            pollIntervalMsRef.current = Math.max(pollIntervalMsRef.current, nextMs);
          } else if (pollHint.slowDown) {
            pollIntervalMsRef.current += 5000;
          }
          if (res.status === "authorized") {
            setDevicePolling(false);
            const fresh = await api.studio.providers();
            const matched = fresh.providers.find((p) => p.id === targetProviderId) || res.provider;
            await finishProviderActivation(
              matched,
              fresh.providers,
              `${deviceProviderTitleFor(presetId)} authorized and connected.`,
            );
            return;
          }
          if (!cancelled) {
            timer = window.setTimeout(tick, pollIntervalMsRef.current);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDevicePolling(false);
            setFormError(errText(error));
          }
        })
        .finally(() => {
          pollInFlightRef.current = false;
        });
    };
    timer = window.setTimeout(tick, pollIntervalMsRef.current);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [devicePolling, mode, presetId, id, routeStages]);

  async function startSubscriptionPkce() {
    setFormError("");
    const popup = openAsyncPopup();
    try {
      const start = await api.studio.pkceStart({ providerId: id, preset: presetId });
      setSubVerifier(start.codeVerifier);
      setSubLoginUrl(start.authorizeUrl || "");
      if (start.authorizeUrl) {
        if (popup && !popup.closed) {
          popup.location.href = start.authorizeUrl;
        } else {
          window.open(start.authorizeUrl, "_blank", "noopener,noreferrer");
        }
      } else {
        popup?.close();
      }
    } catch (error) {
      popup?.close();
      setFormError(errText(error));
    }
  }

  async function completeSubscriptionPkce() {
    setFormError("");
    const pasted = subCodeOrUrl.trim();
    if (!pasted) {
      setFormError(
        presetId === "claude-oauth"
          ? "Paste the authorization code (code#state) or claude setup-token (sk-ant-oat01-...) first."
          : "Paste the callback URL or authorization code first.",
      );
      return;
    }
    const isDirectClaudeToken = presetId === "claude-oauth" && pasted.startsWith("sk-ant-");
    if (!subVerifier && !isDirectClaudeToken) {
      setFormError(
        presetId === "claude-oauth"
          ? "Click 'Open Claude Sign-In' first so PKCE can exchange this code."
          : "Click 'Open Redirect' first so PKCE can exchange this code.",
      );
      return;
    }
    setBusy(true);
    try {
      await upsertCurrentProviderRecord();
      await api.studio.pkceExchange({
        providerId: id,
        codeOrUrl: pasted,
        codeVerifier: subVerifier || undefined,
      });
      setSubCodeOrUrl("");
      setSubVerifier("");
      const fresh = await api.studio.providers();
      const savedProvider = fresh.providers.find((p) => p.id === id) || null;
      await finishProviderActivation(
        savedProvider,
        fresh.providers,
        `${presetId === "claude-oauth" ? "Claude" : "ChatGPT"} subscription connected.`,
      );
    } catch (error) {
      setFormError(errText(error));
    } finally {
      setBusy(false);
    }
  }

  async function startSubscriptionDeviceFlow() {
    setFormError("");
    setBusy(true);
    const popup = openAsyncPopup();
    try {
      const targetProviderId = id || presetId;
      const clientId = deviceClientIdFor(presetId);
      const start = await api.studio.deviceStart(targetProviderId, { clientId, preset: presetId });
      const targetUri = start.verificationUriComplete || start.verificationUri;
      pollIntervalMsRef.current = Math.max(5, Number(start.interval) || 5) * 1000;
      setDeviceUserCode(start.userCode);
      setDeviceVerifyUri(targetUri);
      setDevicePolling(true);
      setDeviceWaited(0);
      if (targetUri) {
        if (popup && !popup.closed) {
          popup.location.href = targetUri;
        } else {
          window.open(targetUri, "_blank", "noopener,noreferrer");
        }
      } else {
        popup?.close();
      }
    } catch (error) {
      popup?.close();
      setFormError(errText(error));
    } finally {
      setBusy(false);
    }
  }

  async function verifySubscriptionDeviceFlow() {
    if (pollInFlightRef.current) return;
    setFormError("");
    setBusy(true);
    pollInFlightRef.current = true;
    try {
      const targetProviderId = id || presetId;
      const res = await api.studio.devicePoll({ providerId: targetProviderId, preset: presetId });
      const pollHint = res as { interval?: number; slowDown?: boolean };
      if (typeof pollHint.interval === "number" && pollHint.interval > 0) {
        const nextMs = pollHint.interval >= 1000 ? pollHint.interval : pollHint.interval * 1000;
        pollIntervalMsRef.current = Math.max(pollIntervalMsRef.current, nextMs);
      } else if (pollHint.slowDown) {
        pollIntervalMsRef.current += 5000;
      }
      if (res.status === "authorized") {
        setDevicePolling(false);
        const fresh = await api.studio.providers();
        const savedProvider = fresh.providers.find((p) => p.id === targetProviderId) || res.provider;
        await finishProviderActivation(
          savedProvider,
          fresh.providers,
          `${deviceProviderTitleFor(presetId)} authorized and connected.`,
        );
      } else {
        setFormError(
          `Waiting for ${deviceProviderTitleFor(presetId)} device authorization — approve the code in your browser first.`,
        );
      }
    } catch (error) {
      setFormError(errText(error));
    } finally {
      pollInFlightRef.current = false;
      setBusy(false);
    }
  }

  async function startGoogleSignIn() {
    setFormError("");
    setBusy(true);
    const popup = openAsyncPopup();
    try {
      const customClientId = vertexClientId.trim();
      const start = await api.studio.pkceStart({
        providerId: id || "vertex-ai",
        mode: "vertex-oauth",
        preset: "vertex-ai",
        ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID ? { clientId: customClientId } : {}),
      });
      const resolvedClientId = customClientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
      const url =
        start.authorizeUrl ||
        `https://accounts.google.com/o/oauth2/auth?client_id=${encodeURIComponent(resolvedClientId)}&redirect_uri=${encodeURIComponent("https://sdk.cloud.google.com/applicationdefaultauthcode.html")}&scope=${encodeURIComponent("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform")}&response_type=code&access_type=offline&prompt=consent&token_usage=remote`;
      setVertexVerifier(start.codeVerifier);
      setVertexLoginUrl(url);
      if (popup && !popup.closed) popup.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      popup?.close();
      setFormError(errText(error));
    } finally {
      setBusy(false);
    }
  }

  const presetList = Object.values(presets);
  const subscriptionPresetOptions = useMemo(() => {
    const byId = new Map<string, ProviderPreset>();
    for (const item of FALLBACK_SUBSCRIPTION_PRESETS) {
      const fromServer = presets[item.id];
      byId.set(
        item.id,
        fromServer
          ? {
              ...fromServer,
              authMode: DEVICE_CODE_PROVIDER_IDS.has(item.id) ? "device-code" : fromServer.authMode,
              clientId: DEVICE_CODE_PROVIDER_IDS.has(item.id)
                ? item.clientId || fromServer.clientId
                : fromServer.clientId,
            }
          : item,
      );
    }
    for (const item of presetList) {
      if (item.category === "subscription" && !byId.has(item.id)) {
        byId.set(item.id, item);
      }
    }
    return [...byId.values()];
  }, [presets, presetList]);
  const localPresetList = useMemo(() => buildLocalPresets(presets), [presets]);
  const activeDialogProvider = dialogConnectedProvider || editing;
  const isJustConnectedOAuth =
    !editing &&
    Boolean(dialogConnectedProvider?.auth.hasSecret) &&
    ((mode === "subscription" && presetId !== "subscription-bridge" && !subCodeOrUrl.trim()) ||
      (mode === "cloud-iam" && vertexMode === "vertex-oauth" && !vertexOauthToken.trim()));

  async function submit() {
    if (isJustConnectedOAuth && dialogConnectedProvider) {
      const fresh = await api.studio.providers().catch(() => null);
      if (fresh?.providers) onSaved(fresh.providers, dialogConnectedProvider.id);
      else onCancel();
      return;
    }
    if (mode === "subscription" && (!editing?.auth.hasSecret || subCodeOrUrl.trim())) {
      if (DEVICE_CODE_PROVIDER_IDS.has(presetId)) {
        if (deviceUserCode) await verifySubscriptionDeviceFlow();
        else await startSubscriptionDeviceFlow();
        return;
      }
      if (presetId === "claude-oauth") {
        if (subCodeOrUrl.trim()) await completeSubscriptionPkce();
        else await startSubscriptionPkce();
        return;
      }
    }
    if (
      mode === "cloud-iam" &&
      vertexMode === "vertex-oauth" &&
      !vertexOauthToken.trim() &&
      !editing?.auth.hasSecret
    ) {
      if (!vertexLoginUrl) await startGoogleSignIn();
      else setFormError("Paste the Google verification code (4/0A...) in Step 2 to connect.");
      return;
    }
    setFormError("");
    if (mode === "cloud-api" && (!editing || !editing.auth.hasSecret) && !apiKey.trim()) {
      setFormError("Enter an API key to verify and add this provider.");
      return;
    }
    const targetId = (editing ? editing.id : id).trim();
    if (!NODE_ID_RE.test(targetId)) {
      setFormError("Id must start with a letter or digit and stay under 64 characters.");
      return;
    }
    if (!editing && hasProviderIdCollision(targetId, providers)) {
      setFormError(
        `Provider ID '${targetId}' already exists. Choose a unique Provider ID in Advanced connection settings or configure the existing connection.`,
      );
      return;
    }
    if ((mode === "cloud-api" || mode === "cloud-iam") && !baseUrl.startsWith("https://")) {
      setFormError("Cloud API and Vertex URLs must use https://.");
      return;
    }
    const effectiveAllowPrivate = allowPrivate || presetId === "subscription-bridge" || mode === "local";
    const httpUrl = baseUrl.startsWith("http://");
    if (!baseUrl.startsWith("https://") && !httpUrl) {
      setFormError("URL must start with https://, or http:// with the private-network opt-in.");
      return;
    }
    if (httpUrl && !effectiveAllowPrivate) {
      setFormError("http:// endpoints need Allow private network. Remote cloud URLs must use https://.");
      return;
    }
    if (mode === "local" && !effectiveAllowPrivate) {
      setFormError("Local providers need the private-network opt-in.");
      return;
    }
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      try {
        const parsed = JSON.parse(headersText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Headers must be a JSON object");
        }
        headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
        );
      } catch (error) {
        setFormError(error instanceof Error ? error.message : "Headers JSON is invalid");
        return;
      }
    }
    const isVertexDialog = mode === "cloud-iam" || presetId === "vertex-ai";
    const trimmedVertexToken = vertexOauthToken.trim();
    const isVertexAuthCode =
      isVertexDialog &&
      vertexMode === "vertex-oauth" &&
      Boolean(trimmedVertexToken) &&
      (trimmedVertexToken.startsWith("http://") ||
        trimmedVertexToken.startsWith("https://") ||
        (!trimmedVertexToken.startsWith("ya29.") && !trimmedVertexToken.startsWith("{")));
    const resolvedClientId = vertexClientId.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
    setBusy(true);
    try {
      const body = {
        id: targetId,
        label: label.trim() || targetId,
        preset: presetId,
        kind: mode,
        protocol: resolvedProtocol,
        baseUrl,
        allowPrivateNetwork: effectiveAllowPrivate,
        headers,
        apiKey: apiKey.trim() || undefined,
        serviceAccountJson: isVertexDialog && vertexMode === "vertex-service-account" ? sa?.json : undefined,
        oauthToken:
          isVertexDialog && vertexMode === "vertex-oauth" && trimmedVertexToken && !isVertexAuthCode
            ? trimmedVertexToken
            : undefined,
        auth: isVertexDialog
          ? {
              mode: vertexMode,
              clientId: resolvedClientId,
              projectId:
                (vertexMode === "vertex-service-account" ? sa?.projectId : vertexProjectId.trim()) ||
                vertexProjectId.trim() ||
                undefined,
              location: vertexLocation || "global",
              accessToken:
                vertexMode === "vertex-oauth" && trimmedVertexToken && !isVertexAuthCode
                  ? trimmedVertexToken
                  : undefined,
            }
          : sa
            ? { projectId: sa.projectId }
            : undefined,
        expectedRevision: editing?.revision,
        ...(mode === "cloud-api" ? { verifyBeforeSave: true } : {}),
        ...(!editing ? { createOnly: true } : {}),
      };
      const secret = apiKey || vertexOauthToken;
      let result = editing
        ? await api.studio.updateProvider(editing.id, body)
        : await api.studio.createProvider(body);
      const savedId = result.provider?.id || targetId;
      setApiKey("");
      setVertexOauthToken("");
      if (isVertexDialog && vertexMode === "vertex-oauth" && trimmedVertexToken) {
        const exRes = await api.studio.pkceExchange({
          providerId: savedId,
          mode: "vertex-oauth",
          ...(isVertexAuthCode
            ? { codeOrUrl: trimmedVertexToken, codeVerifier: vertexVerifier || undefined }
            : { accessToken: trimmedVertexToken }),
          ...(resolvedClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID ? { clientId: resolvedClientId } : {}),
        });
        setVertexVerifier("");
        const detectedProjectId = exRes.provider?.auth?.projectId || exRes.projectId || "";
        const detectedList = exRes.projects || exRes.provider?.auth?.projects || [];
        if (detectedProjectId && !vertexProjectId.trim()) {
          setVertexProjectId(detectedProjectId);
        }
        if (detectedList.length > 0) {
          setVertexProjects(detectedList);
        }
        const fresh = await api.studio.providers();
        result = { ...result, providers: fresh.providers };
      }
      setSa(null);
      const savedProvider = result.providers.find((p) => p.id === savedId) || result.provider;
      await finishProviderActivation(
        savedProvider,
        result.providers,
        secret
          ? "Key verified, stored, and cleared from the form."
          : presetId === "subscription-bridge"
            ? "Local CLI subscription bridge saved."
            : "Provider saved.",
      );
    } catch (error) {
      setFormError(errText(error));
    } finally {
      setBusy(false);
    }
  }

  const serviceOptions = useMemo(() => {
    if (mode === "subscription") return subscriptionPresetOptions;
    if (mode === "local") {
      return localPresetList.map((item) => ({
        id: item.id,
        label: item.label,
        baseUrl: item.baseUrl,
        category: "local" as const,
      }));
    }
    const filtered = presetList.filter((preset) =>
      mode === "cloud-api" ? preset.category === "cloud-api" : preset.category === "cloud-iam",
    );
    if (filtered.length > 0) return filtered;
    if (mode === "cloud-iam") {
      return [{ id: "vertex-ai", label: "Google Cloud Vertex AI", baseUrl: "https://aiplatform.googleapis.com/v1" }];
    }
    return [
      { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
      { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
      { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com" },
    ];
  }, [mode, subscriptionPresetOptions, localPresetList, presetList]);

  const ctaLabel = busy
    ? "Verifying…"
    : isJustConnectedOAuth
      ? "Done"
      : mode === "cloud-api"
        ? "Verify connection"
        : mode === "subscription" && DEVICE_CODE_PROVIDER_IDS.has(presetId) && !editing?.auth.hasSecret
          ? deviceUserCode
            ? "Check authorization"
            : deviceButtonLabelFor(presetId)
          : mode === "subscription" && presetId === "claude-oauth" && (!editing?.auth.hasSecret || subCodeOrUrl.trim())
            ? subCodeOrUrl.trim()
              ? "Verify connection"
              : "Open Claude Sign-In"
            : mode === "cloud-iam" && vertexMode === "vertex-oauth" && (!editing?.auth.hasSecret || vertexOauthToken.trim())
              ? vertexOauthToken.trim()
                ? "Verify connection"
                : "Sign in with Google"
              : "Verify connection";

  return (
    <>
      <div className="studio-pane-header">
        <h2>{editing ? editing.label : "New connection"}</h2>
      </div>

      <div className="studio-subtabs" role="tablist" aria-label="Connection mode">
        {SETUP_MODE_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            onClick={() => {
              setMode(item.id);
              setFormError("");
              if (item.id === "cloud-api") {
                const firstCloud =
                  presets.openrouter ||
                  presets.openai ||
                  presetList.find((p) => p.category === "cloud-api");
                applyPreset(firstCloud, firstCloud?.id || "openrouter", "cloud-api");
              } else if (item.id === "subscription") {
                const firstSub = subscriptionPresetOptions[0] || presets["codex-oauth"];
                applyPreset(firstSub, firstSub?.id || "codex-oauth", "subscription");
              } else if (item.id === "cloud-iam") {
                const firstIam = presets["vertex-ai"] || presetList.find((p) => p.category === "cloud-iam");
                applyPreset(firstIam, firstIam?.id || "vertex-ai", "cloud-iam");
              } else if (item.id === "local") {
                const firstLocal = presets.ollama || presetList.find((p) => p.category === "local");
                applyPreset(firstLocal, firstLocal?.id || "ollama", "local");
              }
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="studio-form">
        <label className="studio-field-label">
          <span>Service</span>
          <select
            className="field"
            value={presetId}
            disabled={!privileged}
            onChange={(event) => {
              const nextId = event.target.value;
              if (mode === "local") {
                const localItem = localPresetList.find((item) => item.id === nextId);
                applyPreset(presets[nextId], nextId, "local");
                if (localItem) setBaseUrl(localItem.baseUrl);
                setAllowPrivate(true);
                setMode("local");
                return;
              }
              const found =
                subscriptionPresetOptions.find((item) => item.id === nextId) || presets[nextId];
              applyPreset(found, nextId, mode);
            }}
          >
            {serviceOptions.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="studio-field-label">
            <span>Name</span>
            <input
              className="field"
              value={label}
              disabled={!privileged}
              onChange={(event) => {
                setLabel(event.target.value);
                setUserEditedLabel(true);
              }}
            />
          </label>
          <label className="studio-field-label">
            <span>Protocol</span>
            <select
              className="field"
              value={protocolLabel}
              disabled={!privileged}
              onChange={(event) => setProtocolLabel(event.target.value)}
            >
              <option value="OpenAI compatible">OpenAI compatible</option>
              <option value="Anthropic messages">Anthropic messages</option>
              <option value="Vertex AI">Vertex AI</option>
            </select>
          </label>
        </div>

        {activeDialogProvider?.auth?.hasSecret ? (
          <ConnectedAccountBanner
            provider={activeDialogProvider}
            projects={vertexProjects}
            privileged={privileged}
            onSelectProject={(nextProject) => {
              setVertexProjectId(nextProject);
              void api.studio
                .updateProvider(activeDialogProvider.id, {
                  auth: {
                    mode: activeDialogProvider.auth.mode || "vertex-oauth",
                    clientId:
                      vertexClientId.trim() ||
                      activeDialogProvider.auth.clientId ||
                      DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
                    projectId: nextProject || undefined,
                    location: vertexLocation || "global",
                  },
                })
                .then((res) => {
                  const updated = res.providers.find((p) => p.id === activeDialogProvider.id) || res.provider;
                  setDialogConnectedProvider(updated);
                  const nextProviders = vertexProjects.length
                    ? res.providers.map((p) =>
                        p.id === activeDialogProvider.id && !p.auth.projects?.length
                          ? { ...p, auth: { ...p.auth, projects: vertexProjects } }
                          : p,
                      )
                    : res.providers;
                  onSaved(nextProviders, activeDialogProvider.id);
                  onNotice(`Switched Vertex project to ${nextProject}`);
                })
                .catch((err) => setFormError(errText(err)));
            }}
          />
        ) : null}

        {mode === "cloud-api" ? (
          <div className="studio-field-label">
            <label htmlFor="setup-provider-api-key">API key</label>
            <PasswordInput id="setup-provider-api-key" value={apiKey} onValueChange={setApiKey} disabled={!privileged}>
              <PasswordInputField
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="••••••••••••••••••••••••••••••••••••••••"
                toggleLabel={{ show: "Show API key", hide: "Hide API key" }}
              />
            </PasswordInput>
            <span className="studio-field-hint">Your key stays hidden after saving.</span>
          </div>
        ) : null}

        {mode === "local" ? (
          <label className="studio-field-label">
            <span>Endpoint URL</span>
            <input
              className="field font-mono"
              value={baseUrl}
              disabled={!privileged}
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
        ) : null}

        {mode === "subscription" ? (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5">
            {DEVICE_CODE_PROVIDER_IDS.has(presetId) ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap is-on">Step 1</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!privileged || busy}
                    onClick={() => void startSubscriptionDeviceFlow()}
                  >
                    {deviceButtonLabelFor(presetId)}
                  </Button>
                  {deviceVerifyUri ? (
                    <a
                      href={deviceVerifyUri}
                      target="_blank"
                      rel="noreferrer"
                      className="chip inline-flex items-center text-xs"
                    >
                      Open verification
                    </a>
                  ) : null}
                </div>
                {deviceUserCode ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border bg-background px-3 py-2">
                    <span className="font-mono text-xl font-semibold tracking-[0.18em]">{deviceUserCode}</span>
                    <CopyButton value={deviceUserCode} label="Copy code" />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap">Step 2</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!privileged || busy || !deviceUserCode}
                    onClick={() => void verifySubscriptionDeviceFlow()}
                  >
                    Verify authorization
                  </Button>
                  {devicePolling ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      Polling · {deviceWaited.toFixed(0)}s
                    </span>
                  ) : null}
                </div>
                {presetId === "codex-oauth" ? (
                  <details className="mt-1 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">Browser redirect (PKCE)</summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="cap is-on">Step 1</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!privileged || busy}
                          onClick={() => void startSubscriptionPkce()}
                        >
                          Open Redirect
                        </Button>
                        {subLoginUrl ? (
                          <>
                            <a
                              href={subLoginUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="chip inline-flex items-center text-xs"
                            >
                              Open sign-in link
                            </a>
                            <CopyButton value={subLoginUrl} label="Copy link" />
                          </>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="cap">Step 2</span>
                        <input
                          className="field flex-1 font-mono"
                          aria-label="Callback URL or code"
                          value={subCodeOrUrl}
                          disabled={!privileged}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Callback URL or code"
                          onChange={(event) => setSubCodeOrUrl(event.target.value)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!privileged || busy || !subCodeOrUrl.trim()}
                          onClick={() => void completeSubscriptionPkce()}
                        >
                          Connect
                        </Button>
                      </div>
                    </div>
                  </details>
                ) : null}
              </>
            ) : presetId === "claude-oauth" ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap is-on">Step 1</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!privileged || busy}
                    onClick={() => void startSubscriptionPkce()}
                  >
                    Open Claude Sign-In
                  </Button>
                  {subLoginUrl ? (
                    <>
                      <a
                        href={subLoginUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="chip inline-flex items-center text-xs"
                      >
                        Open sign-in link
                      </a>
                      <CopyButton value={subLoginUrl} label="Copy link" />
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap">Step 2</span>
                  <input
                    className="field flex-1 font-mono"
                    aria-label="Claude authorization code or setup token"
                    value={subCodeOrUrl}
                    disabled={!privileged}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="code#state or sk-ant-oat01-..."
                    onChange={(event) => setSubCodeOrUrl(event.target.value)}
                  />
                </div>
              </>
            ) : (
              <>
                <label className="studio-field-label">
                  <span>Proxy Base URL</span>
                  <input
                    className="field font-mono"
                    value={baseUrl}
                    disabled={!privileged}
                    spellCheck={false}
                    placeholder="http://127.0.0.1:8317/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
                <div className="studio-field-label">
                  <label htmlFor="setup-bridge-token">Bearer token (optional)</label>
                  <PasswordInput id="setup-bridge-token" value={apiKey} onValueChange={setApiKey} disabled={!privileged}>
                    <PasswordInputField
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Optional token"
                      toggleLabel={{ show: "Show token", hide: "Hide token" }}
                    />
                  </PasswordInput>
                </div>
              </>
            )}
          </div>
        ) : null}

        {mode === "cloud-iam" ? (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-muted-foreground">Vertex AI Credentials</span>
              <div className="flex flex-wrap gap-1" role="tablist" aria-label="Vertex sign-in method">
                <button
                  type="button"
                  role="tab"
                  className={cn("chip", vertexMode === "vertex-oauth" && "is-on")}
                  aria-selected={vertexMode === "vertex-oauth"}
                  onClick={() => setVertexMode("vertex-oauth")}
                >
                  Google OAuth
                </button>
                <button
                  type="button"
                  role="tab"
                  className={cn("chip", vertexMode === "vertex-service-account" && "is-on")}
                  aria-selected={vertexMode === "vertex-service-account"}
                  onClick={() => setVertexMode("vertex-service-account")}
                >
                  Service Account (.json)
                </button>
              </div>
            </div>
            {vertexMode === "vertex-service-account" ? (
              <div>
                <Dropzone
                  accept={{ "application/json": [".json"] }}
                  maxFiles={1}
                  maxSize={64 * 1024}
                  aria-label="Vertex service account JSON"
                  onDrop={(files, rejections) => {
                    if (rejections && rejections.length > 0) {
                      setSa(null);
                      setSaError("Rejected file: must be a .json file under 64 KB");
                      return;
                    }
                    const file = files[0];
                    if (!file) return;
                    void readServiceAccount(file).then((result) => {
                      if ("error" in result) {
                        setSa(null);
                        setSaError(result.error);
                        return;
                      }
                      setSa(result);
                      setVertexProjectId(result.projectId);
                      setSaError("");
                    });
                  }}
                >
                  <DropzoneEmptyState title="Drop .json key" description="Max 64 KB" />
                  <DropzoneContent />
                </Dropzone>
                {sa ? <p className="mt-2 font-mono text-xs text-success">{sa.clientEmail} · {sa.projectId}</p> : null}
                {saError ? <p className="mt-2 text-xs text-destructive" role="alert">{saError}</p> : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap is-on">Step 1</span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!privileged || busy}
                    onClick={() => void startGoogleSignIn()}
                  >
                    Sign in with Google
                  </Button>
                  {vertexLoginUrl ? (
                    <>
                      <a
                        href={vertexLoginUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="chip inline-flex items-center text-xs"
                      >
                        Open sign-in link
                      </a>
                      <CopyButton value={vertexLoginUrl} label="Copy link" />
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap">Step 2</span>
                  <input
                    className="field flex-1 font-mono"
                    aria-label="Google verification code"
                    value={vertexOauthToken}
                    disabled={!privileged}
                    placeholder="Paste 4/0A... verification code"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setVertexOauthToken(event.target.value)}
                  />
                </div>
              </div>
            )}
          </div>
        ) : null}

        <details className="studio-accordion">
          <summary>
            <span>Advanced connection settings</span>
            <span className="studio-accordion-icon" aria-hidden />
          </summary>
          <div className="studio-accordion-body">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="studio-field-label">
                <span>Provider ID</span>
                <input
                  className="field font-mono"
                  value={id}
                  disabled={!privileged || Boolean(editing)}
                  onChange={(event) => {
                    setId(event.target.value);
                    setUserEditedId(true);
                  }}
                />
              </label>
              <label className="studio-field-label">
                <span>Base URL</span>
                <input
                  className="field font-mono"
                  value={baseUrl}
                  disabled={!privileged}
                  spellCheck={false}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
            </div>
            {mode === "cloud-iam" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="studio-field-label">
                  <span>Location</span>
                  <select
                    className="field font-mono"
                    value={vertexLocation}
                    disabled={!privileged}
                    onChange={(event) => setVertexLocation(event.target.value)}
                  >
                    {VERTEX_LOCATIONS.map((loc) => (
                      <option key={loc} value={loc}>
                        {loc}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="studio-field-label">
                  <span>GCP Project ID</span>
                  <input
                    className="field font-mono"
                    value={vertexProjectId}
                    disabled={!privileged}
                    placeholder="Auto-detected on sign-in"
                    onChange={(event) => setVertexProjectId(event.target.value)}
                  />
                </label>
                <label className="studio-field-label sm:col-span-2">
                  <span>Google OAuth Client ID</span>
                  <input
                    className="field font-mono"
                    value={vertexClientId}
                    disabled={!privileged}
                    placeholder={DEFAULT_GOOGLE_OAUTH_CLIENT_ID}
                    onChange={(event) => setVertexClientId(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
            <label className="studio-field-label">
              <span>Custom headers JSON</span>
              <textarea
                className="field font-mono"
                value={headersText}
                disabled={!privileged}
                onChange={(event) => setHeadersText(event.target.value)}
                placeholder='{"HTTP-Referer":"https://example.com"}'
              />
            </label>
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={routeStages}
                  disabled={!privileged}
                  onChange={(event) => setRouteStages(event.target.checked)}
                />
                <span>Auto-route stages on verify</span>
              </label>
              <label className="inline-flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={allowPrivate}
                  disabled={!privileged}
                  onChange={(event) => setAllowPrivate(event.target.checked)}
                />
                <span>Allow private network</span>
              </label>
            </div>
          </div>
        </details>

        {formError ? (
          <p className="text-xs font-medium text-destructive" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="studio-cta-row">
          <button
            type="button"
            className="studio-primary-btn"
            disabled={!privileged || busy}
            onClick={() => void submit()}
          >
            <span>{ctaLabel}</span>
            <ArrowRight className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className="studio-cancel-btn"
            onClick={() => {
              applyPreset(presets.openrouter || presets.openai, "openrouter", "cloud-api");
              setApiKey("");
              onCancel();
            }}
          >
            Cancel
          </button>
          <span className="studio-cta-note">Models and routing come next.</span>
        </div>

        <div className="studio-info-bar">
          <span className="inline-flex items-center gap-2">
            <Info className="size-4 shrink-0 opacity-75" aria-hidden />
            <span>
              {routeStages
                ? "Stage routing will update after verification."
                : "No routing changes until you confirm."}
            </span>
          </span>
        </div>
      </div>

      <div className="studio-pane-footer">
        <span>New connection</span>
        <span>{editing ? `${editing.label} · ${editing.id}` : `Unsaved connection · ${id}`}</span>
      </div>
    </>
  );
}

export function RoutingTab({
  providers,
  stages,
  privileged,
  onProvidersChange,
  onSaved,
  onReload,
  onNotice,
}: {
  providers: ProviderView[];
  stages: StagesState | null;
  privileged: boolean;
  onProvidersChange?: (providers: ProviderView[]) => void;
  onSaved: (stages: StagesState) => void;
  onReload?: () => Promise<StagesState | void> | void;
  onNotice: OnNotice;
}) {
  const [drafts, setDrafts] = useState<Record<UiStage, StageDraft>>(() => initialDrafts(stages));
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);

  useEffect(() => {
    setDrafts(initialDrafts(stages));
    setConflict(false);
  }, [stages]);

  async function reloadServerSettings() {
    try {
      const fresh = (await onReload?.()) || (await api.studio.stages());
      onSaved(fresh);
      setDrafts(initialDrafts(fresh));
      setConflict(false);
      onNotice(`Reloaded server routing · revision ${fresh.revision}.`);
    } catch (error) {
      onNotice(errText(error), "danger");
    }
  }

  async function syncLiveModels() {
    if (!privileged || syncingModels) return;
    const enabled = providers.filter((p) => p.enabled !== false);
    if (enabled.length === 0) {
      onNotice("No enabled providers to sync /models from.");
      return;
    }
    setSyncingModels(true);
    try {
      let total = 0;
      let count = 0;
      for (const p of enabled) {
        try {
          const res = await api.studio.discoverModels(p.id, true);
          total += res.models.length;
          count += 1;
        } catch {
          /* continue with remaining providers */
        }
      }
      const fresh = await api.studio.providers();
      onProvidersChange?.(fresh.providers);
      onNotice(`Synced ${total} models from /models across ${count}/${enabled.length} providers.`);
    } catch (error) {
      onNotice(errText(error), "danger");
    } finally {
      setSyncingModels(false);
    }
  }

  function patch(stage: UiStage, next: Partial<StageDraft>) {
    setDrafts((current) => ({ ...current, [stage]: { ...current[stage], ...next } }));
  }

  function move(stage: UiStage, id: string, dir: -1 | 1 | "primary") {
    setDrafts((current) => {
      const draft = current[stage];
      const chain = [...draft.chain];
      const index = chain.indexOf(id);
      if (index < 0) return current;
      if (dir === "primary") {
        chain.splice(index, 1);
        chain.unshift(id);
      } else {
        const target = index + dir;
        if (target < 0 || target >= chain.length) return current;
        const [item] = chain.splice(index, 1);
        chain.splice(target, 0, item!);
      }
      return { ...current, [stage]: { ...draft, chain } };
    });
  }

  function onKey(event: KeyboardEvent<HTMLElement>, stage: UiStage) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const row = (event.target as HTMLElement).closest("[data-model-lane]");
    const id = row?.getAttribute("data-model-lane");
    if (!id) return;
    event.preventDefault();
    const dir = event.key === "ArrowUp" ? "up" : "down";
    move(stage, id, event.key === "ArrowUp" ? -1 : 1);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-model-lane="${CSS.escape(id)}"] [data-stage-move="${dir}"]`)?.focus();
    });
  }

  async function save() {
    if (!stages) return;
    setSaving(true);
    try {
      const payload: Record<string, Partial<StageRoute>> = {};
      for (const stage of ["reader", "matcher", "writer", "scout", "fact_check"] as const) {
        const draft = drafts[stage];
        const inherited = (stage === "matcher" || stage === "scout") && draft.inheritFrom === "reader";
        const chain = inherited ? drafts.reader.chain : draft.chain;
        payload[stage] = {
          stage: stage as StageId,
          chain,
          primary: chain[0] ?? null,
          fallbacks: chain.slice(1),
          concurrency: draft.concurrency,
          temperature: draft.temperature,
          inheritFrom: inherited ? "reader" : null,
          llmVerify: stage === "fact_check" ? draft.llmVerify : undefined,
        };
      }
      const saved = await api.studio.putStages({ revision: stages.revision, stages: payload });
      onSaved(saved);
      setConflict(false);
      onNotice(`Routing saved · revision ${saved.revision}. Paid chapter caches stay put.`);
    } catch (error) {
      if (isConflict(error)) setConflict(true);
      onNotice(errText(error), "danger");
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    setDrafts(initialDrafts(null));
    setConflict(false);
    onNotice("Reset stage routing draft to defaults.");
  }

  return (
    <div className="flex flex-col gap-4">
      {conflict ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-destructive-soft px-3 py-2 text-sm">
          <span>Revision conflict</span>
          <span className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setConflict(false)}>Keep draft</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void reloadServerSettings()}>Reload</Button>
          </span>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 md:min-h-8"
          disabled={!privileged || syncingModels || providers.length === 0}
          onClick={() => void syncLiveModels()}
        >
          <RotateCcw className={cn("size-3.5", syncingModels && "animate-spin")} />
          {syncingModels ? "Syncing…" : "Sync"}
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-8" disabled={!privileged} onClick={() => {
          patch("matcher", { inheritFrom: "reader" });
          patch("scout", { inheritFrom: "reader" });
        }}>
          Link vision
        </Button>
        <Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-8" disabled={!privileged} onClick={resetToDefaults}>
          Reset
        </Button>
        <Button type="button" className="min-h-11 md:min-h-8" disabled={!privileged || saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      <div className="studio-routing-grid">
        {STAGE_META.map((meta) => {
          const draft = drafts[meta.id];
          const inherited = (meta.id === "matcher" || meta.id === "scout") && draft.inheritFrom === "reader";
          return (
            <section key={meta.id} className="desk-card studio-stage" aria-labelledby={`stage-${meta.id}`} onKeyDown={(event) => onKey(event, meta.id)}>
              <header className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h3 id={`stage-${meta.id}`} className="text-xl font-semibold tracking-[-0.01em]">
                    {meta.title}
                  </h3>
                  <span className="cap font-mono">{draft.chain.length}</span>
                </div>
                <span className="cap is-on">{meta.gate === "vision" ? "Vision" : "Text"}</span>
              </header>
              {inherited ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="cap is-on">Linked to Reader ({drafts.reader.chain.length})</span>
                  <Button type="button" size="sm" variant="outline" disabled={!privileged} className="min-h-11 md:min-h-8" onClick={() => patch(meta.id, { inheritFrom: null, chain: [...drafts.reader.chain] })}>
                    Customize
                  </Button>
                </div>
              ) : (
                <>
                  {meta.id === "matcher" || meta.id === "scout" ? (
                    <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={draft.inheritFrom === "reader"}
                        disabled={!privileged}
                        onChange={(event) => {
                          if (event.target.checked) patch(meta.id, { inheritFrom: "reader" });
                          else patch(meta.id, { inheritFrom: null, chain: [...drafts.reader.chain] });
                        }}
                      />
                      Link to Reader
                    </label>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <ParameterSlider
                      min={0}
                      max={2}
                      step={0.1}
                      value={draft.temperature}
                      resetValue={emptyDraft(meta.id).temperature}
                      disabled={!privileged}
                      onValueChange={(temperature) => patch(meta.id, { temperature })}
                      className="min-w-48 flex-1"
                    >
                      <ParameterSliderHeader>
                        <ParameterSliderLabel>Temperature</ParameterSliderLabel>
                        <ParameterSliderReset />
                        <ParameterSliderInput />
                      </ParameterSliderHeader>
                      <ParameterSliderControl />
                    </ParameterSlider>
                    <IntStepper
                      label="Concurrency"
                      value={draft.concurrency}
                      min={1}
                      max={4}
                      step={1}
                      disabled={!privileged}
                      onChange={(concurrency) => patch(meta.id, { concurrency })}
                    />
                  </div>
                  {meta.id === "fact_check" ? (
                    <label className="mt-3 flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.llmVerify} disabled={!privileged} onChange={(event) => patch("fact_check", { llmVerify: event.target.checked })} />
                      {draft.llmVerify ? "Deterministic + LLM verify pass" : "Deterministic only (free)"}
                    </label>
                  ) : null}
                  <Sortable value={draft.chain} onValueChange={(chain) => patch(meta.id, { chain })} disabled={!privileged} className="mt-3">
                    {draft.chain.map((lane, index) => {
                      const parsedLane = splitStageModelRef(lane, providers);
                      return (
                        <SortableItem key={lane} value={lane} disabled={!privileged} className="desk-row" data-model-lane={lane}>
                          <SortableHandle />
                          <span className={cn("rank", index === 0 && "is-primary")}>{index === 0 ? "Primary" : `Fallback ${index}`}</span>
                          <span className="studio-lane-model min-w-0 flex-1 font-mono text-xs" title={parsedLane.modelId}>{parsedLane.modelId}</span>
                          {parsedLane.providerLabel ? (
                            <span className="cap">{parsedLane.providerLabel}</span>
                          ) : null}
                          <span className="flex gap-1">
                            <button type="button" className="mini" data-stage-move="up" aria-label="Move up" disabled={!privileged} onClick={() => move(meta.id, lane, -1)}>↑</button>
                            <button type="button" className="mini" data-stage-move="down" aria-label="Move down" disabled={!privileged} onClick={() => move(meta.id, lane, 1)}>↓</button>
                            <button type="button" className="mini" data-stage-move="primary" aria-label="Make primary" disabled={!privileged} onClick={() => move(meta.id, lane, "primary")}>1st</button>
                            <button type="button" className="mini" aria-label="Remove from chain" disabled={!privileged} onClick={() => patch(meta.id, { chain: draft.chain.filter((item) => item !== lane) })}>×</button>
                          </span>
                        </SortableItem>
                      );
                    })}
                  </Sortable>
                  <div className="mt-3">
                    <StagePicker
                      stage={meta.id}
                      providers={providers}
                      disabled={!privileged}
                      onPick={(lane) => {
                        if (draft.chain.includes(lane)) return;
                        patch(meta.id, { chain: [...draft.chain, lane] });
                      }}
                    />
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function initialDrafts(stages: StagesState | null): Record<UiStage, StageDraft> {
  return {
    reader: stages ? draftFrom(stages.reader) : emptyDraft("reader"),
    matcher: stages ? draftFrom(stages.matcher) : emptyDraft("matcher"),
    writer: stages ? draftFrom(stages.writer) : emptyDraft("writer"),
    scout: stages ? draftFrom(stages.scout) : emptyDraft("scout"),
    fact_check: stages ? draftFrom(stages.fact_check) : emptyDraft("fact_check"),
  };
}

function StagePicker({
  stage,
  providers,
  disabled,
  onPick,
}: {
  stage: UiStage;
  providers: ProviderView[];
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const models = useMemo<ModelOption[]>(() => {
    const needVision = stage === "reader" || stage === "matcher" || stage === "scout";
    return providers.flatMap((provider) =>
      provider.models.map((model) => {
        const vision = Boolean(model.capabilities?.vision);
        const cleanId = stripProviderPrefixUi(model.id, provider.id);
        const cleanLabel = stripProviderPrefixUi(model.label || model.id, provider.id);
        return {
          id: `${provider.id}:${cleanId}`,
          name: cleanId,
          provider: formatProviderConnectionLabel(provider, providers),
          description: needVision && !vision
            ? "Incompatible (requires vision)"
            : [cleanLabel !== cleanId ? cleanLabel : "", vision ? "Vision" : "Text", model.capabilities?.json ? "JSON" : ""].filter(Boolean).join(" · "),
          capabilities: [
            ...(vision ? ["vision" as const] : []),
            ...(model.capabilities?.reasoning ? ["reasoning" as const] : []),
          ],
          contextWindow: model.contextWindow,
          disabled: needVision && !vision,
        };
      }),
    );
  }, [providers, stage]);

  return (
    <ModelSelector
      models={models}
      value=""
      disabled={disabled}
      labels={{ placeholder: `Add model to ${stage}`, search: "Search models", empty: "No compatible model" }}
      onValueChange={(id, model) => {
        if (!model || model.disabled) return;
        onPick(id);
      }}
    />
  );
}

function normalizeDefaultLaneId(raw: unknown): string {
  const val = String(raw ?? "").trim();
  return LANE_ID_RE.test(val.toLowerCase()) ? val : DEFAULT_LANE_ID;
}

function readSettingsQuality(settings: StudioSettingsState | null | undefined): RenderQuality {
  const q = settings?.renderQuality || settings?.settings?.renderQuality;
  return q === "720p" ? "720p" : "1080p";
}

function readSettingsDefaultLane(settings: StudioSettingsState | null | undefined): string {
  const raw = settings?.defaultRenderLane ?? settings?.settings?.defaultRenderLane;
  return normalizeDefaultLaneId(raw || DEFAULT_LANE_ID);
}

function resolveSandboxLifecycleState(
  worker?: PipelineWorker,
  overrideBoxStatus?: string | null,
): "running" | "stopped" | "unknown" {
  const rawBox = String(overrideBoxStatus ?? worker?.boxStatus ?? "").trim().toLowerCase();
  if (rawBox) {
    if (["running", "ready", "busy", "active", "started", "online"].includes(rawBox)) return "running";
    if (["stopped", "paused", "exited", "off", "halted", "down", "created"].includes(rawBox)) return "stopped";
    return "unknown";
  }
  const rawWorkerStatus = String(worker?.status ?? "").trim().toLowerCase();
  if (rawWorkerStatus === "busy" || rawWorkerStatus === "running") return "running";
  if (rawWorkerStatus === "paused" || rawWorkerStatus === "stopped") return "stopped";
  return "unknown";
}

export function NodesTab({
  system,
  nodes,
  workers,
  privileged,
  settings,
  onSettingsSaved,
  onChange,
  onRefreshWorkers,
  onNotice,
}: {
  system: PipelineStatus["system"] | null;
  nodes: RenderNode[];
  workers: PipelineWorker[];
  privileged: boolean;
  settings: StudioSettingsState | null;
  onSettingsSaved: (settings: StudioSettingsState) => void;
  onChange: (nodes: RenderNode[]) => void;
  onRefreshWorkers?: () => Promise<void> | void;
  onNotice: OnNotice;
}) {
  const [editing, setEditing] = useState<RenderNode | null>(null);
  const [open, setOpen] = useState(false);
  const [openDetails, setOpenDetails] = useState<Record<string, boolean>>({});
  const [boxStatusOverrides, setBoxStatusOverrides] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<string[]>(["sbx console ready"]);
  const [renderQuality, setRenderQuality] = useState<RenderQuality>(() => readSettingsQuality(settings));
  const [defaultRenderLane, setDefaultRenderLane] = useState<string>(() => readSettingsDefaultLane(settings));
  const [autoRetry, setAutoRetry] = useState(() => settings?.autoRetry ?? settings?.settings?.autoRetry ?? { enabled: true, maxRetries: 3 });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsNote, setSettingsNote] = useState<string>("");
  const savingSettingsRef = useRef(false);
  const nodeActionLockRef = useRef(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [storage, setStorage] = useState<StudioStorageReport | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busyNodeKey, setBusyNodeKey] = useState<string>("");
  const [sbxDeviceLink, setSbxDeviceLink] = useState<{
    nodeId: string;
    verificationUrl: string | null;
    userCode: string | null;
    detail: string;
  } | null>(null);

  useEffect(() => {
    if (savingSettingsRef.current) return;
    setRenderQuality(readSettingsQuality(settings));
    setDefaultRenderLane(readSettingsDefaultLane(settings));
    setAutoRetry(settings?.autoRetry ?? settings?.settings?.autoRetry ?? { enabled: true, maxRetries: 3 });
  }, [settings]);

  useEffect(() => {
    if (!sbxDeviceLink) return;
    const targetNodeId = sbxDeviceLink.nodeId;
    const timer = window.setInterval(() => {
      void api.studio.sbxAuthStatus().then((res) => {
        if (res.authenticated) {
          if (targetNodeId) {
            setNodeOutputs((current) => ({ ...current, [targetNodeId]: { ok: true, text: res.detail } }));
          }
          setSbxDeviceLink(null);
          log(`ok  ${res.detail}`);
          onNotice("Docker account linked");
        }
      }).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [sbxDeviceLink, onNotice]);

  const handleStorageStateLoaded = useCallback((rep: StudioStorageReport | null, list: TrashItem[]) => {
    if (rep) setStorage(rep);
    setTrash(list);
  }, []);

  async function saveRenderDefaults(patch: { renderQuality?: RenderQuality; defaultRenderLane?: string; autoRetry?: { enabled: boolean; maxRetries: number } }) {
    if (!privileged || savingSettingsRef.current) return;
    const prevQuality = renderQuality;
    const prevLane = defaultRenderLane;
    const prevRetry = autoRetry;
    const nextQuality = patch.renderQuality ?? renderQuality;
    const nextLane = patch.defaultRenderLane ?? defaultRenderLane;
    if (nextQuality === prevQuality && nextLane === prevLane && !patch.autoRetry) return;

    savingSettingsRef.current = true;
    setSavingSettings(true);
    if (patch.renderQuality !== undefined) setRenderQuality(patch.renderQuality);
    if (patch.defaultRenderLane !== undefined) setDefaultRenderLane(patch.defaultRenderLane);
    if (patch.autoRetry) setAutoRetry(patch.autoRetry);
    setSettingsNote("Saving…");

    const currentRevision = typeof settings?.revision === "number" ? settings.revision : undefined;
    const payload: {
      autoRetry?: { enabled: boolean; maxRetries: number };
      renderQuality?: RenderQuality;
      defaultRenderLane?: string;
      revision?: number;
      expectedRevision?: number;
    } = {
      ...(patch.autoRetry ? { autoRetry: patch.autoRetry } : {}),
      ...(patch.renderQuality !== undefined ? { renderQuality: patch.renderQuality } : {}),
      ...(patch.defaultRenderLane !== undefined ? { defaultRenderLane: patch.defaultRenderLane } : {}),
      ...(currentRevision !== undefined ? { revision: currentRevision, expectedRevision: currentRevision } : {}),
    };
    try {
      const saved = await api.studio.putSettings(payload);
      const returnedLane = saved?.defaultRenderLane ?? saved?.settings?.defaultRenderLane;
      if (patch.defaultRenderLane !== undefined && typeof returnedLane !== "string") {
        setDefaultRenderLane(prevLane);
        setSettingsNote("Save failed");
        onNotice("Server did not persist default render lane.", "danger");
        return;
      }
      onSettingsSaved(saved);
      setAutoRetry(saved.autoRetry ?? saved.settings?.autoRetry ?? patch.autoRetry ?? prevRetry);
      setRenderQuality(readSettingsQuality(saved));
      if (typeof returnedLane === "string") {
        setDefaultRenderLane(readSettingsDefaultLane(saved));
      }
      setSettingsNote("Saved");
    } catch (error) {
      setRenderQuality(prevQuality);
      setDefaultRenderLane(prevLane);
      setAutoRetry(prevRetry);
      setSettingsNote("Save failed");
      if (isConflict(error)) {
        const fresh = await api.studio.getSettings().catch(() => null);
        if (fresh) {
          onSettingsSaved(fresh);
          setRenderQuality(readSettingsQuality(fresh));
          setDefaultRenderLane(readSettingsDefaultLane(fresh));
          setAutoRetry(fresh.autoRetry ?? fresh.settings?.autoRetry ?? prevRetry);
        }
      }
      onNotice(errText(error), "danger");
    } finally {
      savingSettingsRef.current = false;
      setSavingSettings(false);
    }
  }

  function log(line: string) {
    setLines((current) => [...current.slice(-80), line]);
  }

  function ensureDetailsOpen(nodeId: string) {
    setOpenDetails((current) => (current[nodeId] ? current : { ...current, [nodeId]: true }));
  }

  async function run(
    id: string,
    action: "test" | "status" | "start" | "pause" | "stop" | "provision" | "auth-status" | "auth-start",
  ) {
    if (nodeActionLockRef.current) return;
    nodeActionLockRef.current = true;
    log(`$ ${action} ${id}`);
    setBusyNodeKey(`${id}:${action}`);
    ensureDetailsOpen(id);
    try {
      if (action === "test") {
        const probe = await api.studio.testNode(id);
        const text = probe.ok ? `Connected · ${probe.reason}` : probe.reason;
        log(probe.ok ? `ok  ${probe.reason}` : `fail  ${probe.reason}`);
        setNodeOutputs((current) => ({ ...current, [id]: { ok: probe.ok, text } }));
        await onRefreshWorkers?.();
        return;
      }
      if (action === "auth-status" || action === "auth-start") {
        if (action === "auth-status") {
          const statusRes = await api.studio.nodeAction(id, "auth-status");
          if (statusRes.ok) {
            setSbxDeviceLink(null);
            log(`ok  ${statusRes.detail}`);
            setNodeOutputs((current) => ({ ...current, [id]: { ok: true, text: statusRes.detail } }));
            await onRefreshWorkers?.();
            return;
          }
          log(`info  ${statusRes.detail}`);
          if (statusRes.status === "missing-cli") {
            setSbxDeviceLink(null);
            setNodeOutputs((current) => ({ ...current, [id]: { ok: false, text: statusRes.detail } }));
            return;
          }
        }
        const started = await api.studio.sbxAuthStart();
        if (started.authenticated) {
          setSbxDeviceLink(null);
          log(`ok  ${started.detail}`);
          setNodeOutputs((current) => ({ ...current, [id]: { ok: true, text: started.detail } }));
          await onRefreshWorkers?.();
          return;
        }
        const validUrl = normalizeHttpUrl(started.verificationUrl);
        const code = typeof started.userCode === "string" && started.userCode.trim() ? started.userCode.trim() : null;
        setSbxDeviceLink({
          nodeId: id,
          verificationUrl: validUrl,
          userCode: code,
          detail: started.detail || "Complete Docker sign-in in your browser.",
        });
        setNodeOutputs((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        log(`info  code=${code ?? "—"} url=${validUrl ?? "pending"}`);
        return;
      }
      const result = await api.studio.nodeAction(id, action);
      log(result.ok ? `ok  ${result.detail}` : `fail  ${result.detail}`);
      setNodeOutputs((current) => ({ ...current, [id]: { ok: result.ok, text: result.detail } }));
      if (result.ok) {
        const probeBox = typeof result.probe?.boxStatus === "string" ? result.probe.boxStatus : result.status;
        if (action === "start") {
          setBoxStatusOverrides((current) => ({ ...current, [id]: probeBox || "running" }));
        } else if (action === "stop" || action === "pause") {
          setBoxStatusOverrides((current) => ({ ...current, [id]: probeBox || "stopped" }));
        } else if (probeBox) {
          setBoxStatusOverrides((current) => ({ ...current, [id]: probeBox }));
        }
      }
      await onRefreshWorkers?.();
    } catch (error) {
      const msg = errText(error);
      log(`fail  ${msg}`);
      setNodeOutputs((current) => ({ ...current, [id]: { ok: false, text: msg } }));
    } finally {
      nodeActionLockRef.current = false;
      setBusyNodeKey("");
    }
  }

  const enabledNodes = useMemo(() => nodes.filter((n) => n.enabled !== false), [nodes]);
  const missingOrDisabledDefaultNode = useMemo(() => {
    if (!defaultRenderLane || defaultRenderLane === DEFAULT_LANE_ID) return null;
    if (enabledNodes.some((n) => n.id === defaultRenderLane)) return null;
    const disabledMatch = nodes.find((n) => n.id === defaultRenderLane);
    return {
      id: defaultRenderLane,
      label: disabledMatch
        ? `${disabledMatch.label || disabledMatch.id} (disabled)`
        : `${defaultRenderLane} (unavailable)`,
    };
  }, [defaultRenderLane, enabledNodes, nodes]);

  return (
    <div className="flex flex-col gap-4">
      <div className="desk-card flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Default quality">
            <span className="whitespace-nowrap text-xs text-muted-foreground">Default quality</span>
            {(["1080p", "720p"] as const).map((q) => (
              <button
                key={q}
                type="button"
                role="radio"
                aria-checked={renderQuality === q}
                className={cn("chip min-h-11 md:min-h-8", renderQuality === q && "is-on")}
                disabled={!privileged || savingSettings}
                onClick={() => void saveRenderDefaults({ renderQuality: q })}
              >
                {q}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="studioDefaultLane">
            <span className="whitespace-nowrap">Default lane</span>
            <select
              id="studioDefaultLane"
              aria-label="Default lane"
              className="field min-h-11 w-auto px-2.5 py-1 text-xs md:min-h-8"
              value={defaultRenderLane}
              disabled={!privileged || savingSettings}
              onChange={(event) => void saveRenderDefaults({ defaultRenderLane: event.target.value })}
            >
              <option value={DEFAULT_LANE_ID}>Auto</option>
              {enabledNodes.map((node) => (
                <option key={node.id} value={node.id}>
                  {conciseNodeLabel(node.label, node.kind, node.id)}
                </option>
              ))}
              {missingOrDisabledDefaultNode ? (
                <option value={missingOrDisabledDefaultNode.id} disabled>
                  {missingOrDisabledDefaultNode.label}
                </option>
              ) : null}
            </select>
          </label>
          <div className="flex min-h-11 items-center gap-3 text-xs text-muted-foreground">
            <span id="autoRetryLabel">Auto-retry</span>
            <button type="button" role="switch" aria-labelledby="autoRetryLabel" aria-checked={autoRetry.enabled}
              disabled={!privileged || savingSettings}
              className="flex min-h-11 min-w-11 items-center justify-center disabled:opacity-50"
              onClick={() => void saveRenderDefaults({ autoRetry: { ...autoRetry, enabled: !autoRetry.enabled } })}>
              <span className={cn("flex h-6 w-10 items-center rounded-full p-0.5 transition-colors", autoRetry.enabled ? "bg-primary" : "bg-border-strong")}>
                <span className={cn("size-5 rounded-full bg-primary-foreground transition-transform motion-reduce:transition-none", autoRetry.enabled && "translate-x-4")} />
              </span>
            </button>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground" htmlFor="autoRetryAttempts">
            Attempts
            <select id="autoRetryAttempts" className="field min-h-11 w-auto px-3 text-xs" value={autoRetry.maxRetries}
              disabled={!privileged || savingSettings || !autoRetry.enabled}
              onChange={(event) => void saveRenderDefaults({ autoRetry: { ...autoRetry, maxRetries: Number(event.target.value) } })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <span className="text-[12px] text-muted-foreground" role="status" aria-live="polite">
            {savingSettings ? "Saving…" : settingsNote || "Saved"}
          </span>
          <div className="flex items-center gap-2">
            <span className="cap font-mono">
              <HardDrive className="size-3.5" aria-hidden /> Storage {fmtStorageBytes(storage?.totalBytes)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => setStorageOpen(true)}
            >
              Trash ({trash.length})
            </Button>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          className="min-h-11 md:min-h-8"
          disabled={!privileged}
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          + Add node
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {nodes.map((node) => {
          const worker = workers.find((item) => item.id === node.id);
          const kindMeta = getRenderKindMeta(node.kind, node.id);
          const primaryLabel = conciseNodeLabel(node.label, node.kind, node.id);
          const showKindBadge = !primaryLabel.trim().toLowerCase().includes(kindMeta.shortLabel.trim().toLowerCase());
          const local = node.kind === "local";
          const load = local
            ? system?.cpuPercent != null
              ? system.cpuPercent / 100
              : null
            : typeof worker?.metrics?.load === "number" && worker.metrics.cpus
              ? Math.min(1, worker.metrics.load / worker.metrics.cpus)
              : null;
          const memPressure = local
            ? system?.memory?.available != null && system.memory.total
              ? 1 - system.memory.available / system.memory.total
              : null
            : null;
          const diskPressure = local
            ? system?.disk?.available != null && system.disk.total
              ? 1 - system.disk.available / system.disk.total
              : null
            : null;
          const cpuText = local
            ? system?.cpuPercent != null
              ? `${Math.round(system.cpuPercent)}%`
              : "Unknown"
            : worker?.metrics?.load != null
              ? String(worker.metrics.load)
              : "Unknown";
          const ramText = local
            ? system?.memory?.available != null
              ? `${fmtStorageBytes(system.memory.available)} free`
              : "Unknown"
            : worker?.metrics?.mem_gb != null
              ? `${worker.metrics.mem_gb} GB free`
              : "Unknown";
          const diskText = local
            ? system?.disk?.available != null
              ? `${fmtStorageBytes(system.disk.available)} free`
              : "Unknown"
            : worker?.metrics?.disk_gb != null
              ? `${worker.metrics.disk_gb} GB free`
              : "Unknown";
          const sandboxState =
            node.kind === "docker-sbx"
              ? resolveSandboxLifecycleState(worker, boxStatusOverrides[node.id])
              : "unknown";
          const detailsExpanded = Boolean(openDetails[node.id]);
          const nodeSbxLink = sbxDeviceLink?.nodeId === node.id ? sbxDeviceLink : null;
          const validSbxUrl = normalizeHttpUrl(nodeSbxLink?.verificationUrl);
          const statusBadgeText =
            node.kind === "docker-sbx" && (boxStatusOverrides[node.id] || worker?.boxStatus)
              ? String(boxStatusOverrides[node.id] || worker?.boxStatus)
              : worker?.status || (node.enabled ? "Ready" : "Off");

          return (
            <article key={node.id} className="desk-card studio-node" data-node-id={node.id}>
              <div className="flex items-center gap-3">
                <span className="mono-mark" aria-hidden>
                  {node.kind === "local" ? <Monitor className="size-4" /> : node.kind === "ssh" ? <Radio className="size-4" /> : <Cloud className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-semibold tracking-[-0.01em] leading-tight">{primaryLabel}</h3>
                </div>
                {showKindBadge ? <span className="cap font-mono text-[12px]">{kindMeta.shortLabel}</span> : null}
                <span className="cap">{statusBadgeText}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-background px-3 py-2 text-xs" aria-label={`${primaryLabel} telemetry`}>
                <div>
                  <dt className="text-[12.5px] text-muted-foreground">Slots</dt>
                  <dd className="mt-0.5 font-mono text-foreground">{node.slots}</dd>
                </div>
                <div>
                  <dt className="text-[12.5px] text-muted-foreground">{node.kind === "docker-sbx" ? "TTL" : "Cleaner"}</dt>
                  <dd className="mt-0.5 font-mono text-foreground">{node.kind === "docker-sbx" ? `${node.maxHours ?? 5}h` : node.supportsCleaner ? "On" : "Off"}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-col gap-2">
                <MeterRow label="CPU load" level={load} text={cpuText} />
                <MeterRow label="RAM free" level={memPressure} text={ramText} />
                <MeterRow label="Disk free" level={diskPressure} text={diskText} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {node.id !== "local" && node.kind === "docker-sbx" ? (
                  sandboxState === "running" ? (
                    <InlineConfirm
                      label="Stop sandbox"
                      subject={primaryLabel}
                      description="Stop this cloud sandbox?"
                      disabled={!privileged || Boolean(busyNodeKey)}
                      onConfirm={() => run(node.id, "stop")}
                    />
                  ) : sandboxState === "stopped" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 md:min-h-8"
                      disabled={!privileged || Boolean(busyNodeKey)}
                      onClick={() => void run(node.id, "start")}
                    >
                      {busyNodeKey === `${node.id}:start` ? "Starting…" : "Start sandbox"}
                    </Button>
                  ) : null
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 md:min-h-8"
                  disabled={!privileged}
                  onClick={() => {
                    setEditing(node);
                    setOpen(true);
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="min-h-11 md:min-h-8"
                  aria-expanded={detailsExpanded}
                  onClick={() =>
                    setOpenDetails((current) => ({ ...current, [node.id]: !current[node.id] }))
                  }
                >
                  Details
                </Button>
              </div>

              {detailsExpanded ? (
                <div className="mt-3 flex flex-col gap-3 rounded-xl bg-background p-3 text-xs">
                  <dl className="grid grid-cols-2 gap-2 font-mono text-[12px]">
                    <div>
                      <dt className="text-muted-foreground">ID</dt>
                      <dd className="text-foreground">{node.id}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Kind</dt>
                      <dd className="text-foreground">{kindMeta.shortLabel}</dd>
                    </div>
                    {node.kind === "docker-sbx" ? (
                      <div>
                        <dt className="text-muted-foreground">Box</dt>
                        <dd className="text-foreground">{node.box || "—"}</dd>
                      </div>
                    ) : null}
                    {node.kind === "ssh" ? (
                      <div className="col-span-2">
                        <dt className="text-muted-foreground">Target</dt>
                        <dd className="text-foreground">
                          {node.user || "ubuntu"}@{node.host || "—"}:{node.port || 22} · {node.remoteDir || DEFAULT_SSH_REMOTE_DIR}
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 md:min-h-8"
                      disabled={!privileged || Boolean(busyNodeKey)}
                      onClick={() => void run(node.id, "test")}
                    >
                      {busyNodeKey === `${node.id}:test` ? "Testing…" : "Test"}
                    </Button>
                    {node.kind === "docker-sbx" && node.id !== "local" ? (
                      <>
                        {sandboxState === "unknown" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-h-11 md:min-h-8"
                            disabled={!privileged || Boolean(busyNodeKey)}
                            onClick={() => void run(node.id, "status")}
                          >
                            {busyNodeKey === `${node.id}:status` ? "Checking…" : "Check status"}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 md:min-h-8"
                          disabled={!privileged || Boolean(busyNodeKey)}
                          onClick={() => void run(node.id, "auth-status")}
                        >
                          {busyNodeKey === `${node.id}:auth-status` ? "Checking…" : "Check auth"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 md:min-h-8"
                          disabled={!privileged || Boolean(busyNodeKey)}
                          onClick={() => void run(node.id, "auth-start")}
                        >
                          {busyNodeKey === `${node.id}:auth-start` ? "Linking…" : "Link Docker"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-11 md:min-h-8"
                          disabled={!privileged || Boolean(busyNodeKey)}
                          onClick={() => void run(node.id, "provision")}
                        >
                          {busyNodeKey === `${node.id}:provision` ? "Provisioning…" : "Provision"}
                        </Button>
                      </>
                    ) : null}
                    {node.kind === "ssh" && node.id !== "local" ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="min-h-11 md:min-h-8"
                        disabled={!privileged || Boolean(busyNodeKey)}
                        onClick={() => void run(node.id, "provision")}
                      >
                        {busyNodeKey === `${node.id}:provision` ? "Provisioning…" : "Provision"}
                      </Button>
                    ) : null}
                    {node.id !== "local" ? (
                      <InlineConfirm
                        label="Remove"
                        subject={primaryLabel}
                        description="Remove render node?"
                        disabled={!privileged || Boolean(busyNodeKey)}
                        onConfirm={async () => {
                          try {
                            const result = await api.studio.deleteNode(node.id);
                            onChange(result.nodes);
                            onNotice(`${primaryLabel} removed`);
                          } catch (error) {
                            onNotice(errText(error), "danger");
                          }
                        }}
                      />
                    ) : null}
                  </div>

                  {node.kind === "docker-sbx" && nodeSbxLink ? (
                    <div className="flex flex-col gap-2 rounded-xl bg-card p-3">
                      <p className="text-xs text-foreground">{nodeSbxLink.detail}</p>
                      {nodeSbxLink.userCode ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">Code:</span>
                          <code className="rounded border border-border bg-background px-2 py-0.5 font-mono text-sm font-semibold text-foreground">
                            {nodeSbxLink.userCode}
                          </code>
                          <CopyButton value={nodeSbxLink.userCode} label="Copy code" />
                        </div>
                      ) : null}
                      {validSbxUrl ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={validSbxUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-11 items-center rounded-full bg-muted px-3 font-mono text-[12.5px] text-foreground hover:bg-raised md:min-h-8"
                          >
                            Open sign-in
                          </a>
                          <CopyButton value={validSbxUrl} label="Copy link" />
                        </div>
                      ) : (
                        <p className="text-xs text-warning" role="status">
                          Sign-in link pending or unavailable. Click Link Docker to request a browser sign-in link.
                        </p>
                      )}
                    </div>
                  ) : null}

                  {nodeOutputs[node.id] ? (
                    <div
                      className={cn(
                        "rounded-lg border px-3 py-2 font-mono text-xs",
                        nodeOutputs[node.id]!.ok
                          ? "border-success/40 bg-success-soft text-success"
                          : "border-destructive/40 bg-destructive-soft text-destructive",
                      )}
                      role="status"
                    >
                      {nodeOutputs[node.id]!.text}
                    </div>
                  ) : null}

                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">Console log</summary>
                    <div className="mt-2">
                      <Terminal>
                        <TerminalHeader>node console</TerminalHeader>
                        <TerminalBody>
                          {lines.map((line, index) => (
                            <TerminalLine key={`${index}-${line.slice(0, 12)}`}>{line}</TerminalLine>
                          ))}
                        </TerminalBody>
                      </Terminal>
                    </div>
                  </details>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      <NodeDialog
        open={open}
        editing={editing}
        privileged={privileged}
        onOpenChange={setOpen}
        onSaved={(next) => {
          onChange(next);
          onNotice("Render node saved");
        }}
        onNotice={onNotice}
      />

      <StorageTrashDrawer
        open={storageOpen}
        onOpenChange={setStorageOpen}
        privileged={privileged}
        onMessage={onNotice}
        onStateLoaded={handleStorageStateLoaded}
      />
    </div>
  );
}

function buildPromptDrafts(state: StudioPromptsState | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (state?.defaults) {
    for (const [k, val] of Object.entries(state.defaults)) {
      out[k] = typeof val === "string" ? val : ((val as { content?: string } | null)?.content ?? "");
    }
  }
  if (state?.prompts) {
    for (const [k, val] of Object.entries(state.prompts)) {
      out[k] = typeof val === "string" ? val : (val?.content ?? "");
    }
  }
  return out;
}

export function PromptsTab({
  promptsState,
  privileged,
  onSaved,
  onNotice,
}: {
  promptsState: StudioPromptsState | null;
  privileged: boolean;
  onSaved: (state: StudioPromptsState) => void;
  onNotice: OnNotice;
}) {
  const [selectedStage, setSelectedStage] = useState<PromptStageId>("reader");
  const [drafts, setDrafts] = useState<Record<string, string>>(() => buildPromptDrafts(promptsState));
  const [preserveCacheHashes, setPreserveCacheHashes] = useState<boolean>(
    promptsState?.preserveCacheHashes !== false,
  );
  const [compareDefault, setCompareDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!promptsState) return;
    setDrafts(buildPromptDrafts(promptsState));
    if (typeof promptsState.preserveCacheHashes === "boolean") {
      setPreserveCacheHashes(promptsState.preserveCacheHashes);
    }
  }, [promptsState]);

  const activeMeta = PROMPT_STAGES.find((item) => item.id === selectedStage) || PROMPT_STAGES[0]!;
  const rawCurrent = drafts[selectedStage];
  const currentPrompt = typeof rawCurrent === "string" ? rawCurrent : "";
  const defaultPromptForStage =
    typeof promptsState?.defaults?.[selectedStage] === "string"
      ? promptsState.defaults[selectedStage]!
      : "";

  function isStageCustomized(stageId: PromptStageId): boolean {
    const draftVal = typeof drafts[stageId] === "string" ? drafts[stageId]! : "";
    const defVal = typeof promptsState?.defaults?.[stageId] === "string" ? promptsState.defaults[stageId]! : "";
    const storedEntry = promptsState?.prompts?.[stageId];
    if (defVal && draftVal) return draftVal !== defVal;
    if (storedEntry && typeof storedEntry === "object" && "isCustom" in storedEntry) {
      return Boolean(storedEntry.isCustom);
    }
    return false;
  }

  async function saveAllBriefs() {
    if (!privileged || saving) return;
    setSaving(true);
    try {
      const nextPrompts = { ...drafts, [selectedStage]: currentPrompt };
      const saved = await api.studio.putPrompts({
        prompts: nextPrompts,
        stage: selectedStage,
        prompt: currentPrompt,
        preserveCacheHashes,
        revision: promptsState?.revision,
      });
      onSaved(saved);
      onNotice(
        `Saved stage briefs (${activeMeta.title})${preserveCacheHashes ? " · existing chapter cache hashes preserved" : ""}.`,
      );
    } catch (error) {
      onNotice(errText(error), "danger");
    } finally {
      setSaving(false);
    }
  }

  async function resetStagePrompt() {
    if (!privileged || saving) return;
    setSaving(true);
    try {
      const saved = await api.studio.resetPrompt(selectedStage);
      onSaved(saved);
      setDrafts(buildPromptDrafts(saved));
      onNotice(`Reset ${activeMeta.title} brief to default.`);
    } catch (error) {
      onNotice(errText(error), "danger");
    } finally {
      setSaving(false);
    }
  }

  const activeLineCount = currentPrompt ? currentPrompt.split("\n").length : 1;
  const activeCustomized = isStageCustomized(selectedStage);

  return (
    <div className="studio-split">
      <aside className="studio-split-left" aria-label="Prompt stages">
        <div className="studio-split-left-head">
          <span>Stages <span className="font-normal text-caption tabular-nums">{PROMPT_STAGES.length}</span></span>
        </div>
        <div className="studio-conn-list" role="group" aria-label="Prompt stage selector">
          {PROMPT_STAGES.map((stage) => {
            const isSelected = selectedStage === stage.id;
            const stageText = typeof drafts[stage.id] === "string" ? drafts[stage.id]! : "";
            const lineCount = stageText ? stageText.split("\n").length : 1;
            const customized = isStageCustomized(stage.id);
            return (
              <button
                key={stage.id}
                type="button"
                aria-pressed={isSelected}
                className={cn("studio-conn-row", isSelected && "is-active")}
                onClick={() => setSelectedStage(stage.id)}
              >
                <span className="studio-conn-mark" aria-hidden>
                  {monogram(stage.title)}
                </span>
                <span className="studio-conn-body">
                  <span className="studio-conn-title">{stage.title}</span>
                  <span className="studio-conn-sub">{lineCount} lines</span>
                </span>
                <span className="studio-conn-status">
                  <span className={cn("studio-status-dot", customized && "is-online")} aria-hidden />
                  <span>{customized ? "Custom" : "Default"}</span>
                  <span className="studio-conn-chevron" aria-hidden>
                    ›
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="studio-split-right" aria-labelledby={`prompt-heading-${selectedStage}`}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="studio-pane-header !mb-0">
            <h2 id={`prompt-heading-${selectedStage}`}>{activeMeta.title}</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="chip inline-flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={preserveCacheHashes}
                disabled={!privileged}
                onChange={(event) => setPreserveCacheHashes(event.target.checked)}
              />
              Lock cache
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCompareDefault((prev) => !prev)}
            >
              Compare
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!privileged || saving}
              onClick={() => void resetStagePrompt()}
            >
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            <button
              type="button"
              className="studio-primary-btn"
              disabled={!privileged || saving}
              onClick={() => void saveAllBriefs()}
            >
              <span>{saving ? "Saving…" : "Save prompt"}</span>
              <ArrowRight className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        <div className={cn("grid w-full gap-4", compareDefault ? "lg:grid-cols-2" : "grid-cols-1")}>
          <div className="flex w-full min-w-0 flex-col gap-2">
            {compareDefault ? (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Active</span>
                <span className="font-mono">
                  {activeLineCount}L · {currentPrompt.length}c
                </span>
              </div>
            ) : null}
            <textarea
              aria-label={`${activeMeta.title} prompt template`}
              rows={20}
              className="field min-h-[380px] w-full resize-y p-4 font-mono text-xs leading-relaxed"
              value={currentPrompt}
              disabled={!privileged}
              spellCheck={false}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [selectedStage]: event.target.value,
                }))
              }
            />
          </div>

          {compareDefault ? (
            <div className="flex w-full min-w-0 flex-col gap-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-medium">Default</span>
                <span className="font-mono">
                  {defaultPromptForStage ? defaultPromptForStage.split("\n").length : 1}L · {defaultPromptForStage.length}c
                </span>
              </div>
              <textarea
                aria-label={`${activeMeta.title} default prompt reference`}
                readOnly
                rows={20}
                className="field min-h-[380px] w-full resize-y bg-card p-4 font-mono text-xs leading-relaxed text-muted-foreground"
                value={defaultPromptForStage || currentPrompt}
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>

        <div className="studio-pane-footer">
          <span>PROMPT TEMPLATE</span>
          <span>{activeCustomized ? "Customized" : "Default template"}</span>
        </div>
      </section>
    </div>
  );
}

function MeterRow({ label, level, text }: { label: string; level: number | null; text: string }) {
  const clamped = level !== null && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const pct = Math.round(clamped * 100);
  const fillClass = pct >= 85 ? "bg-destructive" : pct >= 65 ? "bg-warning" : "bg-success";
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_88px] items-center gap-2">
      <span className="font-mono text-[12.5px] text-muted-foreground">{label}</span>
      <div
        role={level === null ? undefined : "meter"}
        aria-label={label}
        aria-valuemin={level === null ? undefined : 0}
        aria-valuemax={level === null ? undefined : 100}
        aria-valuenow={level === null ? undefined : pct}
        aria-valuetext={level === null ? undefined : text}
        className="h-2 overflow-hidden rounded-full border border-border bg-background"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-200", fillClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className="whitespace-nowrap text-right font-mono text-[12px] text-foreground">{text}</span>
    </div>
  );
}

const DIALOG_NODE_KINDS: readonly RenderNodeKind[] = ["ssh", "docker-sbx", "local"] as const;

function NodeDialog({
  open,
  editing,
  privileged,
  onOpenChange,
  onSaved,
  onNotice,
}: {
  open: boolean;
  editing: RenderNode | null;
  privileged: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (nodes: RenderNode[]) => void;
  onNotice: OnNotice;
}) {
  const [kind, setKind] = useState<RenderNodeKind>("ssh");
  const [id, setId] = useState("ssh-1");
  const [label, setLabel] = useState("Remote SSH");
  const [idTouched, setIdTouched] = useState(false);
  const [labelTouched, setLabelTouched] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState(10);
  const [slots, setSlots] = useState(2);
  const [box, setBox] = useState("manhwa-box-1");
  const [detectedSandboxes, setDetectedSandboxes] = useState<Array<{ name: string; id: string; status: string; cpus?: number; memoryMib?: number }>>([]);
  const [template, setTemplate] = useState(DEFAULT_SANDBOX_TEMPLATE);
  const [maxHours, setMaxHours] = useState(DEFAULT_SANDBOX_MAX_HOURS);
  const [idlePauseS, setIdlePauseS] = useState(DEFAULT_SANDBOX_IDLE_PAUSE_S);
  const [host, setHost] = useState("");
  const [user, setUser] = useState(DEFAULT_SSH_USER);
  const [port, setPort] = useState(DEFAULT_SSH_PORT);
  const [remoteDir, setRemoteDir] = useState(DEFAULT_SSH_REMOTE_DIR);
  const [sshKey, setSshKey] = useState("");
  const [supportsCleaner, setSupportsCleaner] = useState(true);
  const [autoProvisionSbx, setAutoProvisionSbx] = useState(true);
  const [autoBootstrapSsh, setAutoBootstrapSsh] = useState(true);
  const [sbxAuthInfo, setSbxAuthInfo] = useState<{
    checked: boolean;
    ok: boolean;
    detail: string;
    verificationUrl?: string | null;
    userCode?: string | null;
    instructions?: string;
  } | null>(null);
  const [checkingSbxAuth, setCheckingSbxAuth] = useState(false);
  const [provisioningNow, setProvisioningNow] = useState(false);
  const [provisionStatus, setProvisionStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSbxAuthInfo(null);
    setProvisionStatus(null);
    setCheckingSbxAuth(false);
    setProvisioningNow(false);
    if (!editing) {
      setKind("ssh");
      setId("ssh-1");
      setLabel("Remote SSH");
      setIdTouched(false);
      setLabelTouched(false);
      setEnabled(true);
      setPriority(10);
      setBox("manhwa-box-1");
      setTemplate(DEFAULT_SANDBOX_TEMPLATE);
      setSlots(2);
      setMaxHours(DEFAULT_SANDBOX_MAX_HOURS);
      setIdlePauseS(DEFAULT_SANDBOX_IDLE_PAUSE_S);
      setHost("");
      setUser(DEFAULT_SSH_USER);
      setPort(DEFAULT_SSH_PORT);
      setRemoteDir(DEFAULT_SSH_REMOTE_DIR);
      setSshKey("");
      setSupportsCleaner(true);
      setAutoProvisionSbx(true);
      setAutoBootstrapSsh(true);
      setFormError(null);
      return;
    }
    setFormError(null);
    setSshKey("");
    setIdTouched(true);
    setLabelTouched(true);
    setKind(editing.kind);
    setId(editing.id);
    setLabel(editing.label);
    setEnabled(editing.enabled !== false);
    setPriority(typeof editing.priority === "number" ? editing.priority : 10);
    setSlots(editing.slots);
    setBox(editing.box || "manhwa-box-1");
    setTemplate(editing.template || DEFAULT_SANDBOX_TEMPLATE);
    setMaxHours(editing.maxHours || DEFAULT_SANDBOX_MAX_HOURS);
    setIdlePauseS(editing.idlePauseS || DEFAULT_SANDBOX_IDLE_PAUSE_S);
    setHost(editing.host || "");
    setUser(editing.user || DEFAULT_SSH_USER);
    setPort(editing.port || DEFAULT_SSH_PORT);
    setRemoteDir(editing.remoteDir || DEFAULT_SSH_REMOTE_DIR);
    setSupportsCleaner(editing.supportsCleaner);
    setAutoProvisionSbx(false);
    setAutoBootstrapSsh(false);
  }, [open, editing]);

  useEffect(() => {
    if (!open || kind !== "docker-sbx") return;
    let cancelled = false;
    setDetectedSandboxes([]);
    void api.studio.sbxAuthStatus().then((res) => {
      if (cancelled) return;
      setSbxAuthInfo({ checked: true, ok: res.authenticated, detail: res.detail });
      setDetectedSandboxes(res.sandboxes || []);
      if (!editing) {
        const firstName = res.sandboxes?.[0]?.name || "";
        if (firstName && BOX_RE.test(firstName)) {
          setBox((cur) => (!cur.trim() || cur === "manhwa-box-1" ? firstName : cur));
        }
      }
    }).catch((error) => {
      if (!cancelled) setSbxAuthInfo({ checked: true, ok: false, detail: errText(error) });
    });
    return () => { cancelled = true; };
  }, [open, kind, editing]);

  useEffect(() => {
    if (!open || kind !== "docker-sbx" || sbxAuthInfo?.ok || !sbxAuthInfo?.verificationUrl) return;
    const timer = window.setInterval(() => {
      void api.studio.sbxAuthStatus().then((res) => {
        if (res.authenticated) {
          setSbxAuthInfo({ checked: true, ok: true, detail: res.detail });
          setDetectedSandboxes(res.sandboxes || []);
          if (!editing) {
            const firstName = res.sandboxes?.[0]?.name || "";
            if (firstName && BOX_RE.test(firstName)) {
              setBox((cur) => (!cur.trim() || cur === "manhwa-box-1" ? firstName : cur));
            }
          }
          onNotice("Docker account linked · sbx CLI ready");
        }
      }).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [open, kind, editing, sbxAuthInfo?.ok, sbxAuthInfo?.verificationUrl, onNotice]);

  function selectKind(nextKind: RenderNodeKind) {
    setKind(nextKind);
    setSlots((current) => clampSlotsForKind(nextKind, current));
    setFormError(null);
    setProvisionStatus(null);
    if (editing) return;
    if (nextKind === "ssh") {
      if (!idTouched) setId("ssh-1");
      if (!labelTouched) setLabel(host.trim() ? `SSH · ${host.trim()}` : "Remote SSH");
      setAutoBootstrapSsh(true);
    } else if (nextKind === "docker-sbx") {
      if (!idTouched) setId("sbx-1");
      if (!labelTouched) setLabel("Cloud Sandbox");
      if (!box.trim()) setBox("manhwa-box-1");
      if (!template.trim()) setTemplate(DEFAULT_SANDBOX_TEMPLATE);
      setAutoProvisionSbx(true);
    } else {
      if (!idTouched) setId("local");
      if (!labelTouched) setLabel("Local");
    }
  }

  async function startSbxDeviceLink() {
    if (!privileged || checkingSbxAuth) return;
    setCheckingSbxAuth(true);
    setFormError(null);
    try {
      const started = await api.studio.sbxAuthStart();
      if (Array.isArray(started.sandboxes)) {
        setDetectedSandboxes(started.sandboxes);
        if (!editing && (!box.trim() || box === "manhwa-box-1") && started.sandboxes.length > 0) {
          setBox(started.sandboxes[0].name);
        }
      }
      const verificationUrl = normalizeHttpUrl(started.verificationUrl);
      const userCode =
        typeof started.userCode === "string" && started.userCode.trim() ? started.userCode.trim() : null;
      const instructions =
        typeof started.instructions === "string"
          ? started.instructions
          : "Open the Docker verification link and enter the one-time code.";
      setSbxAuthInfo({
        checked: true,
        ok: Boolean(started.authenticated),
        detail: started.detail,
        verificationUrl,
        userCode,
        instructions,
      });
      if (verificationUrl) {
        window.open(verificationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      setFormError(errText(error));
    } finally {
      setCheckingSbxAuth(false);
    }
  }

  async function checkOrStartSbxAuth() {
    if (!privileged || checkingSbxAuth) return;
    setCheckingSbxAuth(true);
    setFormError(null);
    try {
      const targetNodeId = editing?.id || "local";
      const statusRes = await api.studio.nodeAction(targetNodeId, "auth-status");
      if (Array.isArray(statusRes.probe?.sandboxes)) {
        setDetectedSandboxes(statusRes.probe.sandboxes);
        if (!editing && (!box.trim() || box === "manhwa-box-1") && statusRes.probe.sandboxes.length > 0) {
          setBox(statusRes.probe.sandboxes[0].name);
        }
      }
      if (statusRes.ok) {
        setSbxAuthInfo({
          checked: true,
          ok: true,
          detail: statusRes.detail,
        });
        onNotice(statusRes.detail);
        return;
      }
      if (statusRes.status === "missing-cli") {
        setSbxAuthInfo({
          checked: true,
          ok: false,
          detail: statusRes.detail,
          instructions: "Install the Docker sbx CLI on this server.",
        });
        return;
      }
      const started = await api.studio.sbxAuthStart();
      const verificationUrl = normalizeHttpUrl(started.verificationUrl);
      const userCode =
        typeof started.userCode === "string" && started.userCode.trim() ? started.userCode.trim() : null;
      const instructions =
        typeof started.instructions === "string"
          ? started.instructions
          : "Complete the browser sign-in flow.";
      setSbxAuthInfo({
        checked: true,
        ok: Boolean(started.authenticated),
        detail: started.detail,
        verificationUrl,
        userCode,
        instructions,
      });
      if (verificationUrl) {
        window.open(verificationUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      setFormError(errText(error));
    } finally {
      setCheckingSbxAuth(false);
    }
  }

  function buildNodeUpsertPayload() {
    const resolvedId =
      id.trim() ||
      (kind === "ssh" ? "ssh-1" : kind === "docker-sbx" ? "sbx-1" : "local");
    const resolvedLabel =
      label.trim() ||
      (kind === "ssh"
        ? host.trim()
          ? `SSH · ${host.trim()}`
          : "Remote SSH"
        : kind === "docker-sbx"
          ? "Cloud Sandbox"
          : "Local");
    const resolvedBox = kind === "docker-sbx" ? box.trim() || "manhwa-box-1" : undefined;
    const resolvedTemplate = kind === "docker-sbx" ? template.trim() || DEFAULT_SANDBOX_TEMPLATE : undefined;
    if (!NODE_ID_RE.test(resolvedId)) {
      return { error: "Node id must match letters, digits, '.', '_' or '-' and not start with a dash." } as const;
    }
    if (kind === "docker-sbx" && (!resolvedBox || !BOX_RE.test(resolvedBox))) {
      return { error: "Box name must match ^[a-z0-9][a-z0-9-]{2,62}$" } as const;
    }
    if (kind === "ssh" && (!HOST_RE.test(host.trim()) || host.trim().startsWith("-") || !HOST_RE.test(user.trim()))) {
      return { error: "SSH host and user allow only letters, digits, '.', '_' and '-'. No leading dash." } as const;
    }
    return {
      resolvedId,
      body: {
        id: resolvedId,
        label: resolvedLabel,
        kind,
        enabled,
        priority: Math.max(1, Math.min(1000, Math.trunc(Number(priority)) || 10)),
        slots: clampSlotsForKind(kind, slots),
        supportsCleaner,
        box: resolvedBox,
        template: resolvedTemplate,
        maxHours: kind === "docker-sbx" ? maxHours : undefined,
        idlePauseS: kind === "docker-sbx" ? idlePauseS : undefined,
        host: kind === "ssh" ? host.trim() : undefined,
        user: kind === "ssh" ? user.trim() : undefined,
        port: kind === "ssh" ? port : undefined,
        remoteDir: kind === "ssh" ? remoteDir.trim() || DEFAULT_SSH_REMOTE_DIR : undefined,
        privateKey: kind === "ssh" && sshKey ? sshKey : undefined,
        expectedRevision: editing?.revision,
      },
    } as const;
  }

  async function provisionCurrentNodeNow() {
    if (!privileged || provisioningNow || busy) return;
    setFormError(null);
    setProvisionStatus(null);
    const built = buildNodeUpsertPayload();
    if ("error" in built) {
      setFormError(built.error ?? "Invalid node configuration.");
      return;
    }
    setProvisioningNow(true);
    try {
      setSshKey("");
      const saved = editing
        ? await api.studio.updateNode(editing.id, built.body)
        : await api.studio.createNode(built.body).catch(async () => await api.studio.updateNode(built.resolvedId, built.body));
      onSaved(saved.nodes);
      const prov = await api.studio.nodeAction(built.resolvedId, "provision");
      setProvisionStatus({ ok: prov.ok, detail: prov.detail });
      onNotice(prov.detail, prov.ok ? "info" : "danger");
    } catch (error) {
      const msg = errText(error);
      setProvisionStatus({ ok: false, detail: msg });
      setFormError(msg);
    } finally {
      setProvisioningNow(false);
    }
  }

  async function save() {
    setFormError(null);
    const built = buildNodeUpsertPayload();
    if ("error" in built) {
      setFormError(built.error ?? "Invalid node configuration.");
      return;
    }
    setBusy(true);
    try {
      setSshKey("");
      const result = editing
        ? await api.studio.updateNode(editing.id, built.body)
        : await api.studio.createNode(built.body);
      const shouldProvision =
        (kind === "docker-sbx" && autoProvisionSbx) ||
        (kind === "ssh" && autoBootstrapSsh);
      if (shouldProvision) {
        try {
          const prov = await api.studio.nodeAction(built.resolvedId, "provision");
          onSaved(result.nodes);
          onNotice(
            prov.ok
              ? `Saved ${built.resolvedId} & provisioned render environment: ${prov.detail}`
              : `Saved ${built.resolvedId} (provisioning note: ${prov.detail})`,
            prov.ok ? "info" : "danger",
          );
          onOpenChange(false);
          return;
        } catch (provErr) {
          onSaved(result.nodes);
          onNotice(`Saved ${built.resolvedId}, but auto-provisioning reported: ${errText(provErr)}`, "danger");
          onOpenChange(false);
          return;
        }
      }
      onSaved(result.nodes);
      onOpenChange(false);
    } catch (error) {
      setFormError(errText(error));
      onNotice(errText(error), "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="studio-dialog sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-[-0.015em]">{editing ? "Edit render node" : "Add render node"}</DialogTitle>
          <DialogDescription className="sr-only">Configure render node</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Node kind">
          {DIALOG_NODE_KINDS.map((item) => (
            <button
              key={item}
              type="button"
              className={cn("chip", kind === item && "is-on")}
              aria-pressed={kind === item}
              onClick={() => selectKind(item)}
            >
              {getRenderKindMeta(item).label}
            </button>
          ))}
        </div>

        {kind === "ssh" ? (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="cap is-on">1. SSH Host &amp; Key</span>
              <span className="text-muted-foreground" aria-hidden>-&gt;</span>
              <span className="cap">2. Auto-Setup</span>
              <span className="text-muted-foreground" aria-hidden>-&gt;</span>
              <span className="cap">3. Ready</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Host / IP
                <input
                  className="field mt-1 font-mono"
                  placeholder="10.0.0.12 or worker.example.com"
                  value={host}
                  pattern="^[A-Za-z0-9][A-Za-z0-9._-]*$"
                  onChange={(event) => {
                    const nextHost = event.target.value;
                    setHost(nextHost);
                    if (!editing) {
                      if (!idTouched) setId("ssh-1");
                      if (!labelTouched) setLabel(nextHost.trim() ? `SSH · ${nextHost.trim()}` : "Remote SSH");
                    }
                  }}
                />
              </label>
              <label className="text-sm">
                SSH User
                <input
                  className="field mt-1 font-mono"
                  value={user}
                  placeholder="ubuntu or root"
                  pattern="^[A-Za-z0-9][A-Za-z0-9._-]*$"
                  onChange={(event) => setUser(event.target.value)}
                />
              </label>
            </div>
            <label className="text-sm">
              SSH Private Key <span className="text-xs text-muted-foreground">(write-only)</span>
              <textarea
                rows={4}
                className="field mt-1 min-h-24 font-mono"
                value={sshKey}
                autoComplete="off"
                spellCheck={false}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                onChange={(event) => setSshKey(event.target.value)}
              />
            </label>
            {editing?.auth.hasSecret ? (
              <p className="font-mono text-xs text-success">Key stored · {editing.auth.secretHint || "saved"}</p>
            ) : null}
            <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground">
              <input
                type="checkbox"
                checked={autoBootstrapSsh}
                onChange={(event) => setAutoBootstrapSsh(event.target.checked)}
              />
              <span>
                Auto-provision on save (Node · FFmpeg · Remotion)
              </span>
            </label>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <IntStepper label="Slots" value={slots} min={1} max={maxSlotsForKind(kind)} step={1} onChange={setSlots} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!privileged || provisioningNow || busy || !host.trim()}
                onClick={() => void provisionCurrentNodeNow()}
              >
                {provisioningNow ? "Provisioning…" : "Provision now"}
              </Button>
            </div>
            {provisionStatus ? (
              <p
                className={cn(
                  "rounded-lg border px-3 py-2 font-mono text-xs",
                  provisionStatus.ok
                    ? "border-success/40 bg-success-soft text-success"
                    : "border-destructive/40 bg-destructive-soft text-destructive",
                )}
                role="status"
              >
                {provisionStatus.detail}
              </p>
            ) : null}
          </div>
        ) : null}

        {kind === "docker-sbx" ? (
          <div className="grid gap-3">
            <div className="flex flex-col gap-2 rounded-xl bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="cap is-on">1. Sandbox Auth</span>
                  <span className={cn("cap font-mono", sbxAuthInfo?.ok && "is-on")}>
                    {sbxAuthInfo ? (sbxAuthInfo.ok ? "Signed in" : "Auth needed") : "Unchecked"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!privileged || checkingSbxAuth}
                    onClick={() => void checkOrStartSbxAuth()}
                  >
                    {checkingSbxAuth ? "Checking…" : "Check Auth"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!privileged || checkingSbxAuth}
                    onClick={() => void startSbxDeviceLink()}
                  >
                    {checkingSbxAuth ? "Linking…" : "Link Docker Account (URL + Code)"}
                  </Button>
                </div>
              </div>
              {sbxAuthInfo ? (
                <div className="flex flex-col gap-2 text-xs">
                  <p className={cn("font-mono", sbxAuthInfo.ok ? "text-success" : "text-warning")}>
                    {sbxAuthInfo.detail}
                  </p>
                  {!sbxAuthInfo.ok ? (
                    <div className="flex flex-col gap-2 rounded-2xl bg-card p-3">
                      {sbxAuthInfo.userCode ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">Code:</span>
                          <code className="rounded border border-border bg-background px-2.5 py-1 font-mono text-sm font-semibold text-foreground">
                            {sbxAuthInfo.userCode}
                          </code>
                          <CopyButton value={sbxAuthInfo.userCode} label="Copy code" />
                        </div>
                      ) : null}
                      {normalizeHttpUrl(sbxAuthInfo.verificationUrl) ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={normalizeHttpUrl(sbxAuthInfo.verificationUrl)!}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-h-11 items-center rounded-full bg-muted px-3 font-mono text-[12.5px] text-foreground hover:bg-raised md:min-h-8"
                          >
                            Open sign-in
                          </a>
                          <CopyButton value={normalizeHttpUrl(sbxAuthInfo.verificationUrl)!} label="Copy link" />
                        </div>
                      ) : (
                        <p className="text-xs text-warning" role="status">
                          Sign-in link pending or unavailable. Click Link Docker Account to request a browser sign-in link.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 rounded-xl bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="cap is-on">2. Sandbox Box</span>
                <Button
                  type="button"
                  size="sm"
                  disabled={!privileged || provisioningNow || busy}
                  onClick={() => void provisionCurrentNodeNow()}
                >
                  {provisioningNow ? "Provisioning…" : "Provision now"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Provision auto-checks if the prebaked Remotion environment (<code>.kit-ready</code>, headless browser, <code>ffmpeg</code>) is in the sandbox, and creates/bakes it if missing.
              </p>
              {detectedSandboxes.length ? <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Existing sandboxes:</span>
                {detectedSandboxes.map((sandbox) => <button key={sandbox.id || sandbox.name} type="button" className={cn("chip", box === sandbox.name && "is-on")} aria-pressed={box === sandbox.name} onClick={() => setBox(sandbox.name)}>{sandbox.name} · {sandbox.status}{sandbox.cpus != null ? ` · ${sandbox.cpus} vCPU` : ""}</button>)}
              </div> : null}
              <label className="text-sm">
                Box name
                <input
                  className="field mt-1 font-mono"
                  value={box}
                  placeholder="manhwa-box-1"
                  pattern="^[a-z0-9][a-z0-9-]{2,62}$"
                  onChange={(event) => setBox(event.target.value)}
                />
              </label>
              <label className="mt-1 flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={autoProvisionSbx}
                  onChange={(event) => setAutoProvisionSbx(event.target.checked)}
                />
                <span>Auto-provision on save</span>
              </label>
              {provisionStatus ? (
                <p
                  className={cn(
                    "rounded-lg border px-3 py-2 font-mono text-xs",
                    provisionStatus.ok
                      ? "border-success/40 bg-success-soft text-success"
                      : "border-destructive/40 bg-destructive-soft text-destructive",
                  )}
                  role="status"
                >
                  {provisionStatus.detail}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <IntStepper label="Slots" value={slots} min={1} max={maxSlotsForKind(kind)} step={1} onChange={setSlots} />
            </div>
          </div>
        ) : null}

        {kind === "local" ? (
          <div className="flex flex-wrap items-center gap-4">
            <IntStepper label="Slots" value={slots} min={1} max={maxSlotsForKind(kind)} step={1} onChange={setSlots} />
          </div>
        ) : null}

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Advanced node settings</summary>
          <div className="mt-2 flex flex-col gap-3 rounded-xl bg-background p-3 text-sm text-foreground">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Id
                <input
                  className="field mt-1 font-mono"
                  value={id}
                  disabled={Boolean(editing)}
                  onChange={(event) => {
                    setIdTouched(true);
                    setId(event.target.value);
                  }}
                />
              </label>
              <label className="text-sm">
                Label
                <input
                  className="field mt-1"
                  value={label}
                  onChange={(event) => {
                    setLabelTouched(true);
                    setLabel(event.target.value);
                  }}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-2 text-sm">
                <span className="text-[12px] text-muted-foreground">Priority</span>
                <input
                  className="step-input"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={priority}
                  aria-label="Priority"
                  onChange={(event) => setPriority(Math.max(1, Math.min(1000, Math.trunc(Number(event.target.value)) || 1)))}
                />
              </label>
              {kind === "ssh" ? (
                <IntStepper label="Port" value={port} min={1} max={65535} step={1} onChange={setPort} />
              ) : null}
            </div>
            {kind === "ssh" ? (
              <label className="text-sm">
                Remote dir
                <input
                  className="field mt-1 font-mono"
                  value={remoteDir}
                  onChange={(event) => setRemoteDir(event.target.value)}
                />
              </label>
            ) : null}
            {kind === "docker-sbx" ? (
              <div className="grid gap-3">
                <label className="text-sm">
                  Template
                  <input
                    className="field mt-1 font-mono"
                    value={template}
                    onChange={(event) => setTemplate(event.target.value)}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-4">
                  <IntStepper label="Max hours" value={maxHours} min={1} max={12} step={1} onChange={setMaxHours} />
                  <IntStepper label="Idle pause seconds" value={idlePauseS} min={30} max={3600} step={30} onChange={setIdlePauseS} />
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                Enabled
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={supportsCleaner} onChange={(event) => setSupportsCleaner(event.target.checked)} />
                Supports cleaner
              </label>
            </div>
          </div>
        </details>

        {formError ? <p className="text-sm text-destructive" role="alert">{formError}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={!privileged || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save node"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function VoiceTab({
  providers,
  privileged,
  onRefreshCatalog,
}: {
  providers: TtsProviderGroup[];
  privileged: boolean;
  onRefreshCatalog?: () => Promise<void> | void;
}) {
  const initialPref = useMemo(() => readPreferredVoice(), []);
  const [providerId, setProviderId] = useState<string>(() => initialPref?.providerId || "");
  const [modelId, setModelId] = useState<string>(() => initialPref?.modelId || "");
  const [voiceId, setVoiceId] = useState<string>(() => initialPref?.voiceId || "");
  const providerTouchedRef = useRef(false);
  const voiceTouchedRef = useRef(false);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [spendOk, setSpendOk] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void onRefreshCatalog?.();
  }, [onRefreshCatalog]);

  const provider =
    providers.find((p) => p.id === providerId) ||
    providers.find((p) => p.available) ||
    providers[0] ||
    null;
  const activeModel = useMemo(() => {
    if (!provider) return null;
    if (modelId) {
      const hit = provider.models.find((m) => m.id === modelId);
      if (hit) return hit;
    }
    const voiceHit = provider.voices.find((v) => v.id === voiceId);
    if (voiceHit) {
      const hit = provider.models.find((m) => m.id === voiceHit.modelId);
      if (hit) return hit;
    }
    return provider.models[0] || null;
  }, [provider, modelId, voiceId]);
  const modelVoices = activeModel?.voices || provider?.voices || [];
  const voice =
    modelVoices.find((v) => v.id === voiceId) ||
    provider?.voices.find((v) => v.id === voiceId) ||
    modelVoices[0] ||
    provider?.voices[0] ||
    null;

  useEffect(() => {
    if (!providers.length) return;
    let targetProvider = providers.find((p) => p.id === providerId && p.available);
    if (!targetProvider && !providerTouchedRef.current && initialPref?.providerId) {
      targetProvider = providers.find(
        (p) => (p.id === initialPref.providerId || p.engine === initialPref.providerId) && p.available,
      );
    }
    if (!targetProvider) {
      targetProvider = providers.find((p) => p.available) || providers[0];
    }
    if (!targetProvider) return;
    if (targetProvider.id !== providerId) setProviderId(targetProvider.id);

    let targetVoice = targetProvider.voices.find((v) => v.id === voiceId);
    if (
      !voiceTouchedRef.current &&
      initialPref?.voiceId &&
      (targetProvider.id === initialPref.providerId || targetProvider.engine === initialPref.providerId)
    ) {
      const prefVoice = targetProvider.voices.find((v) => v.id === initialPref.voiceId);
      if (prefVoice) targetVoice = prefVoice;
    }
    if (!targetVoice) {
      targetVoice = targetProvider.voices.find((v) => v.default) || targetProvider.voices[0];
    }
    if (targetVoice) {
      if (targetVoice.id !== voiceId) setVoiceId(targetVoice.id);
      if (targetVoice.modelId !== modelId) setModelId(targetVoice.modelId);
    }
  }, [providers, providerId, voiceId, modelId, initialPref]);

  useEffect(() => {
    gen.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setSrc("");
    setError("");
    setBusy(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSpendOk(false);
  }, [provider?.id, voice?.id]);

  useEffect(() => {
    return () => {
      gen.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const isPaid = isPaidTtsProvider(provider);

  async function listen() {
    if (!provider || !voice || busy || !privileged) return;
    if (!provider.available) {
      setError(`${provider.label} unavailable: ${provider.unavailableReason || "connect in Studio Providers"}`);
      return;
    }
    if (isPaid && !spendOk) {
      setError("Confirm spend before synthesizing this paid voice.");
      return;
    }
    if (src && audioRef.current) {
      setError("");
      audioRef.current.currentTime = 0;
      void audioRef.current.play().catch(() => undefined);
      return;
    }
    const token = ++gen.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    try {
      const preview = await api.intake.preview(provider.id, voice.id, controller.signal);
      if (token !== gen.current) return;
      setSrc(preview.audioUrl);
      window.setTimeout(() => {
        if (token !== gen.current) return;
        void audioRef.current?.play().catch(() => undefined);
      }, 40);
    } catch (err) {
      if (token !== gen.current) return;
      setError(errText(err));
    } finally {
      if (token === gen.current) setBusy(false);
    }
  }

  function stop() {
    gen.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    setBusy(false);
    setPlaying(false);
    setCurrentTime(0);
  }

  return (
    <div className="desk-card studio-voice">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[140px] flex-1 text-sm" htmlFor="studioTtsProvider">
            Provider
            <select
              id="studioTtsProvider"
              className="field mt-1"
              value={provider?.id || ""}
              onChange={(event) => {
                const nextProvId = event.target.value;
                providerTouchedRef.current = true;
                setProviderId(nextProvId);
                const nextProv = providers.find((p) => p.id === nextProvId);
                const defVoice = nextProv?.voices.find((v) => v.default) || nextProv?.voices[0];
                if (defVoice) {
                  setModelId(defVoice.modelId);
                  setVoiceId(defVoice.id);
                }
              }}
            >
              {providers.length === 0 && <option value="">No providers loaded</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.available || p.voices.length === 0}>
                  {p.label}{p.available ? "" : " (Unavailable)"}
                </option>
              ))}
            </select>
          </label>
          {provider?.hasExplicitModels ? (
            <label className="min-w-[180px] flex-1 text-sm" htmlFor="studioTtsModel">
              Model
              <select
                id="studioTtsModel"
                className="field mt-1"
                value={activeModel?.id || ""}
                onChange={(event) => {
                  const nextModelId = event.target.value;
                  voiceTouchedRef.current = true;
                  setModelId(nextModelId);
                  const nextGroup = provider.models.find((m) => m.id === nextModelId);
                  const currentShort = voice?.label;
                  const nextVoice =
                    nextGroup?.voices.find((v) => v.label === currentShort) ||
                    nextGroup?.voices.find((v) => v.default) ||
                    nextGroup?.voices[0];
                  if (nextVoice) setVoiceId(nextVoice.id);
                }}
              >
                {provider.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="min-w-[180px] flex-1 text-sm" htmlFor="studioNarratorVoice">
            Voice
            <select
              id="studioNarratorVoice"
              className="field mt-1"
              value={voice?.id || ""}
              disabled={modelVoices.length === 0}
              onChange={(event) => {
                const nextVoiceId = event.target.value;
                voiceTouchedRef.current = true;
                setVoiceId(nextVoiceId);
                const nextVoice = provider?.voices.find((v) => v.id === nextVoiceId);
                if (nextVoice) setModelId(nextVoice.modelId);
              }}
            >
              {modelVoices.length === 0 && <option value="">No voices available</option>}
              {modelVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant={playing ? "outline" : "default"}
            className="min-h-11 md:min-h-9"
            disabled={!privileged || !provider?.available || !voice || busy || (isPaid && !spendOk)}
            onClick={() => (playing ? stop() : void listen())}
          >
            <AudioLines size={16} aria-hidden /> {busy ? "Generating…" : playing ? "Stop" : "Play sample"}
          </Button>
          {isPaid ? (
            <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground md:min-h-9">
              <input
                type="checkbox"
                checked={spendOk}
                onChange={(event) => {
                  setSpendOk(event.target.checked);
                  if (event.target.checked) setError("");
                }}
              />
              <span>Confirm paid</span>
            </label>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 md:min-h-9"
            disabled={!provider || !voice || !provider.available}
            onClick={() => {
              if (!provider || !voice) return;
              writePreferredVoice({
                providerId: provider.id,
                modelId: activeModel?.id || voice.modelId,
                voiceId: voice.id,
                engine: provider.engine,
                voiceLabel: voice.label,
              });
              navigateClient("/new-series.html");
            }}
          >
            Use voice
          </Button>
        </div>

        {providers.some((p) => !p.available && p.unavailableReason) ? (
          <ul className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning" role="status">
            {providers
              .filter((p) => !p.available && p.unavailableReason)
              .map((p) => (
                <li key={p.id}>
                  <strong>{p.label} unavailable:</strong> {p.unavailableReason}
                </li>
              ))}
          </ul>
        ) : provider?.costNotice ? (
          <p className="text-xs text-muted-foreground" role="note">{provider.costNotice}</p>
        ) : null}

        <div className="flex items-center gap-3">
          <Waves className={cn("size-4 shrink-0", playing ? "text-primary-text" : "text-muted-foreground")} aria-hidden />
          <div className="h-2 flex-1 overflow-hidden rounded-full border border-border bg-card">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150"
              style={{ width: `${duration > 0 ? Math.min(100, Math.round((currentTime / duration) * 100)) : 0}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
            {fmtAudioTime(currentTime)} / {fmtAudioTime(duration)}
          </span>
          {src ? (
            <audio
              ref={audioRef}
              src={src}
              preload="metadata"
              className="sr-only"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            />
          ) : null}
        </div>
        {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

function IntStepper({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const decimals = step < 1 ? 1 : 0;
  function set(next: number) {
    const clamped = Math.min(max, Math.max(min, next));
    onChange(Number(clamped.toFixed(decimals)));
  }
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <button type="button" className="mini" aria-label={`Decrease ${label}`} disabled={disabled} onClick={() => set(value - step)}>−</button>
      <input
        className="step-input"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => set(Number(event.target.value))}
      />
      <button type="button" className="mini" aria-label={`Increase ${label}`} disabled={disabled} onClick={() => set(value + step)}>+</button>
    </div>
  );
}

function InlineConfirm({
  label,
  subject,
  description = "Confirm action?",
  onConfirm,
  disabled,
}: {
  label: string;
  subject?: string;
  description?: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="min-h-11 text-destructive md:min-h-8" disabled={disabled} onClick={() => setArmed(true)}>
        {label}
      </Button>
      <Dialog open={armed} onOpenChange={(next) => { if (!busy) { setArmed(next); setError(""); } }}>
        <DialogContent className="studio-dialog sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{label}{subject ? `: ${subject}` : "?"}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setArmed(false)}>Cancel</Button>
            <Button variant="destructive" disabled={disabled || busy} onClick={async () => {
              setBusy(true); setError("");
              try { await onConfirm(); setArmed(false); }
              catch (err) { setError(errText(err)); }
              finally { setBusy(false); }
            }}>{busy ? "Applying…" : label}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const StudioPage = StudioSettingsSections;
export default StudioPage;
