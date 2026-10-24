import { useEffect, useId, useRef, useState } from 'react';
import { api, type ElevenLabsVoiceCheck as VoiceCheckResult } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { errorLine } from '@/lib/errors';
import { ELEVENLABS_VOICE_ID_RE } from '@/lib/tts';
import { cn } from '@/lib/utils';

export const LIBRARY_VOICE_WARNING =
  "This is a Voice Library voice. Free-tier ElevenLabs keys can't use it over the API. Add a paid-tier key or pick a premade voice.";

/** "Check voice" button with an aria-live result region. Read-only lookup, no TTS cost. */
export function ElevenLabsVoiceCheck({ voiceId, disabled = false, className }: { voiceId: string; disabled?: boolean; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VoiceCheckResult | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const hintId = useId();
  const id = voiceId.trim();
  const valid = ELEVENLABS_VOICE_ID_RE.test(id);
  const showHint = Boolean(id) && !valid;

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResult(null);
    setError('');
    setBusy(false);
  }, [id]);

  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null; }, []);

  async function check() {
    if (!valid || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await api.studio.elevenlabs.voiceCheck(id, controller.signal);
      if (abortRef.current === controller && next.voiceId === id) setResult(next);
    } catch (err) {
      if (abortRef.current === controller) setError(errorLine(err));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setBusy(false);
      }
    }
  }

  const blocked = Boolean(result && result.needsPaidKey && !result.paidKeyAvailable);
  return <div className={cn('flex flex-col gap-2', className)}>
    <div>
      <Button type="button" variant="outline" className="min-h-11" disabled={disabled || !valid || busy}
        aria-describedby={showHint ? hintId : undefined} onClick={() => void check()}>
        {busy ? 'Checking…' : 'Check voice'}
      </Button>
      {showHint ? <p id={hintId} className="mt-1 text-xs text-muted-foreground">Voice IDs are 16–40 letters or digits.</p> : null}
    </div>
    <div aria-live="polite" className="text-xs">
      {error ? <p className="rounded-xl bg-destructive-soft px-3 py-2 text-destructive">{error}</p> : null}
      {result ? <div className={cn('rounded-xl px-3 py-2', blocked ? 'bg-warning-soft text-warning' : result.found || result.library ? 'bg-muted text-foreground' : 'bg-destructive-soft text-destructive')}>
        <p>
          {result.found || result.library
            ? <><strong>{result.name || result.voiceId}</strong>{result.category ? ` · ${result.category}` : ''}</>
            : <>Voice {result.voiceId} was not found.</>}
        </p>
        {blocked ? <p className="mt-1">{LIBRARY_VOICE_WARNING}</p> : result.note ? <p className="mt-1 text-muted-foreground">{result.note}</p> : null}
      </div> : null}
    </div>
  </div>;
}
