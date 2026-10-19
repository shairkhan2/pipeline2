import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check, Eye, EyeOff, LoaderCircle } from "lucide-react";

import {
  api,
  isApiError,
  type ProviderPreset,
  type ProviderView,
  type RenderNode,
  type RenderNodeKind,
  type SetupState,
  type StageRoute,
  type VertexDetectedProject,
} from "@/lib/api";
import {
  BOX_RE,
  clampSlotsForKind,
  DEFAULT_SANDBOX_IDLE_PAUSE_S,
  DEFAULT_SANDBOX_MAX_HOURS,
  DEFAULT_SANDBOX_TEMPLATE,
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_REMOTE_DIR,
  DEFAULT_SSH_USER,
  getRenderKindMeta,
  HOST_RE,
  maxSlotsForKind,
  NODE_ID_RE,
} from "@/lib/renderLanes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
  type DropzoneRejection,
} from "@/components/ui/dropzone";
import {
  PasswordInput,
  PasswordInputField,
  PasswordInputStrength,
  type PasswordScorer,
} from "@/components/ui/password";
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
  StepperTrigger,
} from "@/components/ui/stepper";

const STEPS = [
  { n: 1, title: "Admin account" },
  { n: 2, title: "AI provider" },
  { n: 3, title: "Render lanes" },
  { n: 4, title: "Launch studio" },
] as const;

const COMMON = new Set([
  "password",
  "admin",
  "12345678",
  "qwertyui",
  "letmein",
  "welcome",
  "changeme",
  "manhwa",
  "password1",
]);

const scorePassword: PasswordScorer = (value) => {
  const long = value.length >= 10;
  const upper = /[A-Z]/.test(value);
  const lower = /[a-z]/.test(value);
  const symbol = /\d/.test(value) || /[^A-Za-z0-9]/.test(value);
  const score = Number(long) + Number(upper) + Number(lower) + Number(symbol);
  const labels = ["Weak", "Weak", "Fair", "Good", "Strong"];
  return { score, label: labels[score] ?? "Weak", hint: value ? undefined : undefined };
};

const RULES: Array<{ id: string; label: string; test: (value: string) => boolean }> = [
  { id: "len", label: "10+ characters", test: (value) => value.length >= 10 },
  { id: "upper", label: "Uppercase letter", test: (value) => /[A-Z]/.test(value) },
  { id: "lower", label: "Lowercase letter", test: (value) => /[a-z]/.test(value) },
  { id: "sym", label: "Number or symbol", test: (value) => /\d/.test(value) || /[^A-Za-z0-9]/.test(value) },
];

interface QuickPreset {
  id: string;
  label: string;
  hint: string;
  mode: "key" | "local" | "oauth" | "device" | "vertex" | "custom";
  preset: string;
  baseUrl?: string;
}

interface ServiceAccountPreview {
  projectId: string;
  clientEmail: string;
  json: string;
}

const SUBSCRIPTION_PROVIDER_IDS = new Set([
  "codex-oauth",
  "claude-oauth",
  "github-copilot",
  "grok-subscription",
  "subscription-bridge",
]);
const DEVICE_CODE_PROVIDER_IDS = new Set(["codex-oauth", "grok-subscription", "github-copilot"]);
const DEFAULT_GOOGLE_OAUTH_CLIENT_ID =
  "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com";
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

function deviceProviderTitleFor(providerOrPresetId: string): string {
  if (providerOrPresetId === "codex-oauth") return "ChatGPT";
  if (providerOrPresetId === "grok-subscription") return "SuperGrok";
  return "GitHub Copilot";
}

function isTtsOnlyModel(model: { capabilities?: { tts?: boolean; writer?: boolean } | null }): boolean {
  return Boolean(model.capabilities?.tts && !model.capabilities?.writer);
}

function defaultDeviceModelFor(providerOrPresetId: string, presets?: Record<string, ProviderPreset>): string {
  const defaultModels = presets?.[providerOrPresetId]?.defaultModels || [];
  const nonTts = defaultModels.filter((m) => !isTtsOnlyModel(m));
  const presetModel = (nonTts[0] || defaultModels[0])?.id;
  if (presetModel) return stripProviderPrefixUi(presetModel, providerOrPresetId);
  if (providerOrPresetId === "vertex-ai" || providerOrPresetId === "vertex") return "gemini-3.8-flash";
  if (providerOrPresetId === "gemini") return "gemini-2.5-flash";
  if (providerOrPresetId === "codex-oauth") return "gpt-6.1-sol";
  if (providerOrPresetId === "claude-oauth" || providerOrPresetId === "anthropic") return "claude-sonnet-4-20250514";
  if (providerOrPresetId === "grok-subscription" || providerOrPresetId === "xai") return "grok-4";
  if (providerOrPresetId === "deepseek") return "deepseek-chat";
  if (providerOrPresetId === "openrouter") return "google/gemini-2.5-flash";
  return "gpt-4o";
}

function selectVisionAndWriterRefs(
  rawModels: Array<{ id: string; capabilities?: { vision?: boolean; writer?: boolean; tts?: boolean } | null }> | undefined,
  providerId: string,
  presets?: Record<string, ProviderPreset>,
  allowFallback = true,
): { visionRef: string; writerRef: string } {
  const valid = (rawModels || []).filter((m) => m && typeof m.id === "string" && m.id.trim());
  const nonTts = valid.filter((m) => !isTtsOnlyModel(m));
  const pool = nonTts.length > 0 ? nonTts : valid;
  const visionObj =
    pool.find((m) => m.capabilities?.vision === true) ??
    pool.find((m) => m.capabilities?.vision !== false) ??
    pool[0];
  const writerObj =
    pool.find((m) => m.capabilities?.writer !== false) ??
    pool[0];
  const fallbackModelId = allowFallback ? defaultDeviceModelFor(providerId, presets) : "";
  const cleanVisionId = visionObj ? stripProviderPrefixUi(visionObj.id, providerId) : fallbackModelId;
  const cleanWriterId = writerObj ? stripProviderPrefixUi(writerObj.id, providerId) : fallbackModelId;
  return {
    visionRef: cleanVisionId ? `${providerId}:${cleanVisionId}` : "",
    writerRef: cleanWriterId ? `${providerId}:${cleanWriterId}` : "",
  };
}

const FALLBACK_SUBSCRIPTION_PRESETS: Record<string, Partial<ProviderPreset>> = {
  "codex-oauth": {
    id: "codex-oauth",
    label: "OpenAI Codex (ChatGPT Subscription)",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authMode: "device-code",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  },
  "claude-oauth": {
    id: "claude-oauth",
    label: "Claude Pro / Max (Subscription OAuth)",
    category: "subscription",
    kind: "subscription",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "oauth-pkce",
  },
  "github-copilot": {
    id: "github-copilot",
    label: "GitHub Copilot (Device Code)",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.githubcopilot.com",
    authMode: "device-code",
    clientId: "Ov23li8tweQw6odWQebz",
  },
  "grok-subscription": {
    id: "grok-subscription",
    label: "xAI SuperGrok / Grok Subscription",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authMode: "device-code",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  },
  "subscription-bridge": {
    id: "subscription-bridge",
    label: "Local CLI Subscription Proxy",
    category: "subscription",
    kind: "subscription",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:8317/v1",
    authMode: "bearer",
    allowPrivateNetwork: true,
  },
};

const QUICK: QuickPreset[] = [
  { id: "openrouter", label: "OpenRouter", hint: "Cloud API", mode: "key", preset: "openrouter" },
  { id: "openai", label: "OpenAI API", hint: "Platform key", mode: "key", preset: "openai" },
  { id: "codex-oauth", label: "ChatGPT Plus/Pro", hint: "Subscription Device Code", mode: "device", preset: "codex-oauth" },
  { id: "claude-oauth", label: "Claude Pro/Max", hint: "Subscription OAuth", mode: "oauth", preset: "claude-oauth" },
  { id: "github-copilot", label: "GitHub Copilot", hint: "Subscription Device Code", mode: "device", preset: "github-copilot" },
  { id: "grok-subscription", label: "xAI SuperGrok", hint: "Subscription Device Code", mode: "device", preset: "grok-subscription", baseUrl: "https://api.x.ai/v1" },
  { id: "anthropic", label: "Anthropic Claude", hint: "Messages API", mode: "key", preset: "anthropic" },
  { id: "gemini", label: "Google Gemini", hint: "AI Studio key", mode: "key", preset: "gemini" },
  { id: "vertex", label: "Vertex AI", hint: "Service account JSON", mode: "vertex", preset: "vertex-ai" },
  { id: "xai", label: "xAI Grok", hint: "Cloud API", mode: "key", preset: "xai" },
  { id: "deepseek", label: "DeepSeek", hint: "Cloud API", mode: "key", preset: "deepseek" },
  { id: "ollama", label: "Ollama Local", hint: "127.0.0.1:11434", mode: "local", preset: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "custom", label: "Custom OpenAI URL", hint: "https://…/v1", mode: "custom", preset: "custom-openai" },
];

