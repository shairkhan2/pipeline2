import { useEffect, useState, type FormEvent } from 'react';
import { api, type OutroHookType, type StudioSettingsState } from '@/lib/api';
import { errorLine } from '@/lib/errors';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';

type DefaultOutro = { enabled: boolean; hookType: OutroHookType; customNote: string };

function readDefault(settings: StudioSettingsState | null): DefaultOutro {
  const value = settings?.defaultOutro ?? settings?.settings?.defaultOutro;
  return { enabled: value?.enabled ?? false, hookType: value?.hookType ?? 'part2', customNote: value?.customNote ?? '' };
}

/** Shared default outro form, shown inline in Settings. */
export function DefaultOutroSettings({ settings, privileged, onSaved }: {
  settings: StudioSettingsState | null; privileged: boolean; onSaved: (value: StudioSettingsState) => void;
}) {
  const [draft, setDraft] = useState(() => readDefault(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const saved = readDefault(settings);
  const revision = settings?.revision;
  const hasRevision = typeof revision === 'number' && Number.isFinite(revision);
  useEffect(() => setDraft({ enabled: saved.enabled, hookType: saved.hookType, customNote: saved.customNote }), [saved.enabled, saved.hookType, saved.customNote]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!privileged || busy || typeof revision !== 'number' || !Number.isFinite(revision)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      onSaved(await api.studio.putSettings({ defaultOutro: draft, expectedRevision: revision }));
      setNotice('Default outro saved.');
    } catch (err) { setError(errorLine(err, 'Could not save default outro.')); }
    finally { setBusy(false); }
  }

  return <section className="mb-5" aria-label="Default outro">
    {notice ? <Notice tone="success" className="mt-2" onDismiss={() => setNotice('')}>{notice}</Notice> : null}

        <form id="defaultOutroForm" onSubmit={save} className="space-y-4">
          <fieldset disabled={!privileged || busy || !hasRevision} className="space-y-4">
            <label className="sr-group sr-row cursor-pointer justify-between text-[15px]">
              Add outro
              <input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />
            </label>
            <label className="studio-field-label">Hook type
              <select className="field" value={draft.hookType} onChange={e => setDraft({ ...draft, hookType: e.target.value as OutroHookType })}>
                <option value="part2">Part 2</option><option value="next_chapter">Next chapter</option><option value="new_series">New series</option><option value="custom">Custom</option>
              </select>
            </label>
            <label className="studio-field-label">Custom note
              <textarea className="field" rows={3} placeholder="Optional" value={draft.customNote} onChange={e => setDraft({ ...draft, customNote: e.target.value })} />
            </label>
          </fieldset>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {!privileged ? <Notice tone="info">Viewer accounts can’t change this.</Notice> : null}
          <Button type="submit" disabled={!privileged || busy || !hasRevision}>{busy ? 'Saving…' : 'Save default outro'}</Button>
        </form>
  </section>;
}
