import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Activity,
  AudioLines,
  Box,
  Brain,
  Braces,
  Check,
  Cloud,
  Eye,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Monitor,
  PenTool,
  Plus,
  Radio,
  RotateCcw,
  Server,
  Waves,
} from "lucide-react";

import {
  api,
  isApiError,
  isConflict,
  type AuditEntry,
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
import { AppShell, navigateClient } from "@/components/layout/AppShell";
import { StorageTrashDrawer, fmtStorageBytes } from "@/components/shared/StorageTrashDrawer";
import {
  BOX_RE,
  clampSlotsForKind,
  DEFAULT_SANDBOX_IDLE_PAUSE_S,
  DEFAULT_SANDBOX_MAX_HOURS,
  DEFAULT_SANDBOX_TEMPLATE,
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_REMOTE_DIR,
  DEFAULT_SSH_USER,
  formatRenderNodeSubtitle,
  getRenderKindMeta,
  HOST_RE,
  maxSlotsForKind,
  NODE_ID_RE,
} from "@/lib/renderLanes";
import { StudioTabs } from "@/components/layout/StudioTabs";
import "./studio.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
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
type UiStage = StageId | "tts";
type CapName = "vision" | "writer" | "reasoning" | "tts" | "image" | "json" | "streaming";
type VertexAuthMode = "vertex-service-account" | "vertex-oauth";

const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
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
        providerLabel: matched.label || matched.id,
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

interface VoiceChoice {
  id: string;
  providerId: string;
  providerLabel: string;
  voiceId: string;
  voiceLabel: string;
  engine: string;
  costNotice: string;
}

interface ServiceAccountPreview {
  projectId: string;
  clientEmail: string;
  json: string;
}

const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: "all", label: "All" },
  { id: "cloud-api", label: "Cloud API" },
  { id: "subscription", label: "Subscription" },
  { id: "cloud-iam", label: "Vertex IAM" },
  { id: "local", label: "Local" },
  { id: "tts", label: "TTS" },
];