type TestState = "untested" | "testing" | "ok" | "fail";

function presetModeOf(preset: ProviderPreset): QuickPreset["mode"] {
  if (preset.authMode === "vertex-service-account" || preset.authMode === "vertex-oauth" || preset.category === "cloud-iam") {
    return "vertex";
  }
  if (preset.authMode === "device-code" || DEVICE_CODE_PROVIDER_IDS.has(preset.id)) {
    return "device";
  }
  if (preset.category === "local" || preset.authMode === "none" || preset.id === "subscription-bridge") {
    return "local";
  }
  if (preset.authMode === "oauth-pkce" || preset.id === "claude-oauth") {
    return "oauth";
  }
  return "key";
}

function buildQuickPresets(backendPresets: Record<string, ProviderPreset>): QuickPreset[] {
  const seen = new Set<string>();
  const base = QUICK.map((item) => {
    seen.add(item.id);
    seen.add(item.preset);
    const dynamic = backendPresets[item.preset] || backendPresets[item.id] || FALLBACK_SUBSCRIPTION_PRESETS[item.preset];
    if (!dynamic) return item;
    return {
      ...item,
      label: item.label || dynamic.label || item.id,
      baseUrl: item.baseUrl || dynamic.baseUrl,
    };
  });
  for (const preset of Object.values(backendPresets)) {
    if (!preset?.id || seen.has(preset.id)) continue;
    seen.add(preset.id);
    base.push({
      id: preset.id,
      label: preset.label || preset.id,
      hint: preset.description || preset.category || "Provider",
      mode: presetModeOf(preset),
      preset: preset.id,
      baseUrl: preset.baseUrl || undefined,
    });
  }
  return base;
}

