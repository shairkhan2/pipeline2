import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { api, type IntakeCatalog, type SeriesSettings, type SeriesSettingsPatch } from '@/lib/api';
import { StyleFields, type EditableTtsStyle } from './StyleFields';
import { CardAnimationFields, compactCardAnimation } from './CardAnimationFields';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Notice } from '@/components/ui/notice';
import { describeError, type ErrorInfo } from '@/lib/errors';
import { Tooltip } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';
import { ElevenLabsVoiceCheck } from './ElevenLabsVoiceCheck';
import { VoicePreview } from '@/components/shared/VoicePreview';
import { buildTtsProviders, ELEVENLABS_VOICE_ID_RE, isElevenLabsProvider, parseSynthModels, type TtsProviderGroup, type TtsVoiceItem } from '@/lib/tts';

const VISUAL_LABELS: Record<string, string> = {
  window: 'Window', cut: 'Cut', duo: 'Duo',
  starfield: 'Starfield', 'storm-valley': 'Storm Valley', 'mist-pines': 'Mist Pines',
};
const CUSTOM_VOICE = '__custom_voice__';

type EditableSettings = Omit<SeriesSettings, 'tts'> & { tts: EditableTtsStyle & { engine?: string } };
export interface NarrationDraft { provider: string; voice: string; model: string; custom: boolean }

function normalizeProviderId(id: string | null | undefined): string {
  const value = String(id ?? '').trim();
  return value.toLowerCase() === 'vertex-ai' ? 'vertex' : value;
}

function narrationFrom(settings: Pick<SeriesSettings, 'narration'> | null): NarrationDraft {
  const n = settings?.narration;
  return { provider: normalizeProviderId(n?.provider), voice: String(n?.voice ?? ''), model: String(n?.model ?? ''), custom: false };
}

/** Loads Series settings and the intake catalog while `active`, and builds the PATCH body. */
export function useSeriesSettingsDraft(slug: string, active: boolean) {
  const [settings, setSettingsState] = useState<EditableSettings | null>(null);
  const [catalog, setCatalog] = useState<IntakeCatalog | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [narration, setNarration] = useState<NarrationDraft>(() => narrationFrom(null));
  const [baseline, setBaseline] = useState('');
  useEffect(() => {
    setCatalog(null);
    if (!active || !slug) return;
    let activeLoad = true;
    setSettingsState(null); setError(null);
    Promise.all([api.series.getSettings(slug), api.intake.catalog()]).then(([value, cat]) => {
      if (!activeLoad) return;
      setSettingsState(value); setCatalog(cat); setNarration(narrationFrom(value));
      setBaseline(JSON.stringify(basePatch(value)));
    }).catch(err => { if (activeLoad) setError(describeError(err)); });
    return () => { activeLoad = false; };
  }, [slug, active]);

  const providers = useMemo(() => buildTtsProviders(catalog), [catalog]);
  const initialNarration = useMemo(() => narrationFrom(settings), [settings]);
  const hasNarration = Boolean(settings?.narration);
  const narrationProvider = providers.find(p => p.id === narration.provider) ?? null;
  const narrationIsEleven = isElevenLabsProvider(narrationProvider) || (!narrationProvider && /eleven/i.test(narration.provider));
  const narrationChanged = hasNarration && Boolean(narration.provider) && (
    narration.provider !== initialNarration.provider
    || narration.voice.trim() !== initialNarration.voice
    || (narrationIsEleven && narration.model !== initialNarration.model)
  );

  function basePatch(value: EditableSettings, omitVoice = false): SeriesSettingsPatch {
    const isEleven = value.ttsEngine === 'elevenlabs';
    const ttsKeys = omitVoice ? ['speed', 'style', 'language'] : ['voice_id', 'speed', 'style', 'language', ...(isEleven ? ['model_id'] : [])];
    return {
      style: Object.fromEntries(Object.keys(value.styleOptions ?? {}).map(key => [key, value.style[key as keyof typeof value.style] ?? null])),
      tts: Object.fromEntries(ttsKeys.map(key => [key, value.tts[key as keyof typeof value.tts] ?? null])),
      visuals: (() => {
        const animation = compactCardAnimation(value.visuals.animation ?? {});
        return { ...value.visuals, animation: Object.keys(animation).length ? animation : null };
      })(),
    };
  }

  /** The PATCH body, or a message when the narration choice is incomplete. `narration` is sent only when it changed. */
  function buildPatch(): { patch: SeriesSettingsPatch } | { invalid: string } {
    if (!settings) return { invalid: 'Settings are still loading.' };
    if (!narrationChanged) return { patch: basePatch(settings) };
    const voice = narration.voice.trim();
    if (!voice) return { invalid: 'Choose a narrator voice.' };
    if (narrationIsEleven && narration.custom && !ELEVENLABS_VOICE_ID_RE.test(voice)) return { invalid: 'Enter a valid ElevenLabs voice ID: 16 to 40 letters or digits.' };
    return { patch: { ...basePatch(settings, true), narration: { provider: narration.provider, voice, model: narrationIsEleven ? narration.model || null : null } } };
  }

  /** True when saving would change something compared with what was loaded. */
  const dirty = Boolean(settings) && (narrationChanged || JSON.stringify(basePatch(settings!)) !== baseline);

  function applySaved(value: SeriesSettings) {
    setSettingsState(value); setNarration(narrationFrom(value)); setBaseline(JSON.stringify(basePatch(value)));
  }

  async function save(): Promise<SeriesSettings> {
    const built = buildPatch();
    if ('invalid' in built) throw new Error(built.invalid);
    const saved = await api.series.patchSettings(slug, built.patch);
    applySaved(saved);
    return saved;
  }

  return {
    slug, settings, setSettings: setSettingsState, catalog, error, setError, providers,
    narration, setNarration, initialNarration, hasNarration, narrationChanged, dirty, buildPatch, save,
  };
}

