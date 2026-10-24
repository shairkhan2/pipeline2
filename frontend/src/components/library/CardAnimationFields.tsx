import type { CardAnimation } from '@/lib/api';

const control = 'field mt-1 min-h-11';

const ENTRY_LABELS: Record<NonNullable<CardAnimation['entry']>, string> = {
  none: 'Hard cut', fade: 'Fade in', zoom: 'Zoom in', 'slide-up': 'Slide up', 'slide-left': 'Slide from right',
};
const EXIT_LABELS: Record<NonNullable<CardAnimation['exit']>, string> = {
  none: 'Hard cut', fade: 'Fade out', 'zoom-out': 'Zoom out', 'slide-down': 'Slide down',
};
const PUSH_LABELS: Record<NonNullable<CardAnimation['pushIn']>, string> = {
  off: 'Off', subtle: 'Subtle', normal: 'Normal', strong: 'Strong',
};
export const CARD_ANIMATION_DEFAULTS: Required<CardAnimation> = {
  entry: 'none', exit: 'none', entryS: 0.25, exitS: 0.25, pushIn: 'normal', drift: true,
};

/** Drop keys equal to the defaults so an untouched form stores nothing. */
export function compactCardAnimation(value: CardAnimation): CardAnimation {
  return Object.fromEntries(Object.entries(value).filter(([key, v]) =>
    v !== undefined && v !== CARD_ANIMATION_DEFAULTS[key as keyof CardAnimation])) as CardAnimation;
}

/** Card entry/exit/push-in options for the Window panel motion. */
export function CardAnimationFields({ value, onChange, disabled = false, idPrefix = 'cardAnim', className = 'mt-5' }: {
  value: CardAnimation; onChange: (value: CardAnimation) => void; disabled?: boolean; idPrefix?: string; className?: string;
}) {
  const v = { ...CARD_ANIMATION_DEFAULTS, ...value };
  const set = <K extends keyof CardAnimation>(key: K, next: CardAnimation[K]) => onChange({ ...value, [key]: next });
  const seconds = (raw: string) => {
    const n = Number(raw);
    return raw === '' || !Number.isFinite(n) ? undefined : Math.min(1, Math.max(0, Math.round(n * 100) / 100));
  };
  const helpId = `${idPrefix}Help`;
  return <fieldset disabled={disabled} aria-describedby={helpId} className={`${className} min-w-0 space-y-4 rounded-2xl bg-muted p-4`}>
    <legend className="text-sm font-medium">Card animation</legend>
    <p id={helpId} className="text-xs text-muted-foreground">Window motion only. Applies to chapters rendered after saving.</p>
    <div className="grid gap-4 sm:grid-cols-3">
      <label className="block text-sm">Entry
        <select className={control} value={v.entry} onChange={e => set('entry', e.target.value as CardAnimation['entry'])}>
          {Object.entries(ENTRY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label className="block text-sm">Entry length (s)
        <input type="number" className={control} min={0} max={1} step={0.05} value={v.entryS} disabled={v.entry === 'none'}
          onChange={e => set('entryS', seconds(e.target.value))} />
      </label>
      <label className="block text-sm">Push-in
        <select className={control} value={v.pushIn} onChange={e => set('pushIn', e.target.value as CardAnimation['pushIn'])}>
          {Object.entries(PUSH_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label className="block text-sm">Exit
        <select className={control} value={v.exit} onChange={e => set('exit', e.target.value as CardAnimation['exit'])}>
          {Object.entries(EXIT_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label className="block text-sm">Exit length (s)
        <input type="number" className={control} min={0} max={1} step={0.05} value={v.exitS} disabled={v.exit === 'none'}
          onChange={e => set('exitS', seconds(e.target.value))} />
      </label>
      <label className="flex min-h-11 items-center gap-3 self-end text-sm">
        <input type="checkbox" className="size-5" checked={v.drift} onChange={e => set('drift', e.target.checked)} />
        Zoom toward subject
      </label>
    </div>
  </fieldset>;
}
