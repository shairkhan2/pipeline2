import type { IntakeCatalog, SeriesStyle, TtsStyle } from '@/lib/api';

export type EditableTtsStyle = Omit<TtsStyle, 'speed'> & { speed?: number | null };

const labels: Record<keyof SeriesStyle, string> = {
  writerMode: 'Writer mode', storyShape: 'Story shape', matchMode: 'Panel matching', emotionTags: 'Emotion tags', pacing: 'Pacing',
};
const control = 'field mt-1 min-h-11';

export function StyleFields({ catalog, style, tts, onStyle, onTts, disabled = false }: {
  catalog: IntakeCatalog | null; style: SeriesStyle; tts: EditableTtsStyle;
  onStyle: (value: SeriesStyle) => void; onTts: (value: EditableTtsStyle) => void; disabled?: boolean;
}) {
  return <fieldset disabled={disabled} className="mt-5 min-w-0 space-y-4 rounded-2xl bg-muted p-4">
    <legend className="text-sm font-medium">Story &amp; pacing</legend>
    <div className="grid gap-4 sm:grid-cols-2">
      {(Object.keys(catalog?.styleOptions ?? {}) as Array<keyof SeriesStyle>).map(key => {
        const options = catalog?.styleOptions?.[key] ?? [];
        return <label key={key} className="block text-sm">{labels[key]}
          <select className={control} value={style[key] ?? ''} onChange={e => {
            const next = { ...style }; if (e.target.value) next[key] = e.target.value; else delete next[key]; onStyle(next);
          }}>
            <option value="">Default</option>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>;
      })}
    </div>
    <div className="grid gap-4 sm:grid-cols-3">
      <label className="block text-sm">Voice speed
        <input type="number" className={control} value={tts.speed ?? ''} min={catalog?.ttsOptions?.speed.min} max={catalog?.ttsOptions?.speed.max} step={catalog?.ttsOptions?.speed.step ?? 'any'} placeholder="Default" onChange={e => {
          if (e.target.value === '') { onTts({ ...tts, speed: null }); return; }
          const value = Number(e.target.value);
          if (!Number.isFinite(value)) return;
          const min = catalog?.ttsOptions?.speed.min;
          const max = catalog?.ttsOptions?.speed.max;
          onTts({ ...tts, speed: Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value)) });
        }} />
      </label>
      <label className="block text-sm">Voice style
        <input className={control} value={tts.style ?? ''} placeholder="Default" onChange={e => onTts({ ...tts, style: e.target.value || undefined })} />
      </label>
      <label className="block text-sm">Voice language
        <input className={control} value={tts.language ?? ''} placeholder="Default" onChange={e => onTts({ ...tts, language: e.target.value || undefined })} />
      </label>
    </div>
  </fieldset>;
}