export type SeriesSettingsDraft = ReturnType<typeof useSeriesSettingsDraft>;

function NarrationFields({ draft, disabled, privileged }: { draft: SeriesSettingsDraft; disabled: boolean; privileged: boolean }) {
  const base = useId();
  const { settings, providers, narration, setNarration, initialNarration } = draft;
  const locked = settings?.narrationLocked || '';
  const provider: TtsProviderGroup | null = providers.find(p => p.id === narration.provider) ?? null;
  const isEleven = isElevenLabsProvider(provider);
  const synthModels = isEleven ? provider?.synthModels ?? [] : [];
  const voiceKnown = Boolean(provider?.voices.some(v => v.id === narration.voice));
  const showCustom = isEleven && (narration.custom || (Boolean(narration.voice) && !voiceKnown));
  const customValid = ELEVENLABS_VOICE_ID_RE.test(narration.voice.trim());
  const listVoice = provider?.voices.find(v => v.id === narration.voice) ?? null;
  const previewVoice: TtsVoiceItem | null = listVoice ?? (narration.voice.trim() && (!isEleven || customValid)
    ? { id: narration.voice.trim(), label: narration.voice.trim(), rawLabel: narration.voice.trim(), modelId: 'default', modelLabel: 'Default', default: false }
    : null);
  const off = disabled || Boolean(locked);
  const ids = { provider: `${base}-provider`, voice: `${base}-voice`, model: `${base}-model`, custom: `${base}-custom`, customHint: `${base}-customHint`, note: `${base}-note`, lock: `${base}-lock` };

  function chooseProvider(id: string) {
    const next = providers.find(p => p.id === id);
    const keep = id === initialNarration.provider;
    const voice = keep ? initialNarration.voice : (next?.voices.find(v => v.default) ?? next?.voices[0])?.id ?? '';
    setNarration({ provider: id, voice, model: keep ? initialNarration.model : '', custom: false });
  }

  return <fieldset disabled={off} className="min-w-0 space-y-3 rounded-2xl bg-muted p-4" aria-describedby={locked ? `${ids.lock} ${ids.note}` : ids.note}>
    <legend className="text-sm font-medium">Narration</legend>
    {locked ? <p id={ids.lock} role="status" className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">{locked}</p> : null}
    <div className={`grid gap-4 ${synthModels.length ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      <label className="block text-sm" htmlFor={ids.provider}>Provider
        <select id={ids.provider} className="field mt-1 min-h-11" value={narration.provider} onChange={e => chooseProvider(e.target.value)}>
          {!narration.provider ? <option value="">Not set</option> : null}
          {narration.provider && !provider ? <option value={narration.provider}>{narration.provider}</option> : null}
          {providers.map(item => <option key={item.id} value={item.id} disabled={!item.available || item.voices.length === 0}>
            {item.label}{item.available ? '' : ' (Unavailable)'}
          </option>)}
        </select>
      </label>
      <label className="block text-sm" htmlFor={ids.voice}>Narrator voice
        <select id={ids.voice} className="field mt-1 min-h-11" value={showCustom ? CUSTOM_VOICE : narration.voice} disabled={!provider && !narration.voice}
          onChange={e => {
            if (e.target.value === CUSTOM_VOICE) { setNarration({ ...narration, custom: true, voice: voiceKnown ? '' : narration.voice }); return; }
            setNarration({ ...narration, custom: false, voice: e.target.value });
          }}>
          {!narration.voice && !showCustom ? <option value="">Choose a voice</option> : null}
          {narration.voice && !voiceKnown && !isEleven ? <option value={narration.voice}>{narration.voice}</option> : null}
          {provider?.hasExplicitModels
            ? provider.models.map(group => <optgroup key={group.id} label={group.label}>
              {group.voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </optgroup>)
            : provider?.voices.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
          {isEleven ? <option value={CUSTOM_VOICE}>Custom voice ID…</option> : null}
        </select>
      </label>
      {synthModels.length ? <label className="block text-sm" htmlFor={ids.model}>ElevenLabs model
        <select id={ids.model} className="field mt-1 min-h-11" value={narration.model} onChange={e => setNarration({ ...narration, model: e.target.value })}>
          <option value="">Default{provider?.defaultSynthModel ? ` (${synthModels.find(m => m.id === provider.defaultSynthModel)?.label ?? provider.defaultSynthModel})` : ''}</option>
          {narration.model && !synthModels.some(m => m.id === narration.model) ? <option value={narration.model}>{narration.model}</option> : null}
          {synthModels.map(m => <option key={m.id} value={m.id}>{m.label}{m.tags ? ' · audio tags' : ''}</option>)}
        </select>
      </label> : null}
    </div>
    {showCustom ? <label className="block text-sm" htmlFor={ids.custom}>Custom voice ID
      <input id={ids.custom} className="field mt-1 min-h-11 font-mono" value={narration.voice} spellCheck={false} autoComplete="off" placeholder="e.g. JBFqnCBsd6RMkjVDRZzb"
        aria-invalid={narration.voice.trim() && !customValid ? true : undefined} aria-describedby={ids.customHint}
        onChange={e => setNarration({ ...narration, custom: true, voice: e.target.value })} />
      <span id={ids.customHint} className={`mt-1 block text-xs ${narration.voice.trim() && !customValid ? 'text-destructive' : 'text-muted-foreground'}`}>
        {narration.voice.trim() && !customValid ? 'Use 16 to 40 letters or digits.' : 'Paste the voice ID from ElevenLabs.'}
      </span>
    </label> : null}
    {isEleven && narration.voice ? <ElevenLabsVoiceCheck voiceId={narration.voice} disabled={off || !provider?.available} /> : null}
    <VoicePreview provider={provider} voice={previewVoice} privileged={privileged && !off} model={isEleven ? narration.model || provider?.defaultSynthModel || undefined : undefined} />
    <p id={ids.note} className="text-xs text-muted-foreground">Applies to chapters that are not rendered yet. Existing scripts are reused.</p>
  </fieldset>;
}

/** The Series settings form body, shared by the Library editor and the Change settings dialog. */
export function SeriesSettingsFields({ draft, privileged, disabled = false, idPrefix }: {
  draft: SeriesSettingsDraft; privileged: boolean; disabled?: boolean; idPrefix?: string;
}) {
  const { settings, setSettings, catalog } = draft;
  if (!settings) return null;
  const off = !privileged || disabled;
  const isEleven = settings.ttsEngine === 'elevenlabs';
  // While a run holds the series, narration is locked but the same-engine voice ID edit stays available as before.
  const legacyVoice = !draft.hasNarration || Boolean(settings.narrationLocked);
  const elevenEntry = catalog?.providers?.find(p => p && (p.id === 'elevenlabs' || p.engine === 'elevenlabs'));
  const synthModels = parseSynthModels(elevenEntry?.models);
  const defaultModel = typeof elevenEntry?.defaultModel === 'string' ? elevenEntry.defaultModel : '';
  return <>
    <StyleFields catalog={catalog} style={settings.style} tts={settings.tts} onStyle={style => setSettings({ ...settings, style })} onTts={tts => setSettings({ ...settings, tts })} disabled={off} />
    {draft.hasNarration ? <NarrationFields draft={draft} disabled={off} privileged={privileged} /> : null}
    <fieldset disabled={off} className={`grid gap-4 ${legacyVoice ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
      {legacyVoice ? <div className="text-sm">
        <label className="block">Voice ID
          <input className={`field mt-1 min-h-11${isEleven ? ' font-mono' : ''}`} value={settings.tts.voice_id ?? ''} placeholder="Default" spellCheck={isEleven ? false : undefined}
            onChange={e => setSettings({ ...settings, tts: { ...settings.tts, voice_id: e.target.value || undefined } })} />
        </label>
        {isEleven ? <ElevenLabsVoiceCheck className="mt-2" voiceId={settings.tts.voice_id ?? ''} disabled={disabled} /> : null}
      </div> : null}
      {legacyVoice && isEleven ? <label className="text-sm">ElevenLabs model
        <select className="field mt-1 min-h-11" value={settings.tts.model_id ?? ''} onChange={e => setSettings({ ...settings, tts: { ...settings.tts, model_id: e.target.value || undefined } })}>
          <option value="">Default{defaultModel ? ` (${synthModels.find(m => m.id === defaultModel)?.label ?? defaultModel})` : ''}</option>
          {settings.tts.model_id && !synthModels.some(m => m.id === settings.tts.model_id) ? <option value={settings.tts.model_id}>{settings.tts.model_id}</option> : null}
          {synthModels.map(m => <option key={m.id} value={m.id}>{m.label}{m.tags ? ' · audio tags' : ''}</option>)}
        </select>
      </label> : null}
      {(['background', 'motion'] as const).map(key => <label key={key} className="text-sm">{key === 'background' ? 'Background' : 'Panel motion'}
        <select disabled={!catalog} className="field mt-1 min-h-11" value={settings.visuals[key] ?? (key === 'background' ? catalog?.defaultBackground : catalog?.defaultMotion) ?? ''} onChange={e => setSettings({ ...settings, visuals: { ...settings.visuals, [key]: e.target.value } })}>
          {settings.visuals[key] && !(key === 'background' ? catalog?.backgrounds : catalog?.motions)?.includes(settings.visuals[key]!) ? <option value={settings.visuals[key]!}>{settings.visuals[key]}</option> : null}
          {(key === 'background' ? catalog?.backgrounds : catalog?.motions)?.map(value => <option key={value} value={value}>{VISUAL_LABELS[value] ?? value}</option>)}
        </select>
      </label>)}
    </fieldset>
    <CardAnimationFields className="" idPrefix={idPrefix ?? `cardAnim-${draft.slug}`} value={settings.visuals.animation ?? {}} disabled={off}
      onChange={animation => setSettings({ ...settings, visuals: { ...settings.visuals, animation } })} />
  </>;
}

export function SeriesSettingsEditor({ slug, privileged }: { slug: string; privileged: boolean }) {
  const [open, setOpen] = useState(false);
  const draft = useSeriesSettingsDraft(slug, open);
  const { settings, error, setError } = draft;
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setNotice(''); }, [slug, open]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setError(null); setNotice('');
    try { await draft.save(); setNotice('Settings saved.'); }
    catch (err) { setError(describeError(err)); }
    finally { setBusy(false); }
  }
  return <section className="sr-group p-4 [&_[role=alert]_button]:min-h-11 md:p-5">
    <Button type="button" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>Series settings</Button>
    {open ? <form onSubmit={save} className="mt-3 space-y-4">
      <Tooltip label="Applies to future chapters. Existing videos stay unchanged." side="top"><button type="button" className="grid size-11 place-items-center text-muted-foreground" aria-label="Settings information"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
      {error ? <ErrorNotice info={error} /> : null}
      {notice ? <Notice tone="success" title={notice} /> : null}
      {!settings && !error ? <p role="status">Loading settings…</p> : null}
      {settings ? <>
        <SeriesSettingsFields draft={draft} privileged={privileged} disabled={busy} />
        <Button type="submit" disabled={!privileged || busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
      </> : null}
    </form> : null}
  </section>;
}
