import { useEffect, useState, type FormEvent } from 'react';
import { api, type IntakeCatalog, type SeriesSettings, type SeriesSettingsPatch } from '@/lib/api';
import { StyleFields, type EditableTtsStyle } from './StyleFields';
import { CardAnimationFields, compactCardAnimation } from './CardAnimationFields';
import { Button } from '@/components/ui/button';
import { ErrorNotice, Notice } from '@/components/ui/notice';
import { describeError, type ErrorInfo } from '@/lib/errors';
import { Tooltip } from '@/components/ui/tooltip';
import { Info } from 'lucide-react';

const VISUAL_LABELS: Record<string, string> = {
  window: 'Window', cut: 'Cut', duo: 'Duo',
  starfield: 'Starfield', 'storm-valley': 'Storm Valley', 'mist-pines': 'Mist Pines',
};

export function SeriesSettingsEditor({ slug, privileged }: { slug: string; privileged: boolean }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<(Omit<SeriesSettings, 'tts'> & { tts: EditableTtsStyle & { engine?: string } }) | null>(null);
  const [catalog, setCatalog] = useState<IntakeCatalog | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setNotice(''); setCatalog(null);
    if (!open) return;
    let active = true;
    setSettings(null); setError(null);
    Promise.all([api.series.getSettings(slug), api.intake.catalog()]).then(([value, cat]) => {
      if (active) { setSettings(value); setCatalog(cat); }
    }).catch(err => { if (active) setError(describeError(err)); });
    return () => { active = false; };
  }, [slug, open]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setError(null); setNotice('');
    const patch: SeriesSettingsPatch = {
      style: Object.fromEntries(Object.keys(settings.styleOptions ?? {}).map(key => [key, settings.style[key as keyof typeof settings.style] ?? null])),
      tts: Object.fromEntries(['voice_id', 'speed', 'style', 'language'].map(key => [key, settings.tts[key as keyof typeof settings.tts] ?? null])),
      visuals: (() => {
        const animation = compactCardAnimation(settings.visuals.animation ?? {});
        return { ...settings.visuals, animation: Object.keys(animation).length ? animation : null };
      })(),
    };
    try { setSettings(await api.series.patchSettings(slug, patch)); setNotice('Settings saved.'); }
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
        <StyleFields catalog={catalog} style={settings.style} tts={settings.tts} onStyle={style => setSettings({ ...settings, style })} onTts={tts => setSettings({ ...settings, tts })} disabled={!privileged || busy} />
        <fieldset disabled={!privileged || busy} className="grid gap-4 sm:grid-cols-3">
          <label className="text-sm">Voice ID
            <input className="field mt-1 min-h-11" value={settings.tts.voice_id ?? ''} placeholder="Default" onChange={e => setSettings({ ...settings, tts: { ...settings.tts, voice_id: e.target.value || undefined } })} />
          </label>
          {(['background', 'motion'] as const).map(key => <label key={key} className="text-sm">{key === 'background' ? 'Background' : 'Panel motion'}
            <select disabled={!catalog} className="field mt-1 min-h-11" value={settings.visuals[key] ?? (key === 'background' ? catalog?.defaultBackground : catalog?.defaultMotion) ?? ''} onChange={e => setSettings({ ...settings, visuals: { ...settings.visuals, [key]: e.target.value } })}>
              {settings.visuals[key] && !(key === 'background' ? catalog?.backgrounds : catalog?.motions)?.includes(settings.visuals[key]!) ? <option value={settings.visuals[key]!}>{settings.visuals[key]}</option> : null}
              {(key === 'background' ? catalog?.backgrounds : catalog?.motions)?.map(value => <option key={value} value={value}>{VISUAL_LABELS[value] ?? value}</option>)}
            </select>
          </label>)}
        </fieldset>
        <CardAnimationFields className="" idPrefix={`cardAnim-${slug}`} value={settings.visuals.animation ?? {}} disabled={!privileged || busy}
          onChange={animation => setSettings({ ...settings, visuals: { ...settings.visuals, animation } })} />
        <Button type="submit" disabled={!privileged || busy}>{busy ? 'Saving…' : 'Save settings'}</Button>
      </> : null}
    </form> : null}
  </section>;
}