function formatDropzoneRejection(rejections: DropzoneRejection[]): string {
  const first = rejections[0];
  if (!first) return "File was rejected.";
  if (first.reasons.includes("accept")) return "File must be a .json service account key.";
  if (first.reasons.includes("maxSize")) return "Service account JSON must be under 64 KB.";
  if (first.reasons.includes("maxFiles")) return "Drop a single .json service account file.";
  return "File was rejected.";
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

function openAsyncPopup(): Window | null {
  try {
    return window.open("about:blank", "_blank");
  } catch {
    return null;
  }
}

function SetupConnectedAccountBanner({
  provider,
  projects,
  onSelectProject,
}: {
  provider: ProviderView;
  projects?: VertexDetectedProject[];
  onSelectProject?: (projectId: string) => void;
}) {
  if (!provider.auth.hasSecret) return null;
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
    <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[#5eead4]/40 bg-[#5eead4]/10 px-3.5 py-2.5 text-xs">
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
          <label htmlFor={`setup-gcp-proj-${provider.id}`} className="font-mono text-[11px] text-[#a2a19f]">
            GCP Project
          </label>
          <select
            id={`setup-gcp-proj-${provider.id}`}
            className="field min-h-9 w-full flex-1 font-mono text-xs sm:w-auto"
            value={provider.auth.projectId || detectedProjects[0]?.projectId || ""}
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

export function SetupPage() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(1);
  const [reached, setReached] = useState(1);
  const [gate, setGate] = useState<"loading" | "open" | "closed">("loading");
  const [state, setState] = useState<SetupState | null>(null);
  const mountedStepRef = useRef(false);

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [tokenState, setTokenState] = useState<"idle" | "error" | "verified">("idle");
  const [shake, setShake] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const [verifying, setVerifying] = useState(false);

  const [picked, setPicked] = useState<string>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [customUrl, setCustomUrl] = useState("https://");
  const [loginUrl, setLoginUrl] = useState("");
  const [pkceVerifier, setPkceVerifier] = useState("");
  const [callbackCode, setCallbackCode] = useState("");
  const [deviceUserCode, setDeviceUserCode] = useState("");
  const [deviceVerifyUri, setDeviceVerifyUri] = useState("");
  const [devicePolling, setDevicePolling] = useState(false);
  const [deviceWaited, setDeviceWaited] = useState(0);
  const pollInFlightRef = useRef(false);
  const pollIntervalMsRef = useRef(5000);
  const [vertexSa, setVertexSa] = useState<ServiceAccountPreview | null>(null);
  const [saError, setSaError] = useState("");
  const [vertexMode, setVertexMode] = useState<"vertex-service-account" | "vertex-oauth">("vertex-oauth");
  const [vertexProjectId, setVertexProjectId] = useState("");
  const [vertexProjects, setVertexProjects] = useState<VertexDetectedProject[]>([]);
  const [vertexLocation, setVertexLocation] = useState("global");
  const [vertexClientId, setVertexClientId] = useState(DEFAULT_GOOGLE_OAUTH_CLIENT_ID);
  const [vertexOauthToken, setVertexOauthToken] = useState("");
  const [testState, setTestState] = useState<TestState>("untested");
  const [elapsed, setElapsed] = useState(0);
  const [testDetail, setTestDetail] = useState("");
  const [routingError, setRoutingError] = useState("");
  const [routingSaved, setRoutingSaved] = useState(false);
  const [backendPresets, setBackendPresets] = useState<Record<string, ProviderPreset>>({});
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [visionModel, setVisionModel] = useState("");
  const [writerModel, setWriterModel] = useState("");
  const [latency, setLatency] = useState<number | null>(null);

  const [nodes, setNodes] = useState<RenderNode[]>([]);
  const [laneNote, setLaneNote] = useState("");
  const [laneError, setLaneError] = useState("");
  const [probing, setProbing] = useState(false);
  const [quickLaneKind, setQuickLaneKind] = useState<Exclude<RenderNodeKind, "local"> | null>(null);
  const [nodeId, setNodeId] = useState("");
  const [nodeLabel, setNodeLabel] = useState("");
  const [nodeBox, setNodeBox] = useState("manhwa-render-arm");
  const [nodeSlots, setNodeSlots] = useState(2);
  const [nodeHost, setNodeHost] = useState("");
  const [nodeUser, setNodeUser] = useState(DEFAULT_SSH_USER);
  const [nodePort, setNodePort] = useState(DEFAULT_SSH_PORT);
  const [nodeRemoteDir, setNodeRemoteDir] = useState(DEFAULT_SSH_REMOTE_DIR);
  const [nodeSshKey, setNodeSshKey] = useState("");
  const [savingNode, setSavingNode] = useState(false);

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState("");

  const quickPresets = useMemo(() => buildQuickPresets(backendPresets), [backendPresets]);
  const preset = quickPresets.find((item) => item.id === picked) ?? quickPresets[0]!;

  useEffect(() => {
    let stop = false;
    api.setup
      .state()
      .then(async (next) => {
        if (stop) return;
        setState(next);
        if (!next.needsSetup) {
          setGate("closed");
          try {
            await api.session();
            window.location.assign("/studio.html");
          } catch {
            window.location.assign("/login");
          }
          return;
        }
        setGate("open");
        try {
          const session = await api.session();
          if (session?.user) {
            setTokenState("verified");
            setReached(2);
            setStep(2);
          }
        } catch {
          /* No session yet. The token step stays open. */
        }
      })
      .catch(() => {
        if (!stop) setGate("open");
      });
    return () => {
      stop = true;
    };
  }, []);

  useEffect(() => {
    if (gate !== "open") return;
    if (!mountedStepRef.current) {
      mountedStepRef.current = true;
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`setup-head-${step}`)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [step, gate]);

  useEffect(() => {
    if (testState !== "testing") return;
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [testState]);

  useEffect(() => {
    if (step < 2) return;
    api.studio
      .providers()
      .then((doc) => {
        setProviders(doc.providers || []);
        if (doc.presets) setBackendPresets(doc.presets);
      })
      .catch(() => {});
    api.studio
      .nodes()
      .then((doc) => setNodes(doc.nodes))
      .catch(() => {});
  }, [step]);

  const passwordOk =
    password.length >= 10 &&
    password.length <= 256 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password) &&
    (/\d/.test(password) || /[^A-Za-z0-9]/.test(password)) &&
    !COMMON.has(password.toLowerCase());
  const userOk = /^[A-Za-z0-9._-]{3,64}$/.test(username);

  async function verifyToken() {
    if (tokenState === "verified") {
      advance(2);
      return;
    }
    setTokenError("");
    if (!token.trim()) {
      failToken("Paste the setup token from the container logs.");
      return;
    }
    if (!userOk) {
      setTokenError("Username must be 3–64 characters: letters, digits, '.', '_' or '-'.");
      return;
    }
    if (!passwordOk) {
      setTokenError("Password must be 10–256 characters with uppercase, lowercase, and a number or symbol.");
      return;
    }
    setVerifying(true);
    try {
      await api.setup.createAdmin({ setupToken: token.trim(), username: username.trim(), password });
      await api.session().catch(() => undefined);
      setToken("");
      setPassword("");
      setTokenState("verified");
      setReached((n) => Math.max(n, 2));
      setStep(2);
    } catch (error) {
      const message = isApiError(error) ? error.message : "Could not verify the setup token.";
      if (isApiError(error) && (error.status === 403 || /token/i.test(message))) failToken(message);
      else setTokenError(message);
    } finally {
      setVerifying(false);
    }
  }

  function failToken(message: string) {
    setTokenState("error");
    setTokenError(message);
    if (!reduce) {
      setShake(true);
      window.setTimeout(() => setShake(false), 300);
    }
  }

  function selectPreset(id: string) {
    setPicked(id);
    setTestState("untested");
    setTestDetail("");
    setRoutingError("");
    setRoutingSaved(false);
    setApiKey("");
    setLoginUrl("");
    setPkceVerifier("");
    setCallbackCode("");
    setDeviceUserCode("");
    setDeviceVerifyUri("");
    setDevicePolling(false);
    setDeviceWaited(0);
    setVertexSa(null);
    setSaError("");
    setVertexOauthToken("");
    setVertexProjectId("");
    setVertexProjects([]);
  }

  function onPresetKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, quickPresets.findIndex((item) => item.id === picked));
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % quickPresets.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + quickPresets.length) % quickPresets.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = quickPresets.length - 1;
    }
    const nextPreset = quickPresets[nextIndex];
    if (!nextPreset) return;
    selectPreset(nextPreset.id);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons[nextIndex]?.focus();
  }

  useEffect(() => {
    if (!devicePolling || !DEVICE_CODE_PROVIDER_IDS.has(preset.preset)) return;
    let cancelled = false;
    let timer = 0;
    const targetProviderId = preset.preset;
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
        .devicePoll(targetProviderId)
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
            const disc = await api.studio.discoverModels(targetProviderId, true).catch(() => null);
            const fresh = await api.studio.providers();
            setProviders(fresh.providers);
            if (fresh.presets) setBackendPresets(fresh.presets);
            const savedProv = fresh.providers.find((p) => p.id === targetProviderId);
            const { visionRef, writerRef } = selectVisionAndWriterRefs(
              disc?.models?.length ? disc.models : savedProv?.models,
              targetProviderId,
              fresh.presets || backendPresets,
              true,
            );
            setVisionModel(visionRef);
            setWriterModel(writerRef);
            const routed = await acceptRouting(visionRef, writerRef, true);
            setTestState("ok");
            setTestDetail(
              routed
                ? `${deviceProviderTitleFor(targetProviderId)} authorized · Starter routing saved`
                : `${deviceProviderTitleFor(targetProviderId)} authorized`,
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
            setTestState("fail");
            setTestDetail(isApiError(error) ? error.message : `${deviceProviderTitleFor(targetProviderId)} device authorization failed.`);
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
  }, [devicePolling, preset.preset]);

  async function startOAuthPkce() {
    setTestDetail("");
    const popup = openAsyncPopup();
    try {
      await api.studio
        .createProvider({
          id: preset.preset,
          preset: preset.preset,
          label: preset.label,
          kind: "subscription",
        })
        .catch(() => null);
      const start = await api.studio.pkceStart({ providerId: preset.preset, preset: preset.preset });
      setPkceVerifier(start.codeVerifier);
      setLoginUrl(start.authorizeUrl || "");
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
      setTestState("fail");
      setTestDetail(isApiError(error) ? error.message : error instanceof Error ? error.message : "Could not start OAuth login.");
    }
  }

  async function exchangeOAuthPkce() {
    const pasted = callbackCode.trim();
    const isDirectClaudeToken = preset.preset === "claude-oauth" && pasted.startsWith("sk-ant-");
    if (!pasted || (!pkceVerifier && !isDirectClaudeToken)) return;
    setCallbackCode("");
    setTestState("testing");
    try {
      await api.studio
        .createProvider({
          id: preset.preset,
          preset: preset.preset,
          label: preset.label,
          kind: "subscription",
        })
        .catch(() => null);
      await api.studio.pkceExchange({
        providerId: preset.preset,
        codeOrUrl: pasted,
        codeVerifier: pkceVerifier || undefined,
      });
      setPkceVerifier("");
      const disc = await api.studio.discoverModels(preset.preset, true).catch(() => null);
      const fresh = await api.studio.providers();
      setProviders(fresh.providers);
      if (fresh.presets) setBackendPresets(fresh.presets);
      const savedProv = fresh.providers.find((p) => p.id === preset.preset);
      const { visionRef, writerRef } = selectVisionAndWriterRefs(
        disc?.models?.length ? disc.models : savedProv?.models,
        preset.preset,
        fresh.presets || backendPresets,
        true,
      );
      setVisionModel(visionRef);
      setWriterModel(writerRef);
      const routed = await acceptRouting(visionRef, writerRef, true);
      setTestState("ok");
      setTestDetail(routed ? "Subscription connected · Starter routing saved" : "Subscription connected");
    } catch (error) {
      setTestState("fail");
      setTestDetail(isApiError(error) ? error.message : error instanceof Error ? error.message : "OAuth exchange failed.");
    }
  }

  async function startVertexOAuth() {
    setTestDetail("");
    const customClientId = vertexClientId.trim();
    const resolvedClientId = customClientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
    const popup = openAsyncPopup();
    try {
      await api.studio
        .createProvider({
          id: "vertex-ai",
          preset: "vertex-ai",
          label: preset.label || "Google Cloud Vertex AI",
          kind: "cloud-iam",
          protocol: "vertex-openai",
          auth: {
            mode: "vertex-oauth",
            clientId: resolvedClientId,
            projectId: vertexProjectId.trim() || undefined,
            location: vertexLocation || "global",
          },
        })
        .catch(() => null);
      const start = await api.studio.pkceStart({
        providerId: "vertex-ai",
        mode: "vertex-oauth",
        preset: "vertex-ai",
        ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID
          ? { clientId: customClientId }
          : {}),
      });
      const url =
        start.authorizeUrl ||
        `https://accounts.google.com/o/oauth2/auth?client_id=${encodeURIComponent(resolvedClientId)}&redirect_uri=${encodeURIComponent("https://sdk.cloud.google.com/applicationdefaultauthcode.html")}&scope=${encodeURIComponent("openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform")}&response_type=code&access_type=offline&prompt=consent&token_usage=remote`;
      setPkceVerifier(start.codeVerifier);
      setLoginUrl(url);
      if (popup && !popup.closed) {
        popup.location.href = url;
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      popup?.close();
      setTestState("fail");
      setTestDetail(isApiError(error) ? error.message : error instanceof Error ? error.message : "Could not start Google OAuth login.");
    }
  }

  async function exchangeVertexOAuth() {
    const pasted = vertexOauthToken.trim();
    if (!pasted) return;
    const customClientId = vertexClientId.trim();
    const resolvedClientId = customClientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID;
    const isCodeOrCallback =
      pasted.startsWith("http://") ||
      pasted.startsWith("https://") ||
      (!pasted.startsWith("ya29.") && !pasted.startsWith("{"));
    setVertexOauthToken("");
    setTestState("testing");
    try {
      await api.studio
        .createProvider({
          id: "vertex-ai",
          preset: "vertex-ai",
          label: preset.label || "Google Cloud Vertex AI",
          kind: "cloud-iam",
          protocol: "vertex-openai",
          auth: {
            mode: "vertex-oauth",
            clientId: resolvedClientId,
            projectId: vertexProjectId.trim() || undefined,
            location: vertexLocation || "global",
          },
        })
        .catch(() => null);
      const exRes = await api.studio.pkceExchange({
        providerId: "vertex-ai",
        mode: "vertex-oauth",
        ...(isCodeOrCallback
          ? { codeOrUrl: pasted, codeVerifier: pkceVerifier || undefined }
          : { accessToken: pasted }),
        ...(customClientId && customClientId !== DEFAULT_GOOGLE_OAUTH_CLIENT_ID
          ? { clientId: customClientId }
          : {}),
      });
      if (isCodeOrCallback) setPkceVerifier("");
      const detectedProjectId = exRes.provider?.auth?.projectId || exRes.projectId || "";
      const detectedList = exRes.projects || exRes.provider?.auth?.projects || [];
      const effectiveProjectId = vertexProjectId.trim() || detectedProjectId;
      if (effectiveProjectId) setVertexProjectId(effectiveProjectId);
      if (detectedList.length > 0) setVertexProjects(detectedList);
      await api.studio.updateProvider("vertex-ai", {
        auth: {
          mode: "vertex-oauth",
          clientId: resolvedClientId,
          projectId: effectiveProjectId || undefined,
          location: vertexLocation || "global",
        },
      });
      const disc = await api.studio.discoverModels("vertex-ai", true).catch(() => null);
      const fresh = await api.studio.providers();
      setProviders(fresh.providers);
      if (fresh.presets) setBackendPresets(fresh.presets);
      const savedVertex = fresh.providers.find((p) => p.id === "vertex-ai");
      const { visionRef: nextVision, writerRef: nextWriter } = selectVisionAndWriterRefs(
        disc?.models?.length ? disc.models : savedVertex?.models,
        "vertex-ai",
        fresh.presets || backendPresets,
        true,
      );
      setVisionModel(nextVision);
      setWriterModel(nextWriter);
      await acceptRouting(nextVision, nextWriter, true);
      setTestState("ok");
      setTestDetail(
        effectiveProjectId
          ? `Google Account connected · Project ${effectiveProjectId}`
          : "Google Account connected · Starter routing saved",
      );
    } catch (error) {
      setTestState("fail");
      setTestDetail(isApiError(error) ? error.message : error instanceof Error ? error.message : "Vertex OAuth exchange failed.");
    }
  }

  async function startDeviceLogin() {
    setTestDetail("");
    const targetProviderId = preset.preset;
    const popup = openAsyncPopup();
    try {
      const start = await api.studio.deviceStart(targetProviderId, {
        clientId: deviceClientIdFor(targetProviderId),
      });
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
      setTestState("fail");
      setTestDetail(
        isApiError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : `Could not start ${deviceProviderTitleFor(targetProviderId)} Device Code login.`,
      );
    }
  }

  async function verifyDeviceLogin() {
    if (pollInFlightRef.current) return;
    setTestDetail("");
    const targetProviderId = preset.preset;
    pollInFlightRef.current = true;
    try {
      const res = await api.studio.devicePoll(targetProviderId);
      const pollHint = res as { interval?: number; slowDown?: boolean };
      if (typeof pollHint.interval === "number" && pollHint.interval > 0) {
        const nextMs = pollHint.interval >= 1000 ? pollHint.interval : pollHint.interval * 1000;
        pollIntervalMsRef.current = Math.max(pollIntervalMsRef.current, nextMs);
      } else if (pollHint.slowDown) {
        pollIntervalMsRef.current += 5000;
      }
      if (res.status === "authorized") {
        setDevicePolling(false);
        const disc = await api.studio.discoverModels(targetProviderId, true).catch(() => null);
        const fresh = await api.studio.providers();
        setProviders(fresh.providers);
        if (fresh.presets) setBackendPresets(fresh.presets);
        const savedProv = fresh.providers.find((p) => p.id === targetProviderId);
        const { visionRef, writerRef } = selectVisionAndWriterRefs(
          disc?.models?.length ? disc.models : savedProv?.models,
          targetProviderId,
          fresh.presets || backendPresets,
          true,
        );
        setVisionModel(visionRef);
        setWriterModel(writerRef);
        const routed = await acceptRouting(visionRef, writerRef, true);
        setTestState("ok");
        setTestDetail(
          routed
            ? `${deviceProviderTitleFor(targetProviderId)} authorized · Starter routing saved`
            : `${deviceProviderTitleFor(targetProviderId)} authorized`,
        );
      } else {
        setTestDetail(`Waiting for ${deviceProviderTitleFor(targetProviderId)} browser approval…`);
      }
    } catch (error) {
      setTestState("fail");
      setTestDetail(isApiError(error) ? error.message : error instanceof Error ? error.message : "Device verification failed.");
    } finally {
      pollInFlightRef.current = false;
    }
  }

  async function testProvider() {
    const id = preset.preset;
    const hasStoredSecret = providers.some((p) => p.id === id && p.auth.hasSecret);
    if ((preset.mode === "key" || preset.mode === "custom") && !hasStoredSecret && !apiKey.trim()) {
      setTestState("fail");
      setTestDetail("Enter an API key to verify and add this provider.");
      return;
    }
    setTestState("testing");
    setElapsed(0);
    setTestDetail("");
    setRoutingError("");
    setVisionModel("");
    setWriterModel("");
    try {
      const body: Parameters<typeof api.studio.createProvider>[0] = {
        id,
        preset: preset.preset,
        label: preset.label,
        allowPrivateNetwork: preset.mode === "local",
      };
      if (SUBSCRIPTION_PROVIDER_IDS.has(preset.preset)) {
        body.kind = "subscription";
        if (preset.baseUrl) body.baseUrl = preset.baseUrl;
      }
      if (preset.mode === "local") body.baseUrl = preset.baseUrl;
      if (preset.mode === "custom") {
        if (!customUrl.startsWith("https://")) throw new Error("Custom provider URL must start with https://");
        body.baseUrl = customUrl.replace(/\/+$/, "");
        body.kind = "cloud-api";
        body.protocol = "openai-compatible";
      }
      if (preset.mode === "vertex") {
        if (vertexMode === "vertex-oauth") {
          if (vertexOauthToken.trim()) {
            await exchangeVertexOAuth();
            return;
          }
          const existingVertex = providers.some((p) => p.id === id && p.auth.hasSecret);
          if (!existingVertex) {
            throw new Error("Sign in with Google OAuth and paste your authorization code or token first.");
          }
          body.kind = "cloud-iam";
          body.protocol = "vertex-openai";
          body.auth = {
            mode: "vertex-oauth",
            clientId: DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
            projectId: vertexProjectId.trim() || undefined,
            location: vertexLocation || "global",
          };
        } else {
          const existingVertex = providers.some((p) => p.id === id && p.auth.hasSecret);
          if (!vertexSa && !existingVertex) {
            throw new Error("Drop a Vertex service account .json key first.");
          }
          body.kind = "cloud-iam";
          body.protocol = "vertex-openai";
          if (vertexSa) {
            body.serviceAccountJson = vertexSa.json;
            body.auth = { mode: "vertex-service-account", projectId: vertexSa.projectId, location: vertexLocation || "global" };
          }
        }
      }
      if ((preset.mode === "key" || preset.mode === "custom") && apiKey.trim()) {
        body.apiKey = apiKey.trim();
      }
      if (preset.mode === "key" || preset.mode === "custom") {
        body.verifyBeforeSave = true;
      }
      const created = await api.studio.createProvider(body);
      setApiKey("");
      setVertexSa(null);
      const probe = await api.studio.testProvider(id);
      const discovered = await api.studio.discoverModels(id, true).catch(() => null);
      const models =
        discovered?.models?.length
          ? discovered.models
          : probe.models?.length
            ? probe.models
            : created.provider?.models || [];
      const { visionRef: nextVision, writerRef: nextWriter } = selectVisionAndWriterRefs(
        models,
        id,
        backendPresets,
        preset.mode === "vertex",
      );
      setVisionModel(nextVision);
      setWriterModel(nextWriter);
      setLatency(probe.latencyMs);
      setTestState(probe.ok ? "ok" : "fail");
      setTestDetail(
        probe.ok
          ? `Connected · ${formatLatency(probe.latencyMs)} · ${models.length} models`
          : probe.error || "Connection failed",
      );
      const fresh = await api.studio.providers();
      setProviders(fresh.providers);
      if (fresh.presets) setBackendPresets(fresh.presets);
      if (probe.ok || nextVision || nextWriter) {
        await acceptRouting(nextVision, nextWriter, true);
      }
    } catch (error) {
      setTestState("fail");
      setTestDetail(isApiError(error) ? error.message : error instanceof Error ? error.message : "Connection failed");
    }
  }

  async function acceptRouting(overrideVision?: string, overrideWriter?: string, silent = false): Promise<boolean> {
    let resolvedVision = overrideVision ?? visionModel;
    let resolvedWriter = overrideWriter ?? writerModel;
    if (!resolvedVision && !resolvedWriter && providers.length > 0) {
      const firstProvider = providers[0]!;
      const pickedRefs = selectVisionAndWriterRefs(
        firstProvider.models,
        firstProvider.id,
        backendPresets,
        true,
      );
      resolvedVision = pickedRefs.visionRef;
      resolvedWriter = pickedRefs.writerRef;
    }
    if (!resolvedVision && !resolvedWriter) {
      const msg = "Connect and verify an AI provider before saving starter routing.";
      setRoutingError(msg);
      return false;
    }
    setRoutingError("");
    try {
      const stages = await api.studio.stages();
      const visionChain = resolvedVision ? [resolvedVision] : stages.reader.chain;
      const writerChain = resolvedWriter ? [resolvedWriter] : stages.writer.chain;
      const stagePayload: Record<string, Partial<StageRoute>> = {
        reader: {
          ...stages.reader,
          stage: "reader",
          chain: visionChain,
          primary: visionChain[0] ?? null,
          fallbacks: visionChain.slice(1),
          inheritFrom: null,
        },
        matcher: {
          ...stages.matcher,
          stage: "matcher",
          chain: visionChain,
          primary: visionChain[0] ?? null,
          fallbacks: visionChain.slice(1),
          inheritFrom: "reader",
        },
        writer: {
          ...stages.writer,
          stage: "writer",
          chain: writerChain,
          primary: writerChain[0] ?? null,
          fallbacks: writerChain.slice(1),
          inheritFrom: null,
        },
        scout: {
          ...stages.scout,
          stage: "scout",
          chain: visionChain,
          primary: visionChain[0] ?? null,
          fallbacks: visionChain.slice(1),
          inheritFrom: "reader",
        },
        fact_check: {
          ...stages.fact_check,
          stage: "fact_check",
          chain: writerChain,
          primary: writerChain[0] ?? null,
          fallbacks: writerChain.slice(1),
          inheritFrom: null,
        },
      };
      await api.studio.putStages({
        revision: stages.revision,
        stages: stagePayload,
      });
      setRoutingSaved(true);
      if (!silent) setTestDetail("Starter routing saved.");
      return true;
    } catch (error) {
      const msg = isApiError(error) ? error.message : error instanceof Error ? error.message : "Could not save starter routing.";
      setRoutingError(msg);
      setRoutingSaved(false);
      return false;
    }
  }

  async function continueFromStep2() {
    if (!routingSaved) {
      const ok = await acceptRouting(undefined, undefined, true);
      if (!ok) return;
    }
    advance(3);
  }

  async function finishAndCreateSeries() {
    setLaunching(true);
    setLaunchError("");
    try {
      if (!routingSaved) {
        const ok = await acceptRouting(undefined, undefined, true);
        if (!ok) {
          setLaunching(false);
          return;
        }
      }
      await api.setup.complete();
      window.location.assign("/new-series.html");
    } catch (error) {
      setLaunchError(isApiError(error) ? error.message : "Could not complete setup.");
      setLaunching(false);
    }
  }

  async function ensureLocal() {
    setLaneNote("");
    setLaneError("");
    try {
      const created = await api.studio.createNode({
        id: "local",
        label: "Local host",
        kind: "local",
        enabled: true,
        slots: 1,
        supportsCleaner: true,
      });
      setNodes(created.nodes);
      setLaneNote("Local lane is on.");
    } catch (error) {
      setLaneError(isApiError(error) ? error.message : "Could not add the local lane.");
    }
  }

  async function probeLocal() {
    setProbing(true);
    setLaneNote("");
    setLaneError("");
    try {
      const probe = await api.studio.testNode("local");
      setLaneNote(probe.ok ? `Local probe ok · ${probe.reason}` : probe.reason);
    } catch (error) {
      setLaneError(isApiError(error) ? error.message : "Probe failed");
    } finally {
      setProbing(false);
    }
  }

  function openQuickLane(kind: Exclude<RenderNodeKind, "local">) {
    const meta = getRenderKindMeta(kind);
    setQuickLaneKind(kind);
    setNodeId(meta.defaultIdPrefix);
    setNodeLabel(meta.shortLabel);
    setNodeBox("");
    setNodeSlots(meta.defaultSlots);
    setNodeHost("");
    setNodeUser(meta.defaultUser || DEFAULT_SSH_USER);
    setNodePort(meta.defaultPort || DEFAULT_SSH_PORT);
    setNodeRemoteDir(meta.defaultRemoteDir || DEFAULT_SSH_REMOTE_DIR);
    setNodeSshKey("");
    setLaneError("");
  }

  async function saveQuickLane() {
    if (!quickLaneKind) return;
    setLaneError("");
    setLaneNote("");
    const trimmedId = nodeId.trim();
    if (!NODE_ID_RE.test(trimmedId)) {
      setLaneError("Node id must match letters, digits, '.', '_' or '-' and not start with a dash.");
      return;
    }
    if (quickLaneKind === "docker-sbx" && !BOX_RE.test(nodeBox.trim())) {
      setLaneError("Box name must match ^[a-z0-9][a-z0-9-]{2,62}$");
      return;
    }
    if (
      quickLaneKind === "ssh" &&
      (!HOST_RE.test(nodeHost.trim()) || nodeHost.trim().startsWith("-") || !HOST_RE.test(nodeUser.trim()))
    ) {
      setLaneError("SSH host and user allow only letters, digits, '.', '_' and '-'. No leading dash.");
      return;
    }
    setSavingNode(true);
    try {
      const created = await api.studio.createNode({
        id: trimmedId,
        label: nodeLabel.trim() || trimmedId,
        kind: quickLaneKind,
        enabled: true,
        slots: clampSlotsForKind(quickLaneKind, nodeSlots),
        supportsCleaner: true,
        box: quickLaneKind === "docker-sbx" ? nodeBox.trim() : undefined,
        template: quickLaneKind === "docker-sbx" ? DEFAULT_SANDBOX_TEMPLATE : undefined,
        maxHours: quickLaneKind === "docker-sbx" ? DEFAULT_SANDBOX_MAX_HOURS : undefined,
        idlePauseS: quickLaneKind === "docker-sbx" ? DEFAULT_SANDBOX_IDLE_PAUSE_S : undefined,
        host: quickLaneKind === "ssh" ? nodeHost.trim() : undefined,
        user: quickLaneKind === "ssh" ? nodeUser.trim() : undefined,
        port: quickLaneKind === "ssh" ? nodePort : undefined,
        remoteDir: quickLaneKind === "ssh" ? nodeRemoteDir.trim() || DEFAULT_SSH_REMOTE_DIR : undefined,
        privateKey: quickLaneKind === "ssh" && nodeSshKey.trim() ? nodeSshKey.trim() : undefined,
      });
      setNodeSshKey("");
      setNodes(created.nodes);
      setQuickLaneKind(null);
      setLaneNote(`Added render node ${trimmedId}.`);
    } catch (error) {
      setLaneError(isApiError(error) ? error.message : "Could not save render node.");
    } finally {
      setSavingNode(false);
    }
  }

  async function launch() {
    setLaunching(true);
    setLaunchError("");
    try {
      if (!routingSaved && (visionModel || writerModel || providers.length > 0)) {
        const ok = await acceptRouting(undefined, undefined, true);
        if (!ok) {
          setLaunching(false);
          return;
        }
      }
      await api.setup.complete();
      window.location.assign("/studio.html");
    } catch (error) {
      setLaunchError(isApiError(error) ? error.message : "Could not close setup.");
      setLaunching(false);
    }
  }

  function go(next: number) {
    if (next > reached) return;
    setStep(next);
  }

  function advance(next: number) {
    setReached((n) => Math.max(n, next));
    setStep(next);
  }

  const rules = useMemo(() => RULES.map((rule) => ({ ...rule, ok: rule.test(password) })), [password]);

  if (gate !== "open") {
    return (
      <main className="grid min-h-dvh place-items-center bg-[#101113] text-[#a2a19f]">
        <p className="font-serif text-2xl text-[#f2efe9]">{gate === "closed" ? "Setup is closed." : "Checking the booth…"}</p>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#101113] text-[#f2efe9]" style={{ fontFamily: '"DM Sans", system-ui, sans-serif' }}>
      <style>{SETUP_CSS}</style>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        <header className="flex items-end justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-[#f18b6e] text-[#201713]" aria-hidden>
              <svg viewBox="0 0 24 24" className="size-4 fill-current"><path d="M8 5.5v13l11-6.5-11-6.5z" /></svg>
            </span>
            <div>
              <p className="text-[10px] tracking-[0.18em] text-[#a2a19f] uppercase">Setup</p>
              <h1 className="font-serif text-3xl leading-none tracking-tight">Screening Room Studio</h1>
            </div>
          </div>
          <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#f2efe9]">
            Step {step} of 4
          </Badge>
        </header>

        <Stepper value={step} onValueChange={go} aria-label="First-run setup steps">
          {STEPS.map((item, index) => (
            <StepperItem key={item.n} step={item.n} disabled={item.n > reached}>
              <StepperTrigger className="min-h-11">
                <StepperIndicator>{step > item.n ? undefined : String(item.n).padStart(2, "0")}</StepperIndicator>
                <StepperTitle>{item.title}</StepperTitle>
              </StepperTrigger>
              {index < STEPS.length - 1 ? <StepperSeparator /> : null}
            </StepperItem>
          ))}
        </Stepper>

        <motion.section
          key={step}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28 }}
          className="rounded-2xl border border-[#2b2c30] bg-[#17181a] p-5 sm:p-6"
          aria-labelledby={`setup-head-${step}`}
        >
          {step === 1 ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="setup-head-1" tabIndex={-1} className="font-serif text-2xl outline-none">
                  1. Admin account
                </h2>
                <div id="tokenHint" className="flex flex-wrap items-center gap-1.5 text-xs">
                  <code className="rounded-md border border-[#2b2c30] bg-[#101113] px-2 py-0.5 font-mono text-[#5eead4]">docker logs manhwa-backend</code>
                  <code className="rounded-md border border-[#2b2c30] bg-[#101113] px-2 py-0.5 font-mono text-[#5eead4]">MANHWA_SETUP_TOKEN</code>
                </div>
              </div>

              <div className={`token-box ${shake ? "is-shake" : ""} ${tokenState === "error" ? "is-error" : ""} ${tokenState === "verified" ? "is-verified" : ""}`} data-state={tokenState}>
                {tokenState === "verified" ? <span className="token-sheen" aria-hidden /> : null}
                <label className="sr-only" htmlFor="setupToken">Setup token</label>
                <input
                  id="setupToken"
                  type={showToken ? "text" : "password"}
                  className="token-input min-h-11"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste setup token…"
                  value={token}
                  disabled={tokenState === "verified"}
                  aria-describedby="tokenHint"
                  aria-invalid={tokenState === "error"}
                  onChange={(event) => {
                    setToken(event.target.value);
                    if (tokenState === "error") setTokenState("idle");
                  }}
                />
                <button
                  type="button"
                  className="token-show min-h-11 min-w-11"
                  onClick={() => setShowToken((v) => !v)}
                  aria-label={showToken ? "Hide setup token" : "Show setup token"}
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
                <span className="token-pill min-h-11">{tokenState === "verified" ? "Verified" : tokenState === "error" ? "Invalid" : "Required"}</span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm">
                  Admin username
                  <input
                    id="adminUser"
                    className="field min-h-11"
                    value={username}
                    autoComplete="username"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </label>
                <div className="flex flex-col gap-1.5 text-sm">
                  <label htmlFor="adminPass">Admin password</label>
                  <PasswordInput id="adminPass" value={password} onValueChange={setPassword} scorer={scorePassword}>
                    <PasswordInputField
                      className="min-h-11 [&_input]:min-h-11 [&_button]:min-h-11 [&_button]:min-w-11"
                      autoComplete="new-password"
                      minLength={10}
                      placeholder="10+ characters"
                    />
                    <PasswordInputStrength />
                  </PasswordInput>
                  <ul className="mt-1 grid grid-cols-2 gap-1 text-[11px] text-[#a2a19f]">
                    {rules.map((rule) => (
                      <li key={rule.id} className={rule.ok ? "text-[#aed1a8]" : ""}>
                        {rule.ok ? "✓" : "○"} {rule.label}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              {tokenError ? <p className="text-sm text-[#f0a096]" role="alert">{tokenError}</p> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" className="min-h-11" disabled={verifying} onClick={() => void verifyToken()}>
                  {verifying ? "Verifying…" : tokenState === "verified" ? "Continue" : "Verify & Continue"}
                </Button>
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id="setup-head-2" tabIndex={-1} className="font-serif text-2xl outline-none">
                    2. AI provider
                  </h2>
                  <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#a2a19f]">Vision + Writer</Badge>
                </div>
                <span className={`test-pill is-${testState}`} data-state={testState}>
                  {testState === "testing" ? <LoaderCircle className="size-3 animate-spin" /> : null}
                  {testState === "testing" ? `Testing · ${elapsed.toFixed(1)}s` : testState === "ok" ? testDetail : testState === "fail" ? "Failed" : "Not tested"}
                </span>
              </div>
              <div
                className="grid grid-cols-2 gap-2 sm:grid-cols-5"
                role="radiogroup"
                aria-label="Choose provider preset"
                onKeyDown={onPresetKeyDown}
              >
                {quickPresets.map((item) => {
                  const on = item.id === picked;
                  const live = providers.some(
                    (provider) => provider.id === item.preset && (provider.auth.hasSecret || item.mode === "local"),
                  );
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      tabIndex={on ? 0 : -1}
                      className={`preset-tile ${on ? "is-on" : ""}`}
                      onClick={() => selectPreset(item.id)}
                    >
                      <span className="font-medium">{item.label}</span>
                      <span className="text-[11px] text-[#a2a19f]">{live ? "Connected" : item.hint}</span>
                    </button>
                  );
                })}
              </div>
              <div className="rounded-xl border border-[#2b2c30] bg-[#101113] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="font-medium text-sm text-[#f2efe9]">{preset.label}</strong>
                  <Badge variant="outline" className="border-[#3c3e44] font-mono text-[11px] text-[#a2a19f]">{preset.hint}</Badge>
                </div>
                {(() => {
                  const connectedProv = providers.find((p) => p.id === preset.preset && p.auth.hasSecret);
                  if (!connectedProv) return null;
                  return (
                    <SetupConnectedAccountBanner
                      provider={connectedProv}
                      projects={vertexProjects}
                      onSelectProject={(nextProj) => {
                        setVertexProjectId(nextProj);
                        void api.studio
                          .updateProvider(connectedProv.id, {
                            auth: {
                              mode: connectedProv.auth.mode || "vertex-oauth",
                              clientId: vertexClientId.trim() || connectedProv.auth.clientId || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
                              projectId: nextProj || undefined,
                              location: vertexLocation || "global",
                            },
                          })
                          .then((res) => setProviders(res.providers))
                          .catch(() => {});
                      }}
                    />
                  );
                })()}
                {preset.mode === "custom" ? (
                  <label className="mt-3 flex flex-col gap-1.5 text-sm">
                    Base URL
                    <input
                      className="field min-h-11 font-mono"
                      value={customUrl}
                      spellCheck={false}
                      onChange={(event) => setCustomUrl(event.target.value)}
                    />
                  </label>
                ) : null}
                {preset.mode === "key" || preset.mode === "custom" ? (
                  <div className="mt-3 flex flex-col gap-1.5 text-sm">
                    <label htmlFor="setupApiKey">API key</label>
                    <PasswordInput id="setupApiKey" value={apiKey} onValueChange={setApiKey}>
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
                {preset.mode === "oauth" ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#5eead4]">Step 1</Badge>
                      <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => void startOAuthPkce()}>
                        Open Claude Sign-In
                      </Button>
                      {loginUrl ? (
                        <>
                          <a
                            href={loginUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                          >
                            Open sign-in link
                          </a>
                          <CopyButton value={loginUrl} label="Copy link" />
                        </>
                      ) : null}
                    </div>
                    {loginUrl ? <p className="break-all font-mono text-xs text-[#5eead4]">{loginUrl}</p> : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#a2a19f]">Step 2</Badge>
                      <input
                        className="field min-h-11 flex-1 font-mono"
                        aria-label="Claude authorization code or setup token"
                        value={callbackCode}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="code#state or sk-ant-oat01-..."
                        onChange={(event) => setCallbackCode(event.target.value)}
                      />
                      <Button
                        type="button"
                        className="min-h-11 w-full sm:w-auto"
                        disabled={
                          !callbackCode.trim() ||
                          (!pkceVerifier && !(preset.preset === "claude-oauth" && callbackCode.trim().startsWith("sk-ant-")))
                        }
                        onClick={() => void exchangeOAuthPkce()}
                      >
                        Connect
                      </Button>
                    </div>
                  </div>
                ) : null}
                {preset.mode === "device" ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#5eead4]">Step 1</Badge>
                      <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => void startDeviceLogin()}>
                        {deviceButtonLabelFor(preset.preset)}
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
                      <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#a2a19f]">Step 2</Badge>
                      <Button
                        type="button"
                        className="min-h-11 w-full sm:w-auto"
                        disabled={!deviceUserCode}
                        onClick={() => void verifyDeviceLogin()}
                      >
                        Connect
                      </Button>
                      {devicePolling ? (
                        <span className="font-mono text-xs text-[#5eead4]">
                          Polling · {deviceWaited.toFixed(0)}s
                        </span>
                      ) : null}
                    </div>
                    {preset.preset === "codex-oauth" ? (
                      <details className="mt-1 text-xs text-[#a2a19f]">
                        <summary className="cursor-pointer select-none">Browser redirect (PKCE)</summary>
                        <div className="mt-2 flex flex-col gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#5eead4]">Step 1</Badge>
                            <Button type="button" variant="outline" size="sm" className="min-h-11 w-full sm:w-auto" onClick={() => void startOAuthPkce()}>
                              Open Redirect
                            </Button>
                            {loginUrl ? (
                              <>
                                <a
                                  href={loginUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                                >
                                  Open sign-in link
                                </a>
                                <CopyButton value={loginUrl} label="Copy link" />
                              </>
                            ) : null}
                          </div>
                          {loginUrl ? <p className="break-all font-mono text-xs text-[#5eead4]">{loginUrl}</p> : null}
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#a2a19f]">Step 2</Badge>
                            <input
                              className="field min-h-11 flex-1 font-mono"
                              aria-label="Callback URL or code"
                              value={callbackCode}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="Callback URL or code"
                              onChange={(event) => setCallbackCode(event.target.value)}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="min-h-11 w-full sm:w-auto"
                              disabled={!callbackCode.trim() || !pkceVerifier}
                              onClick={() => void exchangeOAuthPkce()}
                            >
                              Connect
                            </Button>
                          </div>
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
                {preset.mode === "vertex" ? (
                  <div className="mt-3 flex flex-col gap-3">
                    <div className="flex flex-wrap gap-1" role="tablist" aria-label="Vertex AI sign-in mode">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={vertexMode === "vertex-oauth"}
                        className={`preset-tile min-h-11 px-3 py-1.5 text-xs ${vertexMode === "vertex-oauth" ? "is-on" : ""}`}
                        onClick={() => setVertexMode("vertex-oauth")}
                      >
                        Google OAuth
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={vertexMode === "vertex-service-account"}
                        className={`preset-tile min-h-11 px-3 py-1.5 text-xs ${vertexMode === "vertex-service-account" ? "is-on" : ""}`}
                        onClick={() => setVertexMode("vertex-service-account")}
                      >
                        Service Account (.json)
                      </button>
                    </div>
                    {vertexMode === "vertex-service-account" ? (
                      <>
                        <Dropzone
                          accept={{ "application/json": [".json"] }}
                          maxFiles={1}
                          maxSize={64 * 1024}
                          aria-label="Drop GCP Vertex service account JSON"
                          onDrop={(files, rejections) => {
                            if (rejections.length > 0) {
                              setVertexSa(null);
                              setSaError(formatDropzoneRejection(rejections));
                              return;
                            }
                            const file = files[0];
                            if (!file) return;
                            void readServiceAccount(file).then((result) => {
                              if ("error" in result) {
                                setVertexSa(null);
                                setSaError(result.error);
                                return;
                              }
                              setSaError("");
                              setVertexSa(result);
                              setVertexProjectId(result.projectId);
                            });
                          }}
                        >
                          <DropzoneEmptyState
                            title="Drop .json key"
                            description="Max 64 KB"
                          />
                          <DropzoneContent />
                        </Dropzone>
                        {vertexSa ? (
                          <p className="font-mono text-xs text-[#aed1a8]">
                            {vertexSa.clientEmail} · {vertexSa.projectId}
                          </p>
                        ) : null}
                        {saError ? (
                          <p className="text-xs text-[#f0a096]" role="alert">
                            {saError}
                          </p>
                        ) : null}
                      </>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#5eead4]">Step 1</Badge>
                          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => void startVertexOAuth()}>
                            Sign in with Google
                          </Button>
                          {loginUrl ? (
                            <>
                              <a
                                href={loginUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="btn inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[#2b2c30] bg-[#17181a] px-3 text-xs text-[#5eead4] hover:border-[#f18b6e] sm:w-auto"
                              >
                                Open sign-in link
                              </a>
                              <CopyButton value={loginUrl} label="Copy URL" />
                            </>
                          ) : null}
                        </div>
                        {loginUrl ? <p className="break-all font-mono text-xs text-[#5eead4]">{loginUrl}</p> : null}
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="border-[#3c3e44] font-mono text-[#a2a19f]">Step 2</Badge>
                          <input
                            className="field min-h-11 flex-1 font-mono"
                            aria-label="Google verification code"
                            value={vertexOauthToken}
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="4/0A... code"
                            onChange={(event) => setVertexOauthToken(event.target.value)}
                          />
                          <Button
                            type="button"
                            className="min-h-11 w-full sm:w-auto"
                            disabled={!vertexOauthToken.trim() || testState === "testing"}
                            onClick={() => void exchangeVertexOAuth()}
                          >
                            Connect
                          </Button>
                        </div>
                        <details className="mt-1 text-xs text-[#a2a19f]">
                          <summary className="cursor-pointer select-none">
                            Advanced settings (Location / Custom Client ID)
                          </summary>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <label className="flex flex-col gap-1 text-xs text-[#a2a19f]">
                              Vertex Location
                              <select
                                className="field min-h-11 font-mono"
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
                            <label className="flex flex-col gap-1 text-xs text-[#a2a19f]">
                              Project ID (optional)
                              <input
                                className="field min-h-11 font-mono"
                                value={vertexProjectId}
                                placeholder="Auto-detected on sign-in"
                                onChange={(event) => setVertexProjectId(event.target.value)}
                              />
                            </label>
                            {vertexProjects.length > 1 ? (
                              <label className="flex flex-col gap-1 text-xs text-[#a2a19f] sm:col-span-2">
                                Switch detected GCP Project
                                <select
                                  className="field min-h-11 font-mono"
                                  value={vertexProjectId}
                                  onChange={(event) => {
                                    const nextProj = event.target.value;
                                    setVertexProjectId(nextProj);
                                    void api.studio
                                      .updateProvider("vertex-ai", {
                                        auth: {
                                          mode: "vertex-oauth",
                                          clientId: vertexClientId.trim() || DEFAULT_GOOGLE_OAUTH_CLIENT_ID,
                                          projectId: nextProj || undefined,
                                          location: vertexLocation || "global",
                                        },
                                      })
                                      .then((res) => setProviders(res.providers))
                                      .catch(() => {});
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
                            <label className="flex flex-col gap-1 text-xs text-[#a2a19f] sm:col-span-2">
                              Google OAuth Client ID
                              <input
                                className="field min-h-11 font-mono"
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
                {preset.mode === "local" ? (
                  <p className="mt-3 font-mono text-xs text-[#a2a19f]">
                    {preset.baseUrl}
                  </p>
                ) : null}
                {preset.mode !== "oauth" && preset.mode !== "device" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={testState === "testing"} onClick={() => void testProvider()}>
                      Test &amp; Connect
                    </Button>
                  </div>
                ) : null}
                {testState === "fail" ? <p className="mt-2 text-sm text-[#f0a096]" role="alert">{testDetail}</p> : null}
              </div>
              {visionModel || writerModel ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#3d523b] bg-[#1e281f] px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="rounded-md border border-[#3d523b] bg-[#101113]/60 px-2 py-1 font-mono text-[#aed1a8]">
                      Vision: {visionModel ? stripProviderPrefixUi(visionModel.replace(/^[^:]+:/, ""), preset.preset) : "—"}
                    </span>
                    <span className="rounded-md border border-[#3d523b] bg-[#101113]/60 px-2 py-1 font-mono text-[#aed1a8]">
                      Writer: {writerModel ? stripProviderPrefixUi(writerModel.replace(/^[^:]+:/, ""), preset.preset) : "—"}
                    </span>
                    {latency != null ? <span className="font-mono text-[#aed1a8]">{formatLatency(latency)}</span> : null}
                  </div>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 sm:w-auto md:min-h-8" onClick={() => void acceptRouting()}>
                    {routingSaved ? "Routing saved ✓" : "Save routing"}
                  </Button>
                  {routingError ? (
                    <p className="w-full text-sm text-[#f0a096]" role="alert">
                      {routingError}
                    </p>
                  ) : null}
                </div>
              ) : routingError ? (
                <p className="text-sm text-[#f0a096]" role="alert">
                  {routingError}
                </p>
              ) : null}
              {launchError ? <p className="text-sm text-[#f0a096]" role="alert">{launchError}</p> : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="ghost" className="min-h-11 w-full sm:w-auto" onClick={() => go(1)}>Back</Button>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    onClick={() => void continueFromStep2()}
                    disabled={providers.length === 0 && testState !== "ok"}
                  >
                    Render lanes
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={(providers.length === 0 && testState !== "ok") || launching}
                    onClick={() => void finishAndCreateSeries()}
                  >
                    {launching ? "Finishing…" : "Finish & Create Series →"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {step === 3 ? (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="setup-head-3" tabIndex={-1} className="font-serif text-2xl outline-none">
                  3. Render lanes
                </h2>
                <Badge variant="outline" className="border-[#3d523b] font-mono text-[#aed1a8]">Local worker active</Badge>
              </div>
              <ul className="flex flex-col gap-2">
                {nodes.map((node) => (
                  <li key={node.id} className="flex items-center justify-between rounded-xl border border-[#2b2c30] bg-[#101113] px-3 py-3">
                    <span>
                      <strong>{node.label}</strong> <code className="font-mono text-xs text-[#a2a19f]">{node.id}</code>
                    </span>
                    <span className="font-mono text-xs text-[#5eead4]">{node.kind}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="min-h-11" onClick={() => void ensureLocal()}>
                  Enable local
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={probing || !nodes.some((node) => node.id === "local")}
                  onClick={() => void probeLocal()}
                >
                  {probing ? "Probing…" : "Test local"}
                </Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => openQuickLane("ssh")}>
                  + SSH
                </Button>
                <Button type="button" variant="outline" className="min-h-11" onClick={() => openQuickLane("docker-sbx")}>
                  + Sandbox
                </Button>
              </div>
              {quickLaneKind ? (
                <div className="flex flex-col gap-3 rounded-xl border border-[#2b2c30] bg-[#101113] p-4">
                  <div className="flex items-center justify-between">
                    <strong className="font-serif text-lg">
                      {quickLaneKind === "docker-sbx" ? "Cloud Sandbox" : "Remote SSH"}
                    </strong>
                    <span className="font-mono text-xs text-[#5eead4]">{quickLaneKind}</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex flex-col gap-1 text-sm">
                      Node ID
                      <input
                        className="field min-h-11 font-mono"
                        value={nodeId}
                        onChange={(event) => setNodeId(event.target.value)}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      Label
                      <input
                        className="field min-h-11"
                        value={nodeLabel}
                        onChange={(event) => setNodeLabel(event.target.value)}
                      />
                    </label>
                  </div>
                  {quickLaneKind === "docker-sbx" ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm">
                        Box name
                        <input
                          className="field min-h-11 font-mono"
                          placeholder="manhwa-render-arm"
                          value={nodeBox}
                          onChange={(event) => setNodeBox(event.target.value)}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        Slots (1–{maxSlotsForKind(quickLaneKind)})
                        <input
                          className="field min-h-11 font-mono"
                          type="number"
                          min={1}
                          max={maxSlotsForKind(quickLaneKind)}
                          value={nodeSlots}
                          onChange={(event) => setNodeSlots(clampSlotsForKind(quickLaneKind, Number(event.target.value) || 1))}
                        />
                      </label>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1 text-sm">
                          Host
                          <input
                            className="field min-h-11 font-mono"
                            placeholder="10.0.0.12"
                            value={nodeHost}
                            onChange={(event) => setNodeHost(event.target.value)}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          User
                          <input
                            className="field min-h-11 font-mono"
                            value={nodeUser}
                            onChange={(event) => setNodeUser(event.target.value)}
                          />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                          Port
                          <input
                            className="field min-h-11 font-mono"
                            type="number"
                            min={1}
                            max={65535}
                            value={nodePort}
                            onChange={(event) => setNodePort(Number(event.target.value) || 22)}
                          />
                        </label>
                      </div>
                      <label className="flex flex-col gap-1 text-sm">
                        Remote dir
                        <input
                          className="field min-h-11 font-mono"
                          value={nodeRemoteDir}
                          onChange={(event) => setNodeRemoteDir(event.target.value)}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        SSH private key (write-only)
                        <textarea
                          className="field min-h-20 py-2 font-mono"
                          value={nodeSshKey}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(event) => setNodeSshKey(event.target.value)}
                        />
                      </label>
                    </div>
                  )}
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="ghost" className="min-h-11" onClick={() => setQuickLaneKind(null)}>
                      Cancel
                    </Button>
                    <Button type="button" className="min-h-11" disabled={savingNode} onClick={() => void saveQuickLane()}>
                      {savingNode ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </div>
              ) : null}
              {laneError ? <p className="text-sm text-[#f0a096]" role="alert">{laneError}</p> : null}
              {laneNote ? <p className="text-sm text-[#a2a19f]" role="status">{laneNote}</p> : null}
              {launchError || routingError ? <p className="text-sm text-[#f0a096]" role="alert">{launchError || routingError}</p> : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="ghost" className="min-h-11" onClick={() => go(2)}>Back</Button>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" className="min-h-11" onClick={() => advance(4)}>
                    Summary
                  </Button>
                  <Button type="button" className="min-h-11" disabled={launching} onClick={() => void finishAndCreateSeries()}>
                    {launching ? "Finishing…" : "Finish & Create Series →"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="flex flex-col gap-5">
              <h2 id="setup-head-4" tabIndex={-1} className="font-serif text-2xl outline-none">
                4. Launch studio
              </h2>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#3d523b] bg-[#1e281f] px-3 py-1.5 font-mono text-xs text-[#aed1a8]">
                  <Check className="size-3.5" /> Admin {tokenState === "verified" || state?.hasAdmin ? "ready" : "missing"}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#3d523b] bg-[#1e281f] px-3 py-1.5 font-mono text-xs text-[#aed1a8]">
                  <Check className="size-3.5" /> {providers.length || state?.providerCount || 0} Providers
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#3d523b] bg-[#1e281f] px-3 py-1.5 font-mono text-xs text-[#aed1a8]">
                  <Check className="size-3.5" /> {nodes.length || state?.nodeCount || 1} Render lanes
                </span>
              </div>
              {launchError || routingError ? <p className="text-sm text-[#f0a096]" role="alert">{launchError || routingError}</p> : null}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="ghost" className="min-h-11" onClick={() => go(3)}>Back</Button>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="outline" className="min-h-11" disabled={launching} onClick={() => void launch()}>
                    {launching ? "Launching…" : "Open Studio"}
                  </Button>
                  <Button type="button" className="min-h-11" disabled={launching} onClick={() => void finishAndCreateSeries()}>
                    {launching ? "Finishing…" : "Finish & Create Series →"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </motion.section>
      </div>
    </main>
  );
}

function formatLatency(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

const SETUP_CSS = `
.field, .token-input {
  min-height: 44px;
  width: 100%;
  border-radius: 10px;
  border: 1px solid #2b2c30;
  background: #101113;
  padding: 0 12px;
  font-size: 16px;
  color: #f2efe9;
  outline: none;
}
textarea.field {
  height: auto;
  min-height: 96px;
  padding: 8px 12px;
}
.field:focus, .token-input:focus { border-color: #f18b6e; }
[data-slot="password-input-field"] {
  min-height: 44px;
  height: auto;
  border-radius: 10px;
  border-color: #2b2c30;
  background: #101113;
}
[data-slot="password-input-field"] input {
  min-height: 44px;
  font-size: 16px;
}
[data-slot="password-input-field"] button {
  min-height: 44px;
  min-width: 44px;
}
.token-box {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: center;
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #2b2c30;
  background: #101113;
  padding: 8px;
}
.token-box.is-error { border-color: #69453e; }
.token-box.is-verified { border-color: #3d523b; }
.token-box.is-shake { animation: field-shake 300ms ease; }
.token-input { border: 0; background: transparent; }
.token-show, .token-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  border-radius: 999px;
  border: 1px solid #2b2c30;
  background: #17181a;
  padding: 0 12px;
  color: #f2efe9;
  font-size: 12px;
}
.token-show { min-width: 44px; }
.token-sheen {
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 20%, rgba(174, 209, 168, 0.35) 50%, transparent 80%);
  animation: token-shimmer 700ms ease;
  pointer-events: none;
}
.preset-tile {
  display: flex;
  min-height: 72px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  border-radius: 12px;
  border: 1px solid #2b2c30;
  background: #101113;
  padding: 10px 12px;
  text-align: left;
  color: #f2efe9;
}
.preset-tile.is-on { border-color: #f18b6e; background: rgba(241, 139, 110, 0.14); }
.test-pill {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid #2b2c30;
  padding: 0 10px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  color: #a2a19f;
  white-space: nowrap;
}
.test-pill.is-ok { border-color: #3d523b; color: #aed1a8; }
.test-pill.is-fail { border-color: #69453e; color: #f0a096; }
.test-pill.is-testing { border-color: #3c3e44; color: #5eead4; }
.font-serif { font-family: Fraunces, Georgia, serif; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@keyframes field-shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); }
  50% { transform: translateX(6px); }
  75% { transform: translateX(-3px); }
}
@keyframes token-shimmer {
  from { transform: translateX(-120%); }
  to { transform: translateX(120%); }
}
@media (min-width: 700px) and (pointer: fine) {
  .field, .token-input, [data-slot="password-input-field"] input { font-size: 14px; }
}
@media (prefers-reduced-motion: reduce) {
  .token-box.is-shake, .token-sheen { animation: none; }
}
`;

export default SetupPage;