const STAGE_META: Array<{ id: UiStage; title: string; purpose: string; gate: "vision" | "text" | "tts" }> = [
  { id: "reader", title: "Reader", purpose: "Panel vision extraction", gate: "vision" },
  { id: "matcher", title: "Matcher", purpose: "Contact-sheet and semantic matching", gate: "vision" },
  { id: "writer", title: "Writer", purpose: "Recap and story script", gate: "text" },
  { id: "scout", title: "Scout", purpose: "Promo, watermark, and credit detection", gate: "vision" },
  { id: "fact_check", title: "Fact Check", purpose: "Deterministic rules plus optional LLM verify", gate: "text" },
  { id: "tts", title: "TTS", purpose: "Voice narration engine. Chain is held for this session.", gate: "tts" },
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
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "Request failed";
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
    temperature: stage === "writer" ? 0.6 : stage === "tts" ? 1 : 0.2,
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

export function StudioPage() {
  useEffect(() => {
    document.body.classList.add("studio-theme");
    return () => document.body.classList.remove("studio-theme");
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [privileged, setPrivileged] = useState(true);
  const [presets, setPresets] = useState<Record<string, ProviderPreset>>({});
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [stages, setStages] = useState<StagesState | null>(null);
  const [nodes, setNodes] = useState<RenderNode[]>([]);
  const [workers, setWorkers] = useState<PipelineWorker[]>([]);
  const [systemSnap, setSystemSnap] = useState<PipelineStatus["system"] | null>(null);
  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [promptsState, setPromptsState] = useState<StudioPromptsState | null>(null);
  const [settingsState, setSettingsState] = useState<StudioSettingsState | null>(null);

  const refreshAudit = useCallback(() => {
    void api.studio
      .audit()
      .then((res) => setAuditEntries(res.entries || []))
      .catch(() => {});
  }, []);

  async function reload() {
    const [session, catalog, intake, auditRes, promptsRes, settingsRes] = await Promise.all([
      api.session().catch(() => null),
      api.studio.catalog(),
      api.intake.catalog().catch(() => null),
      api.studio.audit().catch(() => null),
      api.studio.getPrompts().catch(() => null),
      api.studio.getSettings().catch(() => null),
    ]);
    if (session) setPrivileged(session.privileged);
    setPresets(catalog.presets || {});
    setProviders(catalog.providers || []);
    setStages(catalog.stages);
    setNodes(catalog.nodes || []);
    if (auditRes) setAuditEntries(auditRes.entries || []);
    if (promptsRes || catalog.prompts) setPromptsState(promptsRes || catalog.prompts || null);
    if (settingsRes || catalog.settings) setSettingsState(settingsRes || catalog.settings || null);
    if (intake) {
      const next: VoiceChoice[] = [];
      for (const raw of intake.providers || []) {
        const providerId = typeof raw.id === "string" ? raw.id : "";
        const providerLabel = typeof raw.label === "string" ? raw.label : providerId;
        const engine = typeof raw.engine === "string" ? raw.engine : providerId;
        const costNotice = typeof raw.costNotice === "string" ? raw.costNotice : "";
        const list = Array.isArray(raw.voices) ? raw.voices : [];
        for (const voice of list) {
          if (!voice || typeof voice !== "object") continue;
          const voiceId = typeof (voice as { id?: unknown }).id === "string" ? (voice as { id: string }).id : "";
          if (!providerId || !voiceId) continue;
          const voiceLabel =
            typeof (voice as { label?: unknown }).label === "string" ? (voice as { label: string }).label : voiceId;
          next.push({
            id: `${providerId}:${voiceId}`,
            providerId,
            providerLabel,
            voiceId,
            voiceLabel,
            engine,
            costNotice,
          });
        }
      }
      setVoices(next);
    }
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
    loadWorkers();
    const timer = window.setInterval(loadWorkers, 5000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <AppShell
      active="studio"
      eyebrow="Workspace"
      title="Studio"
      actions={
        <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#a2a19f]">
          {privileged ? "Admin" : "Read-only"}
        </Badge>
      }
    >
      <header className="studio-heading">
        <div className="flex flex-wrap items-center gap-3">
          <h1>Studio</h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="cap">
              <Server size={14} aria-hidden />
              {providers.filter((p) => p.auth.hasSecret || p.auth.mode === "none").length}/{providers.length} Providers
            </span>
            <span className="cap">
              <Box size={14} aria-hidden />
              {nodes.filter((n) => n.enabled).length} Nodes
            </span>
            <span className="cap">
              <AudioLines size={14} aria-hidden />
              {voices.length} Voices
            </span>
          </div>
        </div>
        <a href="/status.html" className="studio-pipeline-link"><Activity size={16} aria-hidden /> Pipeline</a>
      </header>
      {error ? <div className="studio-message" role="alert"><span>{error}</span><Button variant="outline" onClick={() => {
        setError(""); setLoading(true);
        void reload().catch((err) => setError(errText(err))).finally(() => setLoading(false));
      }}>Retry loading</Button></div> : null}
      {notice ? <div className="studio-message" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice("")}>×</button></div> : null}
      {!privileged ? (
        <p className="mb-4 rounded-xl border border-[#605139] bg-[#2a241b] px-3 py-2 text-sm text-[#d6b57b]">
          Temporary viewing accounts can look, not change studio settings.
        </p>
      ) : null}
      {loading ? (
        <div className="studio-loading" role="status"><RotateCcw size={20} aria-hidden /><span>Loading Studio settings…</span></div>
      ) : (
        <>
          <StudioTabs
            tabs={[
              {
                id: "providers",
                label: "Providers",
                icon: <Server />,
                content: (
                  <ProvidersTab
                    stages={stages}
                    presets={presets}
                    providers={providers}
                    privileged={privileged}
                    onChange={(next) => {
                      setProviders(next);
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
                icon: <Activity />,
                content: (
                  <RoutingTab
                    providers={providers}
                    voices={voices}
                    stages={stages}
                    privileged={privileged}
                    onProvidersChange={(next) => {
                      setProviders(next);
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
                icon: <Box />,
                content: (
                  <NodesTab
                    system={systemSnap}
                    nodes={nodes}
                    workers={workers}
                    privileged={privileged}
                    settings={settingsState}
                    onSettingsSaved={(next) => {
                      setSettingsState(next);
                      refreshAudit();
                    }}
                    onChange={(next) => {
                      setNodes(next);
                      refreshAudit();
                    }}
                    onNotice={setNotice}
                  />
                ),
              },
              {
                id: "voice",
                label: "Voice",
                icon: <AudioLines />,
                content: <VoiceTab voices={voices} privileged={privileged} />,
              },
              {
                id: "prompts",
                label: "Prompts",
                icon: <FileText />,
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
            ]}
          />
          <details
            className="studio-audit"
            open={auditOpen}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              setAuditOpen(next);
              if (next) refreshAudit();
            }}
          >
            <summary className="cursor-pointer font-serif text-lg text-[#f2efe9]">
              Change history <span className="studio-count">{auditEntries.length}</span>
            </summary>
            <div className="mt-3">
              <Terminal>
                <TerminalHeader>studio-audit.log</TerminalHeader>
                <TerminalBody>
                  {auditEntries.length === 0 ? (
                    <TerminalLine className="text-[#a2a19f]">No audit entries recorded yet.</TerminalLine>
                  ) : (
                    auditEntries.map((entry, index) => (
                      <TerminalLine key={`${entry.at}-${entry.revision}-${index}`}>
                        {`${new Date(entry.at).toISOString()}  [${entry.user}]  ${entry.action}  ${entry.target}  (rev ${entry.revision})`}
                      </TerminalLine>
                    ))
                  )}
                </TerminalBody>
              </Terminal>
            </div>
          </details>
        </>
      )}
    </AppShell>
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
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] px-3 py-2 text-xs text-[#a2a19f]">
        <span>Not connected</span>
        <span className="font-mono text-[11px]">
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
    <div className="mt-2.5 flex flex-col gap-2 rounded-xl border border-[#5eead4]/40 bg-[#5eead4]/10 px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-[#5eead4]/20 px-2 py-0.5 font-mono text-[11px] font-semibold text-[#5eead4]">
            <Check className="size-3" aria-hidden /> Connected
          </span>
          <strong className="break-all font-medium text-[#f2efe9]">{primaryIdentity}</strong>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-md border border-[#5eead4]/30 bg-[#101113]/60 px-2 py-0.5 font-mono text-[11px] text-[#5eead4]">
            {planOrProjectPill}
          </span>
          {provider.auth.accountPlan && provider.auth.projectId ? (
            <span className="rounded-md border border-[#5eead4]/30 bg-[#101113]/60 px-2 py-0.5 font-mono text-[11px] text-[#5eead4]">
              Project: {provider.auth.projectId}
            </span>
          ) : null}
        </div>
      </div>
      {detectedProjects.length > 1 && onSelectProject ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-[#5eead4]/20 pt-2">
          <label htmlFor={`connected-gcp-proj-${provider.id}`} className="font-mono text-[11px] text-[#a2a19f]">
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

function ProvidersTab({
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
  onNotice: (message: string) => void;
}) {
  const [filter, setFilter] = useState<FilterId>("all");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderView | null>(null);
  const [probing, setProbing] = useState("");
  const [syncingAll, setSyncingAll] = useState(false);
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({});
  const [newModelId, setNewModelId] = useState<Record<string, string>>({});
  const [newModelEffort, setNewModelEffort] = useState<Record<string, ReasoningEffort>>({});
  const [newModelCaps, setNewModelCaps] = useState<Record<string, Record<CapName, boolean>>>({});

  const shown = providers.filter((provider) => {
    if (filter === "all") return true;
    if (filter === "tts") {
      return provider.kind === "tts" || provider.models.some((model) => model.capabilities?.tts);
    }
    return kindOf(provider) === filter;
  });

  async function test(id: string) {
    setProbing(id);
    try {
      const result = await api.studio.testProvider(id);
      const fresh = await api.studio.providers();
      onChange(fresh.providers);
      onNotice(result.ok ? `${id} answered in ${formatLatency(result.latencyMs)}` : result.error || "Probe failed");
    } catch (error) {
      onNotice(errText(error));
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
      onNotice(errText(error));
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
      onNotice(errText(error));
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
      onNotice(errText(error));
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1" role="toolbar" aria-label="Filter providers">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn("chip", filter === item.id && "is-on")}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 flex-1 sm:flex-initial"
            disabled={!privileged || syncingAll || providers.length === 0}
            onClick={() => void syncAllModels()}
          >
            <RotateCcw className={cn("size-3.5", syncingAll && "animate-spin")} />
            {syncingAll ? "Syncing…" : "Sync"}
          </Button>
          <Button
            type="button"
            className="min-h-11 flex-1 sm:flex-initial"
            disabled={!privileged}
            onClick={() => {
              setEditing(null);
              setOpen(true);
            }}
          >
            + Add
          </Button>
        </div>
      </div>
      <div className="studio-provider-list">
        {shown.map((provider) => {
          const meter = latencyFill(provider.lastTest?.latencyMs ?? null, provider.lastTest ? provider.lastTest.ok : null);
          const isExpanded = Boolean(expandedModels[provider.id]);
          const visibleModels = isExpanded ? provider.models : provider.models.slice(0, 4);
          const isSub =
            kindOf(provider) === "subscription" ||
            presets[provider.preset || provider.id]?.category === "subscription" ||
            SUBSCRIPTION_PROVIDER_IDS.has(provider.id) ||
            SUBSCRIPTION_PROVIDER_IDS.has(provider.preset || "");
          const subSuggestions = buildSubscriptionSuggestions(provider, presets, isSub);
          const draftCaps = draftCapsFor(provider.id);
          const draftEffort = newModelEffort[provider.id] || "medium";
          return (
            <article
              key={provider.id}
              className="desk-card studio-provider"
            >
              <div className="studio-provider-identity flex flex-wrap items-start gap-3 sm:flex-nowrap">
                <span className="mono-mark" aria-hidden>{monogram(provider.label)}</span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-serif text-xl leading-none">
                    {provider.label}
                  </h3>
                  <p className="mt-1 break-all font-mono text-xs text-[#a2a19f]">{formatProviderEndpoint(provider)}</p>
                </div>
                <div className={cn("probe", `is-${meter.tone}`)} title={provider.lastTest ? `HTTP ${provider.lastTest.status}` : "Not tested"}>
                  <span className={cn("bars", probing === provider.id && "is-live")} aria-hidden>
                    {[0, 1, 2, 3, 4].map((bar) => (
                      <i key={bar} className={bar < meter.bars ? "on" : ""} />
                    ))}
                  </span>
                  <span className="font-mono text-xs">
                    {probing === provider.id ? "Checking…" : provider.lastTest ? `${provider.lastTest.ok ? "Connected" : "Failed"} · ${formatLatency(provider.lastTest.latencyMs)}` : "Not tested"}
                  </span>
                </div>
              </div>
              <div className="studio-provider-meta">
                <ConnectedAccountBanner
                  provider={provider}
                  projects={provider.auth.projects}
                  privileged={privileged}
                  showDisconnected
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
                      .catch((err) => onNotice(errText(err)));
                  }}
                />
              </div>
              <details className="studio-provider-details">
                <summary>Models &amp; access <span>{provider.models.length} {provider.models.length === 1 ? "model" : "models"}</span></summary>
                <ul className="studio-model-list mt-3 flex flex-col gap-2" aria-label={`Models in ${provider.label}`}>
                  {visibleModels.map((model) => {
                    const cleanModelId = stripProviderPrefixUi(model.id, provider.id);
                    const laneId = `${provider.id}:${cleanModelId}`;
                    const wantsVision = Boolean(model.capabilities?.vision);
                    const wantsWriter = Boolean(model.capabilities?.writer);
                    const isReaderActive = stages?.reader?.primary === laneId || stages?.reader?.chain?.[0] === laneId;
                    const isWriterActive = stages?.writer?.primary === laneId || stages?.writer?.chain?.[0] === laneId;
                    const isFullyActive = (wantsVision || wantsWriter) && (!wantsVision || isReaderActive) && (!wantsWriter || isWriterActive);
                    const isPartiallyActive = !isFullyActive && ((wantsVision && isReaderActive) || (wantsWriter && isWriterActive));
                    const capTags = (["vision", "writer", "reasoning", "tts"] as const).filter(
                      (cap) => model.capabilities?.[cap],
                    );
                    return (
                      <li key={model.id} className="rounded-lg bg-[#101113] px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <strong className="font-mono text-xs font-semibold text-[#f2efe9]">{cleanModelId}</strong>
                            {model.contextWindow ? (
                              <span className="rounded bg-[#17181a] px-1.5 py-0.5 font-mono text-[10px] text-[#a2a19f]">
                                {Math.round(model.contextWindow / 1000)}k
                              </span>
                            ) : null}
                            {capTags.map((cap) => (
                              <span
                                key={cap}
                                className="rounded bg-[#17181a] px-1.5 py-0.5 font-mono text-[10px] text-[#a2a19f]"
                              >
                                {cap}
                              </span>
                            ))}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {isFullyActive ? <span className="cap is-on">Active</span> : null}
                            {isPartiallyActive ? <span className="cap is-on">{isReaderActive ? "Vision" : "Writer"}</span> : null}
                            {!isFullyActive && (wantsVision || wantsWriter) ? (
                              <Button type="button" size="sm" variant="outline" className="min-h-8 px-2.5 text-xs" disabled={!privileged} onClick={() => void activateModelForStages(provider, cleanModelId)}>Use</Button>
                            ) : null}
                            {model.capabilities?.reasoning ? (
                              <select
                                className="field min-h-8 w-auto px-2 py-1 font-mono text-xs"
                                aria-label={`Reasoning effort for ${cleanModelId}`}
                                value={model.reasoningEffort || "medium"}
                                disabled={!privileged}
                                onChange={(event) =>
                                  void updateReasoningEffort(
                                    provider,
                                    model.id,
                                    event.target.value as ReasoningEffort,
                                  ).catch((error) => onNotice(errText(error)))
                                }
                              >
                                {REASONING_EFFORTS.map((effort) => (
                                  <option key={effort} value={effort}>
                                    {effort}
                                  </option>
                                ))}
                              </select>
                            ) : null}
                            {provider.models.length > 1 ? (
                              <button
                                type="button"
                                className="inline-flex min-h-8 min-w-8 items-center justify-center rounded text-xs text-[#a2a19f] hover:text-[#f0a096]"
                                aria-label={`Remove model ${cleanModelId}`}
                                disabled={!privileged}
                                onClick={() =>
                                  void removeProviderModel(provider, model.id).catch((error) => onNotice(errText(error)))
                                }
                              >
                                ×
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                {provider.models.length > 4 ? (
                  <button
                    type="button"
                    className="mt-2 self-start text-xs text-[#5eead4] hover:underline"
                    aria-expanded={isExpanded}
                    onClick={() =>
                      setExpandedModels((current) => ({ ...current, [provider.id]: !current[provider.id] }))
                    }
                  >
                    {isExpanded ? "Show fewer models" : `Show all ${provider.models.length} models`}
                  </button>
                ) : null}
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer select-none py-1 text-[#a2a19f] hover:text-[#f2efe9]">
                    Add or customize model
                  </summary>
                  <div className="mt-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-2.5">
                    {subSuggestions.length > 0 ? (
                      <div className="mb-2 flex flex-wrap gap-1">
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
                                  onNotice(errText(error)),
                                )
                              }
                            >
                              <Plus className="size-3" /> {cleanTplId} ({tpl.reasoningEffort})
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <input
                        className="field min-h-11 min-w-[160px] flex-1 font-mono text-xs"
                        aria-label={`New model ID for ${provider.label}`}
                        placeholder="Model ID (e.g. gpt-6.1-sol, claude-sonnet-4)"
                        value={newModelId[provider.id] || ""}
                        disabled={!privileged}
                        onChange={(event) =>
                          setNewModelId((current) => ({ ...current, [provider.id]: event.target.value }))
                        }
                      />
                      <select
                        className="field min-h-11 w-auto font-mono text-xs"
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
                        className="min-h-11 w-full sm:w-auto"
                        disabled={!privileged || !(newModelId[provider.id] || "").trim()}
                        onClick={() =>
                          void addProviderModel(provider, {
                            id: newModelId[provider.id] || "",
                            reasoningEffort: draftEffort,
                            capabilities: draftCaps,
                          }).catch((error) => onNotice(errText(error)))
                        }
                      >
                        <Plus className="size-3.5" /> Add model
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={`New model capabilities for ${provider.label}`}>
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
                </details>
                <AuthFlow provider={provider} privileged={privileged} onChange={onChange} onNotice={onNotice} />
              </details>
              <div className="studio-provider-actions mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" className="min-h-11 flex-1 sm:flex-initial md:min-h-8" disabled={!privileged || probing === provider.id} onClick={() => void test(provider.id)}>
                  Test
                </Button>
                <Button type="button" variant="outline" size="sm" className="min-h-11 flex-1 sm:flex-initial md:min-h-8" disabled={!privileged || probing === provider.id} onClick={() => void discover(provider.id)}>
                  <RotateCcw className={cn("size-3.5", probing === provider.id && "animate-spin")} /> Sync
                </Button>
                <Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" disabled={!privileged} onClick={() => { setEditing(provider); setOpen(true); }}>
                  Edit
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
                      onNotice(`${provider.label} removed`);
                    } catch (error) {
                      onNotice(errText(error));
                    }
                  }}
                />
              </div>
            </article>
          );
        })}
      </div>
      {shown.length === 0 ? <div className="studio-empty"><Server size={28} aria-hidden /><h3>{providers.length ? "No matching providers" : "No providers"}</h3></div> : null}
      <ProviderDialog
        open={open}
        presets={presets}
        editing={editing}
        privileged={privileged}
        onOpenChange={setOpen}
        onSaved={(next) => {
          onChange(next);
          onNotice("Provider saved. Secret fields were cleared.");
        }}
        onStagesSaved={onStagesSaved}
        onNotice={onNotice}
      />
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
  onNotice: (message: string) => void;
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
        onNotice(errText(error));
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
            onNotice(errText(error));
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
                onNotice(errText(error));
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
        <div className="flex flex-col gap-1 text-xs text-[#a2a19f]">
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
                .catch((error) => onNotice(errText(error)));
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
                    onNotice(errText(error));
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
      <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs tracking-[0.14em] text-[#a2a19f] uppercase">OAuth PKCE · {provider.label}</p>
          {provider.auth.hasSecret ? (
            <button type="button" className="text-xs text-[#a2a19f] hover:text-[#f2efe9]" onClick={() => setReauthOpen(false)}>
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
                onNotice(errText(error));
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
                className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto md:min-h-8"
              >
                Open sign-in link
              </a>
              <CopyButton value={loginUrl} label="Copy link" />
            </>
          ) : null}
        </div>
        {loginUrl ? <p className="break-all font-mono text-[11px] text-[#5eead4]">{loginUrl}</p> : null}
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
              }).catch((error) => onNotice(errText(error)));
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
      <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs tracking-[0.14em] text-[#a2a19f] uppercase">Device code · {provider.label}</p>
          {provider.auth.hasSecret ? (
            <button type="button" className="text-xs text-[#a2a19f] hover:text-[#f2efe9]" onClick={() => setReauthOpen(false)}>
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
                onNotice(errText(error));
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
              className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 break-all text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto md:min-h-8"
            >
              Open verification
            </a>
          ) : null}
        </div>
        {userCode ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 py-2">
            <span className="font-mono text-2xl tracking-[0.2em] text-[#f2efe9]">{userCode}</span>
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
                .catch((error) => onNotice(errText(error)))
                .finally(() => {
                  pollInFlightRef.current = false;
                });
            }}
          >
            Connect
          </Button>
          {pending ? (
            <span className="font-mono text-xs text-[#5eead4]">
              Polling · {waited.toFixed(0)}s
            </span>
          ) : null}
        </div>
        {subKey === "codex-oauth" ? (
          <details className="mt-1 text-xs text-[#a2a19f]">
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
                        onNotice(errText(error));
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
                      className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto md:min-h-8"
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
                      .catch((error) => onNotice(errText(error)));
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
    <div className="mt-3 flex flex-col gap-2.5 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs tracking-[0.14em] text-[#a2a19f] uppercase">GCP Vertex AI Sign-In</p>
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
              className="ml-1 text-xs text-[#a2a19f] hover:text-[#f2efe9]"
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
          {sa ? <p className="mt-2 font-mono text-xs text-[#aed1a8]">{sa.clientEmail} · {sa.projectId}</p> : null}
          {saError ? <p className="mt-2 text-xs text-[#f0a096]" role="alert">{saError}</p> : null}
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
                .catch((error) => onNotice(errText(error)));
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
                    onNotice(errText(error));
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
                  className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto md:min-h-8"
                >
                  Open sign-in link
                </a>
                <CopyButton value={loginUrl} label="Copy URL" />
              </>
            ) : null}
          </div>
          {loginUrl ? <p className="break-all font-mono text-[11px] text-[#5eead4]">{loginUrl}</p> : null}
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
                    onNotice(errText(error));
                  }
                })();
              }}
            >
              Connect
            </Button>
          </div>
          <details className="mt-1 text-xs text-[#a2a19f]">
            <summary className="cursor-pointer select-none">
              Advanced settings (Location / Custom Client ID)
            </summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-[#a2a19f]">
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
              <label className="text-xs text-[#a2a19f]">
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
                <label className="text-xs text-[#a2a19f] sm:col-span-2">
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
                        .catch((err) => onNotice(errText(err)));
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
              <label className="text-xs text-[#a2a19f] sm:col-span-2">
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
          {error ? <p className="text-xs text-[#f0a096]" role="alert">{error}</p> : null}
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

function ProviderDialog({
  open,
  presets,
  editing,
  privileged,
  onOpenChange,
  onSaved,
  onStagesSaved,
  onNotice,
}: {
  open: boolean;
  presets: Record<string, ProviderPreset>;
  editing: ProviderView | null;
  privileged: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (providers: ProviderView[]) => void;
  onStagesSaved?: (stages: StagesState) => void;
  onNotice: (message: string) => void;
}) {
  const [mode, setMode] = useState<FilterId>("cloud-api");
  const [presetId, setPresetId] = useState("openrouter");
  const [id, setId] = useState("openrouter");
  const [label, setLabel] = useState("OpenRouter");
  const [baseUrl, setBaseUrl] = useState("https://openrouter.ai/api/v1");
  const [apiKey, setApiKey] = useState("");
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [headersText, setHeadersText] = useState("");
  const [routeStages, setRouteStages] = useState(true);
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
    if (!open) {
      setDevicePolling(false);
      return;
    }
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
    setRouteStages(true);
    setFormError("");
    setDialogConnectedProvider(editing);
    setHeadersText(editing?.headers ? JSON.stringify(editing.headers, null, 2) : "");
    if (editing) {
      const nextMode = kindOf(editing);
      setMode(nextMode === "all" || nextMode === "tts" ? "cloud-api" : nextMode);
      setId(editing.id);
      setLabel(editing.label);
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
  }, [open, editing, presets]);

  function applyPreset(preset: ProviderPreset | undefined, fallbackId: string, fallbackMode?: FilterId) {
    const fallbackSub = FALLBACK_SUBSCRIPTION_PRESETS.find((item) => item.id === fallbackId);
    const resolved = preset || fallbackSub;
    const nextId = resolved?.id || fallbackId;
    setPresetId(nextId);
    setId(editing ? editing.id : nextId);
    if (!editing) setDialogConnectedProvider(null);
    setLabel(
      resolved?.label ||
        (nextId === "vertex-ai" ? "Google Cloud Vertex AI" : nextId === "ollama" ? "Ollama" : nextId),
    );
    setBaseUrl(
      resolved?.baseUrl ||
        (nextId === "ollama"
          ? "http://127.0.0.1:11434/v1"
          : nextId === "vertex-ai"
            ? "https://aiplatform.googleapis.com/v1"
            : "https://openrouter.ai/api/v1"),
    );
    setAllowPrivate(Boolean(resolved?.allowPrivateNetwork || nextId === "subscription-bridge" || nextId === "ollama" || fallbackMode === "local"));
    const derivedMode =
      resolved?.category === "local" || resolved?.category === "subscription" || resolved?.category === "cloud-iam"
        ? resolved.category
        : fallbackMode || (SUBSCRIPTION_PROVIDER_IDS.has(nextId) ? "subscription" : nextId === "vertex-ai" ? "cloud-iam" : "cloud-api");
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

  async function upsertCurrentProviderRecord(): Promise<{ provider: ProviderView; providers: ProviderView[] }> {
    const body = {
      id,
      label,
      preset: presetId,
      kind: mode,
      baseUrl,
      allowPrivateNetwork: allowPrivate || presetId === "subscription-bridge",
      auth: mode === "cloud-iam" || presetId === "vertex-ai"
        ? {
            mode: vertexMode,
            clientId: vertexClientId.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
            projectId: (vertexMode === "vertex-service-account" ? sa?.projectId : vertexProjectId.trim()) || vertexProjectId.trim() || undefined,
            location: vertexLocation || "global",
          }
        : undefined,
      expectedRevision: editing?.revision,
    };
    const res = editing ? await api.studio.updateProvider(editing.id, body) : await api.studio.createProvider(body);
    return { provider: res.provider, providers: res.providers };
  }

  async function finishProviderActivation(savedProvider: ProviderView | null | undefined, allProviders: ProviderView[], message: string) {
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
    onSaved(latestProviders);
    setDialogConnectedProvider(latestProvider);
    const syncNote = syncedCount > 0 ? ` Synced ${syncedCount} models from /models.` : "";
    onNotice(routeStages ? `${message}${syncNote} Pipeline stages routed to ${label || targetId}.` : `${message}${syncNote}`);
    const keepOAuthDialogOpen = !editing && (
      (mode === "subscription" && presetId !== "subscription-bridge") ||
      (mode === "cloud-iam" && vertexMode === "vertex-oauth")
    );
    if (!keepOAuthDialogOpen) onOpenChange(false);
  }

  useEffect(() => {
    if (!open || !devicePolling || mode !== "subscription" || !DEVICE_CODE_PROVIDER_IDS.has(presetId)) return;
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
  }, [open, devicePolling, mode, presetId, id, routeStages]);

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
          ? "Click '1. Open Claude Sign-In' first so PKCE can exchange this code."
          : "Click 'Open ChatGPT Browser Redirect' first so PKCE can exchange this code.",
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

  async function submit() {
    if (isJustConnectedOAuth) {
      onOpenChange(false);
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
    if (mode === "cloud-iam" && vertexMode === "vertex-oauth" && !vertexOauthToken.trim() && !editing?.auth.hasSecret) {
      if (!vertexLoginUrl) await startGoogleSignIn();
      else setFormError("Paste the Google verification code (4/0A...) in Step 2 to connect.");
      return;
    }
    setFormError("");
    if (mode === "cloud-api" && (!editing || !editing.auth.hasSecret) && !apiKey.trim()) {
      setFormError("Enter an API key to verify and add this provider.");
      return;
    }
    if (!NODE_ID_RE.test(id)) {
      setFormError("Id must start with a letter or digit and stay under 64 characters.");
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
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Headers must be a JSON object");
        headers = Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]));
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
        id,
        label,
        preset: presetId,
        kind: mode,
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
              projectId: (vertexMode === "vertex-service-account" ? sa?.projectId : vertexProjectId.trim()) || vertexProjectId.trim() || undefined,
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
      };
      const secret = apiKey || vertexOauthToken;
      let result = editing
        ? await api.studio.updateProvider(editing.id, body)
        : await api.studio.createProvider(body);
      setApiKey("");
      setVertexOauthToken("");
      if (isVertexDialog && vertexMode === "vertex-oauth" && trimmedVertexToken) {
        const exRes = await api.studio.pkceExchange({
          providerId: id,
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
      const savedProvider = result.providers.find((p) => p.id === id) || result.provider;
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

  async function startGoogleSignIn() {
    setFormError("");
    setBusy(true);
    const popup = openAsyncPopup();
    try {
      const customClientId = vertexClientId.trim();
      const start = await api.studio.pkceStart({
        providerId: id || "vertex-ai", mode: "vertex-oauth", preset: "vertex-ai",
        ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID ? { clientId: customClientId } : {}),
      });
      const resolvedClientId = customClientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
      const url = start.authorizeUrl || `https://accounts.google.com/o/oauth2/auth?client_id=${encodeURIComponent(resolvedClientId)}&redirect_uri=${encodeURIComponent("https://sdk.cloud.google.com/applicationdefaultauthcode.html")}&scope=${encodeURIComponent("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform")}&response_type=code&access_type=offline&prompt=consent&token_usage=remote`;
      setVertexVerifier(start.codeVerifier);
      setVertexLoginUrl(url);
      if (popup && !popup.closed) popup.location.href = url;
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      popup?.close();
      setFormError(errText(error));
    } finally { setBusy(false); }
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
  const isJustConnectedOAuth = !editing && Boolean(dialogConnectedProvider?.auth.hasSecret) && (
    (mode === "subscription" && presetId !== "subscription-bridge" && !subCodeOrUrl.trim()) ||
    (mode === "cloud-iam" && vertexMode === "vertex-oauth" && !vertexOauthToken.trim())
  );
  const requiresCloudApiKey =
    mode === "cloud-api" && (!activeDialogProvider || !activeDialogProvider.auth.hasSecret) && !apiKey.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="studio-dialog sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">{editing ? `Edit ${editing.label}` : "Add provider"}</DialogTitle>
          <DialogDescription className="sr-only">Configure provider connection</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Connection mode">
          {FILTERS.filter((item) => item.id !== "all" && item.id !== "tts").map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn("chip", mode === item.id && "is-on")}
              aria-pressed={mode === item.id}
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
                  const firstSub =
                    subscriptionPresetOptions[0] ||
                    presets["codex-oauth"];
                  applyPreset(firstSub, firstSub?.id || "codex-oauth", "subscription");
                } else if (item.id === "cloud-iam") {
                  const firstIam =
                    presets["vertex-ai"] ||
                    presetList.find((p) => p.category === "cloud-iam");
                  applyPreset(firstIam, firstIam?.id || "vertex-ai", "cloud-iam");
                } else if (item.id === "local") {
                  const firstLocal =
                    presets.ollama ||
                    presetList.find((p) => p.category === "local");
                  applyPreset(firstLocal, firstLocal?.id || "ollama", "local");
                }
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {mode === "local" ? (
          <div className="flex flex-wrap gap-2">
            {localPresetList.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn("chip", presetId === item.id && "is-on")}
                onClick={() => {
                  applyPreset(presets[item.id], item.id, "local");
                  setBaseUrl(item.baseUrl);
                  setAllowPrivate(true);
                  setMode("local");
                }}
              >
                {item.label} :{item.port}
              </button>
            ))}
          </div>
        ) : (
          <label className="flex flex-col gap-1 text-sm">
            Preset
            <select
              className="field min-h-11"
              value={presetId}
              onChange={(event) => {
                const nextId = event.target.value;
                const found =
                  subscriptionPresetOptions.find((item) => item.id === nextId) ||
                  presets[nextId];
                applyPreset(found, nextId, mode);
              }}
            >
              {(mode === "subscription"
                ? subscriptionPresetOptions
                : presetList.filter((preset) =>
                    mode === "cloud-api" ? preset.category === "cloud-api" : preset.category === "cloud-iam",
                  )
              ).map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
          </label>
        )}

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
                    clientId: vertexClientId.trim() || activeDialogProvider.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
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
                  onSaved(nextProviders);
                  onNotice(`Switched Vertex project to ${nextProject}`);
                })
                .catch((err) => setFormError(errText(err)));
            }}
          />
        ) : null}

        {mode === "subscription" ? (
          <div className="flex flex-col gap-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-3.5">
            {DEVICE_CODE_PROVIDER_IDS.has(presetId) ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap is-on">Step 1</span>
                  <Button
                    type="button"
                    className="min-h-11 w-full sm:w-auto"
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
                      className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 break-all text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                    >
                      Open {deviceVerifyUri}
                    </a>
                  ) : null}
                </div>
                {deviceUserCode ? (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 py-2">
                    <span className="font-mono text-2xl tracking-[0.2em] text-[#f2efe9]">{deviceUserCode}</span>
                    <CopyButton value={deviceUserCode} label="Copy code" />
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap">Step 2</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={!privileged || busy || !deviceUserCode}
                    onClick={() => void verifySubscriptionDeviceFlow()}
                  >
                    Connect
                  </Button>
                  {devicePolling ? (
                    <span className="font-mono text-xs text-[#5eead4]">
                      Polling · {deviceWaited.toFixed(0)}s
                    </span>
                  ) : null}
                </div>
                {presetId === "codex-oauth" ? (
                  <details className="mt-1 text-xs text-[#a2a19f]">
                    <summary className="cursor-pointer select-none">Browser redirect (PKCE)</summary>
                    <div className="mt-2 flex flex-col gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="cap is-on">Step 1</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 w-full sm:w-auto"
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
                              className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                            >
                              Open sign-in link
                            </a>
                            <CopyButton value={subLoginUrl} label="Copy link" />
                          </>
                        ) : null}
                      </div>
                      {subLoginUrl ? <p className="break-all font-mono text-xs text-[#5eead4]">{subLoginUrl}</p> : null}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="cap">Step 2</span>
                        <input
                          className="field min-h-11 flex-1 font-mono"
                          aria-label="Callback URL or code"
                          value={subCodeOrUrl}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Callback URL or code"
                          onChange={(event) => setSubCodeOrUrl(event.target.value)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-11 w-full sm:w-auto"
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
                    className="min-h-11 w-full sm:w-auto"
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
                        className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                      >
                        Open sign-in link
                      </a>
                      <CopyButton value={subLoginUrl} label="Copy link" />
                    </>
                  ) : null}
                </div>
                {subLoginUrl ? <p className="break-all font-mono text-xs text-[#5eead4]">{subLoginUrl}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap">Step 2</span>
                  <input
                    className="field min-h-11 flex-1 font-mono"
                    aria-label="Claude authorization code or setup token"
                    value={subCodeOrUrl}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="code#state or sk-ant-oat01-..."
                    onChange={(event) => setSubCodeOrUrl(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={!privileged || busy || !subCodeOrUrl.trim()}
                    onClick={() => void completeSubscriptionPkce()}
                  >
                    Connect
                  </Button>
                </div>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  Proxy Base URL
                  <input
                    className="field min-h-11 font-mono"
                    value={baseUrl}
                    spellCheck={false}
                    placeholder="http://127.0.0.1:8317/v1"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                </label>
                <div className="flex flex-col gap-1 text-sm">
                  <label htmlFor="dialog-bridge-token">Bearer Token</label>
                  <PasswordInput id="dialog-bridge-token" value={apiKey} onValueChange={setApiKey} disabled={!privileged}>
                    <PasswordInputField
                      className="min-h-11 font-mono [&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
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

        {mode === "cloud-api" ? (
          <div className="flex flex-col gap-1 text-sm">
            <label htmlFor="dialog-provider-api-key">API key</label>
            <PasswordInput id="dialog-provider-api-key" value={apiKey} onValueChange={setApiKey} disabled={!privileged}>
              <PasswordInputField
                className="min-h-11 font-mono [&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-..."
                toggleLabel={{ show: "Show API key", hide: "Hide API key" }}
              />
            </PasswordInput>
          </div>
        ) : null}

        {mode === "local" ? (
          <label className="flex flex-col gap-1 text-sm">
            Base URL
            <input className="field min-h-11 font-mono" value={baseUrl} spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
        ) : null}

        {mode === "local" || (mode !== "subscription" && baseUrl.startsWith("http://")) ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowPrivate} onChange={(event) => setAllowPrivate(event.target.checked)} />
            Allow private network
          </label>
        ) : null}

        {mode === "cloud-iam" ? (
          <div className="flex flex-col gap-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs tracking-[0.12em] text-[#a2a19f] uppercase">Vertex AI</span>
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
                  Service Account .json
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
                {sa ? <p className="mt-2 font-mono text-xs text-[#aed1a8]">{sa.clientEmail} · {sa.projectId}</p> : null}
                {saError ? <p className="mt-2 text-xs text-[#f0a096]" role="alert">{saError}</p> : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap is-on">Step 1</span>
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11 w-full sm:w-auto"
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
                        className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                      >
                        Open sign-in link
                      </a>
                      <CopyButton value={vertexLoginUrl} label="Copy URL" />
                    </>
                  ) : null}
                </div>
                {vertexLoginUrl ? <p className="break-all font-mono text-[11px] text-[#5eead4]">{vertexLoginUrl}</p> : null}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="cap">Step 2</span>
                  <input
                    className="field min-h-11 flex-1 font-mono"
                    aria-label="Google verification code"
                    value={vertexOauthToken}
                    placeholder="4/0A... code"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setVertexOauthToken(event.target.value)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={!privileged || busy || !vertexOauthToken.trim()}
                    onClick={() => {
                      const token = vertexOauthToken.trim();
                      const customClientId = vertexClientId.trim();
                      const isCodeOrCallback =
                        Boolean(token) &&
                        (token.startsWith("http://") ||
                          token.startsWith("https://") ||
                          (!token.startsWith("ya29.") && !token.startsWith("{")));
                      setFormError("");
                      setBusy(true);
                      void (async () => {
                        try {
                          await upsertCurrentProviderRecord();
                          const exRes = await api.studio.pkceExchange({
                            providerId: id || "vertex-ai",
                            mode: "vertex-oauth",
                            ...(isCodeOrCallback
                              ? { codeOrUrl: token, codeVerifier: vertexVerifier || undefined }
                              : { accessToken: token }),
                            ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID
                              ? { clientId: customClientId }
                              : {}),
                          });
                          if (isCodeOrCallback) setVertexVerifier("");
                          setVertexOauthToken("");
                          const detectedProjectId = exRes.provider?.auth?.projectId || exRes.projectId || "";
                          const detectedList = exRes.projects || exRes.provider?.auth?.projects || [];
                          if (detectedProjectId && !vertexProjectId.trim()) {
                            setVertexProjectId(detectedProjectId);
                          }
                          if (detectedList.length > 0) {
                            setVertexProjects(detectedList);
                          }
                          await api.studio.discoverModels(id || "vertex-ai", true).catch(() => null);
                          const fresh = await api.studio.providers();
                          const targetVertId = id || "vertex-ai";
                          const nextProviders =
                            detectedList.length > 0
                              ? fresh.providers.map((p) =>
                                  p.id === targetVertId ? { ...p, auth: { ...p.auth, projects: detectedList } } : p,
                                )
                              : fresh.providers;
                          const savedProv =
                            nextProviders.find((p) => p.id === targetVertId) || exRes.provider || null;
                          setDialogConnectedProvider(savedProv);
                          if (routeStages && savedProv) {
                            const nextStages = await autoRouteProviderStages(
                              savedProv,
                              targetVertId,
                              presets,
                              presetId,
                            ).catch(() => null);
                            if (nextStages) onStagesSaved?.(nextStages);
                          }
                          onSaved(nextProviders);
                          onNotice(
                            detectedProjectId
                              ? `Google Account connected · Auto-detected project ${detectedProjectId}.`
                              : "Google Account connected.",
                          );
                        } catch (error) {
                          setFormError(errText(error));
                        } finally {
                          setBusy(false);
                        }
                      })();
                    }}
                  >
                    Connect
                  </Button>
                </div>
                <details className="mt-1 text-xs text-[#a2a19f]">
                  <summary className="cursor-pointer select-none">
                    Advanced settings (Location / Custom Client ID)
                  </summary>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <label className="text-xs text-[#a2a19f]">
                      Location
                      <select
                        className="field mt-1 min-h-11 font-mono"
                        value={vertexLocation}
                        onChange={(event) => setVertexLocation(event.target.value)}
                      >
                        {VERTEX_LOCATIONS.map((loc) => (
                          <option key={loc} value={loc}>
                            {loc}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-xs text-[#a2a19f]">
                      Project ID (optional)
                      <input
                        className="field mt-1 min-h-11 font-mono"
                        value={vertexProjectId}
                        placeholder="Auto-detected on sign-in"
                        onChange={(event) => setVertexProjectId(event.target.value)}
                      />
                    </label>
                    {vertexProjects.length > 1 ? (
                      <label className="text-xs text-[#a2a19f] sm:col-span-2">
                        Switch detected GCP Project
                        <select
                          className="field mt-1 min-h-11 font-mono"
                          value={vertexProjectId}
                          onChange={(event) => setVertexProjectId(event.target.value)}
                        >
                          {vertexProjects.map((proj) => (
                            <option key={proj.projectId} value={proj.projectId}>
                              {proj.name ? `${proj.name} (${proj.projectId})` : proj.projectId}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="text-xs text-[#a2a19f] sm:col-span-2">
                      Google OAuth Client ID
                      <input
                        className="field mt-1 min-h-11 font-mono"
                        value={vertexClientId}
                        placeholder={DEFAULT_GOOGLE_OAUTH_CLIENT_ID}
                        onChange={(event) => setVertexClientId(event.target.value)}
                      />
                    </label>
                  </div>
                </details>
              </div>
            )}
          </div>
        ) : null}

        <label className="flex items-center gap-2 text-sm text-[#f2efe9]">
          <input
            type="checkbox"
            checked={routeStages}
            onChange={(event) => setRouteStages(event.target.checked)}
          />
          Auto-route stages
        </label>

        {mode !== "subscription" ? (
          <details
            className="text-xs text-[#a2a19f]"
            open={presetId === "custom" || presetId === "custom-openai"}
          >
            <summary className="cursor-pointer select-none">Advanced endpoint settings</summary>
            <div className="mt-2 flex flex-col gap-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-3 text-sm text-[#f2efe9]">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  Id
                  <input
                    className="field min-h-11 font-mono"
                    value={id}
                    disabled={Boolean(editing)}
                    onChange={(event) => setId(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  Label
                  <input
                    className="field min-h-11"
                    value={label}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Base URL
                <input
                  className="field min-h-11 font-mono"
                  value={baseUrl}
                  spellCheck={false}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Custom headers JSON
                <textarea
                  className="field mt-1 min-h-20 font-mono"
                  value={headersText}
                  onChange={(event) => setHeadersText(event.target.value)}
                  placeholder='{"HTTP-Referer":"https://example.com"}'
                />
              </label>
            </div>
          </details>
        ) : null}

        {formError ? <p className="text-sm text-[#f0a096]" role="alert">{formError}</p> : null}
        <DialogFooter className="flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            className="min-h-11 w-full sm:w-auto"
            disabled={!privileged || busy || requiresCloudApiKey}
            onClick={() => void submit()}
          >
            {busy
              ? "Saving…"
              : isJustConnectedOAuth
                ? "Done"
              : mode === "cloud-api"
                ? "Verify & Save"
                : mode === "subscription" && DEVICE_CODE_PROVIDER_IDS.has(presetId) && !editing?.auth.hasSecret
                  ? deviceUserCode ? "Check Authorization" : deviceButtonLabelFor(presetId)
                : mode === "subscription" && presetId === "claude-oauth" && (!editing?.auth.hasSecret || subCodeOrUrl.trim())
                  ? subCodeOrUrl.trim() ? "Connect" : "Open Claude Sign-In"
                : mode === "cloud-iam" && vertexMode === "vertex-oauth" && (!editing?.auth.hasSecret || vertexOauthToken.trim())
                  ? vertexOauthToken.trim() ? "Connect Google Account" : "Sign in with Google"
                  : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoutingTab({
  providers,
  voices,
  stages,
  privileged,
  onProvidersChange,
  onSaved,
  onReload,
  onNotice,
}: {
  providers: ProviderView[];
  voices: VoiceChoice[];
  stages: StagesState | null;
  privileged: boolean;
  onProvidersChange?: (providers: ProviderView[]) => void;
  onSaved: (stages: StagesState) => void;
  onReload?: () => Promise<StagesState | void> | void;
  onNotice: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<UiStage, StageDraft>>(() => initialDrafts(stages, voices));
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingModels, setSyncingModels] = useState(false);

  useEffect(() => {
    setDrafts(initialDrafts(stages, voices));
    setConflict(false);
  }, [stages, voices]);

  async function reloadServerSettings() {
    try {
      const fresh = (await onReload?.()) || (await api.studio.stages());
      onSaved(fresh);
      setDrafts(initialDrafts(fresh, voices));
      setConflict(false);
      onNotice(`Reloaded server routing · revision ${fresh.revision}.`);
    } catch (error) {
      onNotice(errText(error));
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
      onNotice(errText(error));
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
      for (const stage of ["reader", "matcher", "writer", "scout", "fact_check", "tts"] as const) {
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
      onNotice(errText(error));
    } finally {
      setSaving(false);
    }
  }

  function resetToDefaults() {
    setDrafts(initialDrafts(null, voices));
    setConflict(false);
    onNotice("Reset stage routing draft to defaults.");
  }

  return (
    <div className="flex flex-col gap-4">
      {conflict ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#69453e] bg-[#2e1f1e] px-3 py-2 text-sm">
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
                  <h3 id={`stage-${meta.id}`} className="font-serif text-xl">
                    {meta.title}
                  </h3>
                  <span className="cap font-mono">{draft.chain.length}</span>
                </div>
                <span className="cap is-on">{meta.gate === "vision" ? "Vision" : meta.gate === "tts" ? "TTS" : "Text"}</span>
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
                    <label className="mt-3 flex items-center gap-2 text-xs text-[#a2a19f]">
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
                      voices={voices}
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

function initialDrafts(stages: StagesState | null, voices: VoiceChoice[]): Record<UiStage, StageDraft> {
  const ttsRoute =
    (stages as (StagesState & { tts?: StageRoute }) | null)?.tts ??
    (stages?.stages as Record<string, StageRoute> | undefined)?.tts;
  const base = {
    reader: stages ? draftFrom(stages.reader) : emptyDraft("reader"),
    matcher: stages ? draftFrom(stages.matcher) : emptyDraft("matcher"),
    writer: stages ? draftFrom(stages.writer) : emptyDraft("writer"),
    scout: stages ? draftFrom(stages.scout) : emptyDraft("scout"),
    fact_check: stages ? draftFrom(stages.fact_check) : emptyDraft("fact_check"),
    tts: ttsRoute && ttsRoute.chain?.length ? draftFrom(ttsRoute) : emptyDraft("tts"),
  };
  if (base.tts.chain.length === 0) {
    const ttsIds = [...new Set(voices.map((voice) => voice.providerId))];
    base.tts.chain = ttsIds;
  }
  return base;
}

function StagePicker({
  stage,
  providers,
  voices,
  disabled,
  onPick,
}: {
  stage: UiStage;
  providers: ProviderView[];
  voices: VoiceChoice[];
  disabled?: boolean;
  onPick: (id: string) => void;
}) {
  const models = useMemo<ModelOption[]>(() => {
    if (stage === "tts") {
      const seen = new Set<string>();
      return voices.flatMap((voice) => {
        if (seen.has(voice.providerId)) return [];
        seen.add(voice.providerId);
        return [{
          id: voice.providerId,
          name: voice.providerLabel,
          provider: "TTS",
          description: "audio-tts",
          capabilities: ["files" as const],
        }];
      });
    }
    const needVision = stage === "reader" || stage === "matcher" || stage === "scout";
    return providers.flatMap((provider) =>
      provider.models.map((model) => {
        const vision = Boolean(model.capabilities?.vision);
        const cleanId = stripProviderPrefixUi(model.id, provider.id);
        const cleanLabel = stripProviderPrefixUi(model.label || model.id, provider.id);
        return {
          id: `${provider.id}:${cleanId}`,
          name: cleanId,
          provider: provider.label,
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
  }, [providers, stage, voices]);

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

function NodesTab({
  system,
  nodes,
  workers,
  privileged,
  settings,
  onSettingsSaved,
  onChange,
  onNotice,
}: {
  system: PipelineStatus["system"] | null;
  nodes: RenderNode[];
  workers: PipelineWorker[];
  privileged: boolean;
  settings: StudioSettingsState | null;
  onSettingsSaved: (settings: StudioSettingsState) => void;
  onChange: (nodes: RenderNode[]) => void;
  onNotice: (message: string) => void;
}) {
  const [editing, setEditing] = useState<RenderNode | null>(null);
  const [open, setOpen] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>(["sbx console ready"]);
  const [renderQuality, setRenderQuality] = useState<RenderQuality>(
    settings?.renderQuality || settings?.settings?.renderQuality || "1080p",
  );
  const [savingQuality, setSavingQuality] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [storage, setStorage] = useState<StudioStorageReport | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [nodeOutputs, setNodeOutputs] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busyNodeKey, setBusyNodeKey] = useState<string>("");
  const [sbxDeviceLink, setSbxDeviceLink] = useState<{
    nodeId?: string;
    verificationUrl: string | null;
    userCode: string | null;
    instructions: string;
    detail: string;
  } | null>(null);
  const active = nodes.find((node) => node.id === drawerId) || null;

  useEffect(() => {
    const q = settings?.renderQuality || settings?.settings?.renderQuality;
    if (q === "720p" || q === "1080p") setRenderQuality(q);
  }, [settings]);

  useEffect(() => {
    if (!sbxDeviceLink?.verificationUrl) return;
    const targetNodeId = sbxDeviceLink.nodeId;
    const timer = window.setInterval(() => {
      void api.studio.sbxAuthStatus().then((res) => {
        if (res.authenticated) {
          if (targetNodeId) {
            setNodeOutputs((current) => ({ ...current, [targetNodeId]: { ok: true, text: res.detail } }));
          }
          setSbxDeviceLink(null);
          log(`ok  ${res.detail}`);
          onNotice("Docker account linked · sbx CLI ready");
        }
      }).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [sbxDeviceLink?.verificationUrl, sbxDeviceLink?.nodeId, onNotice]);

  const handleStorageStateLoaded = useCallback((rep: StudioStorageReport | null, list: TrashItem[]) => {
    if (rep) setStorage(rep);
    setTrash(list);
  }, []);

  async function saveQuality(nextQuality: RenderQuality) {
    if (!privileged || savingQuality) return;
    setRenderQuality(nextQuality);
    setSavingQuality(true);
    try {
      const saved = await api.studio.putSettings({ renderQuality: nextQuality });
      onSettingsSaved(saved);
      onNotice(
        nextQuality === "720p"
          ? "Render quality set to 720p (1280×720)"
          : "Render quality set to 1080p (1920×1080)",
      );
    } catch (error) {
      onNotice(errText(error));
    } finally {
      setSavingQuality(false);
    }
  }

  function log(line: string) {
    setLines((current) => [...current.slice(-80), line]);
  }

  async function run(
    id: string,
    action: "test" | "status" | "start" | "pause" | "stop" | "provision" | "auth-status" | "auth-start",
  ) {
    log(`$ ${action} ${id}`);
    setBusyNodeKey(`${id}:${action}`);
    try {
      if (action === "test") {
        const probe = await api.studio.testNode(id);
        const text = probe.ok ? `Connected · ${probe.reason}` : probe.reason;
        log(probe.ok ? `ok  ${probe.reason}` : `fail  ${probe.reason}`);
        setNodeOutputs((current) => ({ ...current, [id]: { ok: probe.ok, text } }));
        onNotice(probe.ok ? "Probe ok" : probe.reason);
        return;
      }
      if (action === "auth-status" || action === "auth-start") {
        if (action === "auth-status") {
          const statusRes = await api.studio.nodeAction(id, "auth-status");
          if (statusRes.ok) {
            setSbxDeviceLink(null);
            log(`ok  ${statusRes.detail}`);
            setNodeOutputs((current) => ({ ...current, [id]: { ok: true, text: statusRes.detail } }));
            onNotice(statusRes.detail);
            return;
          }
          log(`info  ${statusRes.detail}`);
          if (statusRes.status === "missing-cli") {
            setNodeOutputs((current) => ({ ...current, [id]: { ok: false, text: statusRes.detail } }));
            onNotice(statusRes.detail);
            return;
          }
        }
        const started = await api.studio.sbxAuthStart();
        if (started.authenticated) {
          setSbxDeviceLink(null);
          log(`ok  ${started.detail}`);
          setNodeOutputs((current) => ({ ...current, [id]: { ok: true, text: started.detail } }));
          onNotice(started.detail);
          return;
        }
        const url = typeof started.verificationUrl === "string" ? started.verificationUrl : null;
        const code = typeof started.userCode === "string" ? started.userCode : null;
        const instructions = typeof started.instructions === "string" ? started.instructions : "";
        if (url || code) {
          setSbxDeviceLink({
            nodeId: id,
            verificationUrl: url,
            userCode: code,
            instructions,
            detail: started.detail,
          });
          log(`info  One-time code: ${code ?? "—"} · Sign in: ${url ?? "—"}`);
        }
        const combined = [
          started.detail,
          code ? `Code: ${code}` : "",
          url ? `Login URL: ${url}` : "",
          instructions,
        ].filter(Boolean).join(" · ");
        if (!url && !code) {
          log(`info  ${combined}`);
        }
        setNodeOutputs((current) => ({ ...current, [id]: { ok: false, text: combined } }));
        onNotice(combined);
        return;
      }
      const result = await api.studio.nodeAction(id, action);
      log(result.ok ? `ok  ${result.detail}` : `fail  ${result.detail}`);
      setNodeOutputs((current) => ({ ...current, [id]: { ok: result.ok, text: result.detail } }));
      onNotice(result.detail);
    } catch (error) {
      const msg = errText(error);
      log(`fail  ${msg}`);
      setNodeOutputs((current) => ({ ...current, [id]: { ok: false, text: msg } }));
      onNotice(msg);
    } finally {
      setBusyNodeKey("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="desk-card flex flex-wrap items-center justify-between gap-3 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Output quality">
            <span className="text-xs text-[#a2a19f]">Output quality</span>
            <button
              type="button"
              role="radio"
              aria-checked={renderQuality === "1080p"}
              className={cn("chip", renderQuality === "1080p" && "is-on")}
              disabled={!privileged || savingQuality}
              onClick={() => void saveQuality("1080p")}
            >
              1080p
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={renderQuality === "720p"}
              className={cn("chip", renderQuality === "720p" && "is-on")}
              disabled={!privileged || savingQuality}
              onClick={() => void saveQuality("720p")}
            >
              720p
            </button>
          </div>
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
          const local = node.kind === "local";
          const load = local ? system?.cpuPercent != null ? system.cpuPercent / 100 : null : typeof worker?.metrics?.load === "number" ? Math.min(1, worker.metrics.load / (worker.metrics.cpus || 4)) : null;
          const memPressure = local ? system?.memory?.available != null && system.memory.total ? 1 - system.memory.available / system.memory.total : null : worker?.metrics?.mem_gb != null ? Math.max(0, 1 - Math.min(1, worker.metrics.mem_gb / 16)) : null;
          const diskPressure = local ? system?.disk?.available != null && system.disk.total ? 1 - system.disk.available / system.disk.total : null : worker?.metrics?.disk_gb != null ? Math.max(0, 1 - Math.min(1, worker.metrics.disk_gb / 100)) : null;
          const cpuText = local ? system?.cpuPercent != null ? `${Math.round(system.cpuPercent)}%` : "—" : worker?.metrics?.load != null ? String(worker.metrics.load) : "—";
          const ramText = local ? system?.memory?.available != null ? `${fmtStorageBytes(system.memory.available)} free` : "—" : worker?.metrics?.mem_gb != null ? `${worker.metrics.mem_gb} GB` : "—";
          const diskText = local ? system?.disk?.available != null ? `${fmtStorageBytes(system.disk.available)} free` : "—" : worker?.metrics?.disk_gb != null ? `${worker.metrics.disk_gb} GB` : node.kind === "docker-sbx" ? `${node.maxHours ?? 5}h TTL` : "—";
          return (
            <article key={node.id} className="desk-card studio-node">
              <div className="flex items-start gap-3">
                <span className="mono-mark" aria-hidden>
                  {node.kind === "local" ? <Monitor className="size-4" /> : node.kind === "ssh" ? <Radio className="size-4" /> : <Cloud className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="font-serif text-xl">{node.label} <code className="font-mono text-xs text-[#a2a19f]">{node.id}</code></h3>
                  <p className="text-xs text-[#a2a19f]">
                    {formatRenderNodeSubtitle(node)}
                  </p>
                </div>
                <span className="cap">{worker?.status || (node.enabled ? "Configured" : "Off")}</span>
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] px-3 py-2 text-xs" aria-label={`${node.label} telemetry`}>
                <div>
                  <dt className="text-[10px] tracking-wide text-[#a2a19f] uppercase">Slots</dt>
                  <dd className="mt-0.5 font-mono text-[#f2efe9]">{node.slots}</dd>
                </div>
                <div>
                  <dt className="text-[10px] tracking-wide text-[#a2a19f] uppercase">{node.kind === "docker-sbx" ? "TTL" : "Kind"}</dt>
                  <dd className="mt-0.5 font-mono text-[#f2efe9]">{node.kind === "docker-sbx" ? `${node.maxHours ?? 5}h` : node.kind}</dd>
                </div>
                <div>
                  <dt className="text-[10px] tracking-wide text-[#a2a19f] uppercase">Status</dt>
                  <dd className="mt-0.5 font-mono text-[#f2efe9]">{worker?.status || (node.enabled ? "idle" : "off")}</dd>
                </div>
              </dl>
              <div className="mt-3 flex flex-col gap-2">
                <MeterRow label="CPU load" level={load} text={cpuText} />
                <MeterRow label="RAM Free" level={memPressure} text={ramText} />
                <MeterRow
                  label="Disk Free"
                  level={diskPressure}
                  text={diskText}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 md:min-h-8"
                  disabled={!privileged || Boolean(busyNodeKey)}
                  onClick={() => {
                    setDrawerId(node.id);
                    void run(node.id, "test");
                  }}
                >
                  {busyNodeKey === `${node.id}:test` ? "Testing…" : "Test"}
                </Button>
                {node.id !== "local" && node.kind === "docker-sbx" ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 md:min-h-8"
                      disabled={!privileged || Boolean(busyNodeKey)}
                      onClick={() => {
                        setDrawerId(node.id);
                        void run(node.id, "auth-start");
                      }}
                    >
                      {busyNodeKey === `${node.id}:auth-start` || busyNodeKey === `${node.id}:auth-status` ? "Linking…" : "Link Docker"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-11 md:min-h-8"
                      disabled={!privileged || Boolean(busyNodeKey)}
                      onClick={() => {
                        setDrawerId(node.id);
                        void run(node.id, "provision");
                      }}
                    >
                      {busyNodeKey === `${node.id}:provision` ? "Provisioning…" : "Provision"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 md:min-h-8"
                      disabled={!privileged || Boolean(busyNodeKey)}
                      onClick={() => {
                        setDrawerId(node.id);
                        void run(node.id, "start");
                      }}
                    >
                      Start
                    </Button>
                  </>
                ) : null}
                {node.id !== "local" && node.kind === "ssh" ? (
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-11 md:min-h-8"
                    disabled={!privileged || Boolean(busyNodeKey)}
                    onClick={() => {
                      setDrawerId(node.id);
                      void run(node.id, "provision");
                    }}
                  >
                    {busyNodeKey === `${node.id}:provision` ? "Provisioning…" : "Provision"}
                  </Button>
                ) : null}
                {node.kind === "docker-sbx" && node.id !== "local" ? <Button type="button" size="sm" variant="outline" className="min-h-11 md:min-h-8" disabled={!privileged || Boolean(busyNodeKey)} onClick={() => void run(node.id, "stop")}>Stop</Button> : null}
                <Button type="button" size="sm" variant="ghost" className="min-h-11 md:min-h-8" disabled={!privileged} onClick={() => { setEditing(node); setOpen(true); }}>
                  Edit
                </Button>
                {node.id !== "local" ? <InlineConfirm
                  label="Remove"
                  subject={node.label}
                  description="Remove render node?"
                  disabled={!privileged}
                  onConfirm={async () => {
                    try {
                      const result = await api.studio.deleteNode(node.id);
                      onChange(result.nodes);
                      onNotice(`${node.label} removed`);
                    } catch (error) {
                      onNotice(errText(error));
                    }
                  }}
                /> : null}
              </div>
              {node.kind === "docker-sbx" && sbxDeviceLink && (!sbxDeviceLink.nodeId || sbxDeviceLink.nodeId === node.id) && (sbxDeviceLink.userCode || sbxDeviceLink.verificationUrl) ? (
                <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-3 text-xs">
                  {sbxDeviceLink.userCode ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[#a2a19f]">One-Time Code:</span>
                      <code className="rounded border border-[#2b2c30] bg-[#17181a] px-2 py-0.5 font-mono text-sm font-semibold text-[#f2efe9]">
                        {sbxDeviceLink.userCode}
                      </code>
                      <CopyButton value={sbxDeviceLink.userCode} label="Copy code" />
                    </div>
                  ) : null}
                  {sbxDeviceLink.verificationUrl ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <a
                        href={sbxDeviceLink.verificationUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex w-fit items-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-2.5 py-1 font-mono text-xs text-[#5eead4] hover:border-[#f18b6e]"
                      >
                        Open Docker Sign-In
                      </a>
                      <CopyButton value={sbxDeviceLink.verificationUrl} label="Copy URL" />
                    </div>
                  ) : null}
                  <p className="font-mono text-[11px] text-[#d6b57b]">
                    Waiting for Docker browser sign-in… (auto-checking every 3s)
                  </p>
                </div>
              ) : null}
              {nodeOutputs[node.id] ? (
                <div
                  className={cn(
                    "mt-3 rounded-lg border px-3 py-2 font-mono text-xs",
                    nodeOutputs[node.id]!.ok
                      ? "border-[#3d523b] bg-[#1e281f] text-[#aed1a8]"
                      : "border-[#69453e] bg-[#2e1f1e] text-[#f0a096]",
                  )}
                  role="status"
                >
                  {nodeOutputs[node.id]!.text}
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
      <Drawer open={Boolean(active)} onOpenChange={(next) => { if (!next) setDrawerId(null); }} swipeDirection="right">
        <DrawerContent className="studio-drawer">
          <DrawerHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <DrawerTitle className="font-serif text-2xl">{active?.label || "Node"}</DrawerTitle>
                <DrawerDescription className="sr-only">Node console</DrawerDescription>
              </div>
              <DrawerClose className="chip" aria-label="Close drawer">
                Close
              </DrawerClose>
            </div>
          </DrawerHeader>
          <div className="flex flex-col gap-3 overflow-auto p-4">
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={!privileged || !active} onClick={() => active && void run(active.id, "test")}>Test</Button>
              <Button type="button" size="sm" variant="outline" disabled={!privileged || !active} onClick={() => active && void run(active.id, "status")}>Status</Button>
              {active?.kind === "docker-sbx" ? (
                <>
                  <Button type="button" size="sm" variant="outline" disabled={!privileged} onClick={() => void run(active.id, "auth-status")}>Auth</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!privileged} onClick={() => void run(active.id, "auth-start")}>Link Docker</Button>
                  <Button type="button" size="sm" disabled={!privileged} onClick={() => void run(active.id, "provision")}>Provision</Button>
                  <Button type="button" size="sm" variant="outline" disabled={!privileged} onClick={() => void run(active.id, "start")}>Start</Button>
                  <InlineConfirm label="Stop" subject={active.label} description="Stop sandbox?" disabled={!privileged || Boolean(busyNodeKey)} onConfirm={() => run(active.id, "stop")} />
                </>
              ) : null}
              {active?.kind === "ssh" ? (
                <Button type="button" size="sm" disabled={!privileged} onClick={() => void run(active.id, "provision")}>Provision</Button>
              ) : null}
            </div>
            {active?.kind === "docker-sbx" && sbxDeviceLink && (sbxDeviceLink.userCode || sbxDeviceLink.verificationUrl) ? (
              <div className="flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-3 text-xs">
                <p className="font-mono text-[#d6b57b]">{sbxDeviceLink.detail}</p>
                {sbxDeviceLink.userCode ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[#a2a19f]">One-Time Code:</span>
                    <code className="rounded border border-[#2b2c30] bg-[#17181a] px-2 py-0.5 font-mono text-sm font-semibold text-[#f2efe9]">
                      {sbxDeviceLink.userCode}
                    </code>
                    <CopyButton value={sbxDeviceLink.userCode} label="Copy code" />
                  </div>
                ) : null}
                {sbxDeviceLink.verificationUrl ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      href={sbxDeviceLink.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex w-fit items-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-2.5 py-1 font-mono text-xs text-[#5eead4] hover:border-[#f18b6e]"
                    >
                      Open Docker Sign-In
                    </a>
                    <CopyButton value={sbxDeviceLink.verificationUrl} label="Copy URL" />
                  </div>
                ) : null}
                <p className="font-mono text-[11px] text-[#a2a19f]">
                  Waiting for Docker browser sign-in… (auto-checking every 3s)
                </p>
              </div>
            ) : null}
            <Terminal>
              <TerminalHeader>sbx / ssh</TerminalHeader>
              <TerminalBody>
                {lines.map((line, index) => (
                  <TerminalLine key={`${index}-${line.slice(0, 12)}`}>{line}</TerminalLine>
                ))}
              </TerminalBody>
            </Terminal>
          </div>
        </DrawerContent>
      </Drawer>

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

function PromptsTab({
  promptsState,
  privileged,
  onSaved,
  onNotice,
}: {
  promptsState: StudioPromptsState | null;
  privileged: boolean;
  onSaved: (state: StudioPromptsState) => void;
  onNotice: (message: string) => void;
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
      onNotice(errText(error));
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
      onNotice(errText(error));
    } finally {
      setSaving(false);
    }
  }

  const activeLineCount = currentPrompt ? currentPrompt.split("\n").length : 1;
  const activeCustomized = isStageCustomized(selectedStage);

  return (
    <div className="studio-prompts flex w-full min-w-0 flex-col gap-4">
      <nav
        className="grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-5"
        role="group"
        aria-label="Prompt stage selector"
      >
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
              className={cn(
                "flex flex-col items-start justify-between gap-2 rounded-xl border p-3 text-left transition-colors",
                isSelected
                  ? "border-[#f18b6e] bg-[#f18b6e]/14 text-[#f2efe9]"
                  : "border-[#2b2c30] bg-[#17181a] text-[#f2efe9] hover:border-[#3c3e44]",
              )}
              onClick={() => setSelectedStage(stage.id)}
            >
              <div className="flex w-full items-center justify-between gap-2">
                <span className="font-serif text-base font-medium leading-tight">{stage.title}</span>
                <span className={cn("cap", customized && "is-on")}>
                  {customized ? "Custom" : "Default"}
                </span>
              </div>
              <div className="flex w-full items-center justify-between gap-2 font-mono text-[11px] text-[#a2a19f]">
                <span>{stage.id}</span>
                <span>{lineCount}L</span>
              </div>
            </button>
          );
        })}
      </nav>

      <section className="desk-card flex w-full min-w-0 flex-col gap-4" aria-labelledby={`prompt-heading-${selectedStage}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={`prompt-heading-${selectedStage}`} className="font-serif text-2xl">
              {activeMeta.title}
            </h3>
            <span className={cn("cap", activeCustomized && "is-on")}>
              {activeCustomized ? "Custom" : "Default"}
            </span>
            <span className="cap font-mono">
              {activeLineCount}L · {currentPrompt.length}c
            </span>
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
              className="min-h-11 md:min-h-9"
              onClick={() => setCompareDefault((prev) => !prev)}
            >
              Compare
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-9"
              disabled={!privileged || saving}
              onClick={() => void resetStagePrompt()}
            >
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 md:min-h-9"
              disabled={!privileged || saving}
              onClick={() => void saveAllBriefs()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>

        <div className={cn("grid w-full gap-4", compareDefault ? "lg:grid-cols-2" : "grid-cols-1")}>
          <div className="flex w-full min-w-0 flex-col gap-2">
            {compareDefault ? (
              <div className="flex items-center justify-between text-xs text-[#a2a19f]">
                <span className="font-mono uppercase tracking-wider text-[#f2efe9]">Active</span>
                <span className="font-mono">{activeLineCount}L · {currentPrompt.length}c</span>
              </div>
            ) : null}
            <textarea
              aria-label={`${activeMeta.title} prompt template`}
              rows={22}
              style={{ minHeight: "440px", height: "auto" }}
              className="min-h-[420px] w-full resize-y rounded-xl border border-[#2b2c30] bg-[#101113] p-4 font-mono text-sm leading-relaxed text-[#f2efe9] focus:border-[#f18b6e] focus:outline-none"
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
              <div className="flex items-center justify-between text-xs text-[#a2a19f]">
                <span className="font-mono uppercase tracking-wider">Default</span>
                <span className="font-mono">
                  {defaultPromptForStage ? defaultPromptForStage.split("\n").length : 1}L · {defaultPromptForStage.length}c
                </span>
              </div>
              <textarea
                aria-label={`${activeMeta.title} default prompt reference`}
                readOnly
                rows={22}
                style={{ minHeight: "440px", height: "auto" }}
                className="min-h-[420px] w-full resize-y rounded-xl border border-[#2b2c30] bg-[#101113]/70 p-4 font-mono text-sm leading-relaxed text-[#a2a19f] focus:outline-none"
                value={defaultPromptForStage || currentPrompt}
                spellCheck={false}
              />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MeterRow({ label, level, text }: { label: string; level: number | null; text: string }) {
  const clamped = level !== null && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const pct = Math.round(clamped * 100);
  const fillClass = pct >= 85 ? "bg-[#f0a096]" : pct >= 65 ? "bg-[#d6b57b]" : "bg-[#5eead4]";
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)_64px] items-center gap-2">
      <span className="font-mono text-[10px] tracking-wide text-[#a2a19f] uppercase">{label}</span>
      <div
        role={level === null ? undefined : "meter"}
        aria-label={label}
        aria-valuemin={level === null ? undefined : 0}
        aria-valuemax={level === null ? undefined : 100}
        aria-valuenow={level === null ? undefined : pct}
        aria-valuetext={level === null ? undefined : text}
        className="h-2 overflow-hidden rounded-full border border-[#2b2c30] bg-[#101113]"
      >
        <div className={cn("h-full rounded-full transition-[width] duration-200", fillClass)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-right font-mono text-[11px] text-[#f2efe9]">{text}</span>
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
  onNotice: (message: string) => void;
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
      const verificationUrl =
        typeof started.verificationUrl === "string" ? started.verificationUrl : null;
      const userCode =
        typeof started.userCode === "string" ? started.userCode : null;
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
          instructions: "Install the Docker sbx CLI on this server, then run `sbx login`.",
        });
        return;
      }
      const started = await api.studio.sbxAuthStart();
      const verificationUrl =
        typeof started.verificationUrl === "string" ? started.verificationUrl : null;
      const userCode =
        typeof started.userCode === "string" ? started.userCode : null;
      const instructions =
        typeof started.instructions === "string"
          ? started.instructions
          : "Run `sbx login` in a terminal and finish the browser sign-in flow.";
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
      onNotice(prov.detail);
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
          );
          onOpenChange(false);
          return;
        } catch (provErr) {
          onSaved(result.nodes);
          onNotice(`Saved ${built.resolvedId}, but auto-provisioning reported: ${errText(provErr)}`);
          onOpenChange(false);
          return;
        }
      }
      onSaved(result.nodes);
      onOpenChange(false);
    } catch (error) {
      setFormError(errText(error));
      onNotice(errText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="studio-dialog sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-2xl">{editing ? "Edit render node" : "Add render node"}</DialogTitle>
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
              <span className="text-[#a2a19f]" aria-hidden>-&gt;</span>
              <span className="cap">2. Auto-Setup</span>
              <span className="text-[#a2a19f]" aria-hidden>-&gt;</span>
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
              SSH Private Key <span className="text-xs text-[#a2a19f]">(write-only)</span>
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
              <p className="font-mono text-xs text-[#aed1a8]">Key stored · {editing.auth.secretHint || "saved"}</p>
            ) : null}
            <label className="flex items-center gap-2 rounded-lg border border-[#2b2c30] bg-[#101113] px-3 py-2.5 text-sm text-[#f2efe9]">
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
                    ? "border-[#3d523b] bg-[#1e281f] text-[#aed1a8]"
                    : "border-[#69453e] bg-[#2e1f1e] text-[#f0a096]",
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
            <div className="flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
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
                  <p className={cn("font-mono", sbxAuthInfo.ok ? "text-[#aed1a8]" : "text-[#d6b57b]")}>
                    {sbxAuthInfo.detail}
                  </p>
                  {!sbxAuthInfo.ok && (sbxAuthInfo.userCode || sbxAuthInfo.verificationUrl) ? (
                    <div className="flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#17181a] p-3">
                      {sbxAuthInfo.userCode ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[#a2a19f]">One-time code:</span>
                          <code className="rounded border border-[#2b2c30] bg-[#101113] px-2.5 py-1 font-mono text-sm font-semibold text-[#f2efe9]">
                            {sbxAuthInfo.userCode}
                          </code>
                          <CopyButton value={sbxAuthInfo.userCode} label="Copy code" />
                        </div>
                      ) : null}
                      {sbxAuthInfo.verificationUrl ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <a
                            href={sbxAuthInfo.verificationUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex w-fit items-center rounded-lg border border-[#2b2c30] bg-[#101113] px-2.5 py-1 font-mono text-xs text-[#5eead4] hover:border-[#f18b6e]"
                          >
                            Open Docker Sign-In
                          </a>
                          <CopyButton value={sbxAuthInfo.verificationUrl} label="Copy URL" />
                        </div>
                      ) : null}
                      <p className="font-mono text-[11px] text-[#a2a19f]">
                        Waiting for Docker browser sign-in… (auto-checking every 3s)
                      </p>
                    </div>
                  ) : null}
                  {sbxAuthInfo.instructions ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[#a2a19f]">{sbxAuthInfo.instructions}</span>
                      <CopyButton value="sbx login" label="Copy sbx login" />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 rounded-xl border border-[#2b2c30] bg-[#101113] p-3">
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
              <p className="text-xs text-[#a2a19f]">
                Provision auto-checks if the prebaked Remotion environment (<code>.kit-ready</code>, headless browser, <code>ffmpeg</code>) is in the sandbox, and creates/bakes it if missing.
              </p>
              {detectedSandboxes.length ? <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[#a2a19f]">Existing sandboxes:</span>
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
              <label className="mt-1 flex items-center gap-2 text-sm text-[#f2efe9]">
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
                      ? "border-[#3d523b] bg-[#1e281f] text-[#aed1a8]"
                      : "border-[#69453e] bg-[#2e1f1e] text-[#f0a096]",
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

        <details className="text-xs text-[#a2a19f]">
          <summary className="cursor-pointer select-none">Advanced node settings</summary>
          <div className="mt-2 flex flex-col gap-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-3 text-sm text-[#f2efe9]">
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
                <span className="text-[11px] text-[#a2a19f]">Priority</span>
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

        {formError ? <p className="text-sm text-[#f0a096]" role="alert">{formError}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={!privileged || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save node"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoiceTab({ voices, privileged }: { voices: VoiceChoice[]; privileged: boolean }) {
  const [selectedVoice, setSelectedVoice] = useState<string>(() => voices[0]?.id ?? "");
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
    if (!voices.some((v) => v.id === selectedVoice)) {
      setSelectedVoice(voices[0]?.id ?? "");
    }
  }, [voices, selectedVoice]);

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
  }, [selectedVoice]);

  useEffect(() => {
    return () => {
      gen.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  const choice = voices.find((v) => v.id === selectedVoice) || voices[0] || null;
  const isPaid = Boolean(
    choice &&
      choice.engine.toLowerCase() !== "edge" &&
      choice.engine.toLowerCase() !== "edge-tts" &&
      choice.providerId.toLowerCase() !== "edge" &&
      choice.providerId.toLowerCase() !== "edge-tts",
  );

  async function listen() {
    if (!choice || busy || !privileged) return;
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
      const preview = await api.intake.preview(choice.providerId, choice.voiceId, controller.signal);
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
      <div className="flex flex-wrap items-center gap-2">
        <span className="cap is-on">
          <AudioLines size={14} aria-hidden /> Edge TTS · Free
        </span>
        <span className="cap is-on">
          <AudioLines size={14} aria-hidden /> Vertex AI · Chirp 3 HD &amp; Gemini
        </span>
        <span className="cap is-on">
          <AudioLines size={14} aria-hidden /> xAI Grok · Subscription
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[220px] flex-1 text-sm" htmlFor="studioNarratorVoice">
            Voice
            <select
              id="studioNarratorVoice"
              className="field mt-1"
              value={selectedVoice}
              disabled={voices.length === 0}
              onChange={(event) => setSelectedVoice(event.target.value)}
            >
              {voices.length === 0 && <option value="">No voices available</option>}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.voiceLabel} · {v.providerLabel}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant={playing ? "outline" : "default"}
            className="min-h-11"
            disabled={!privileged || !choice || busy || (isPaid && !spendOk)}
            onClick={() => (playing ? stop() : void listen())}
          >
            <AudioLines size={16} aria-hidden /> {busy ? "Generating…" : playing ? "Stop" : "Play sample"}
          </Button>
          {isPaid ? (
            <label className="flex min-h-11 items-center gap-2 text-xs text-[#a2a19f]">
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
            className="min-h-11"
            disabled={!choice}
            onClick={() => {
              if (!choice) return;
              try {
                localStorage.setItem(
                  "screeningroom.preferredVoice",
                  JSON.stringify({
                    providerId: choice.providerId,
                    voiceId: choice.voiceId,
                    engine: choice.engine,
                    voiceLabel: choice.voiceLabel,
                  }),
                );
                localStorage.setItem("screeningroom.voice.provider", choice.providerId);
                localStorage.setItem("screeningroom.voice.id", choice.voiceId);
              } catch {
                /* Storage blocked in private browsing */
              }
              navigateClient("/new-series.html");
            }}
          >
            Use voice
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Waves className={cn("size-4 shrink-0", playing ? "text-[#5eead4]" : "text-[#a2a19f]")} aria-hidden />
          <div className="h-2 flex-1 overflow-hidden rounded-full border border-[#2b2c30] bg-[#17181a]">
            <div
              className="h-full rounded-full bg-[#5eead4] transition-[width] duration-150"
              style={{ width: `${duration > 0 ? Math.min(100, Math.round((currentTime / duration) * 100)) : 0}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-xs text-[#a2a19f] tabular-nums">
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
        {error ? <p className="text-xs text-[#f0a096]" role="alert">{error}</p> : null}
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
      <span className="text-[11px] text-[#a2a19f]">{label}</span>
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
      <Button type="button" variant="ghost" size="sm" className="min-h-11 text-[#f0a096] md:min-h-8" disabled={disabled} onClick={() => setArmed(true)}>
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

export default StudioPage;
