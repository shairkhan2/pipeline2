import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ui/notice";
import { Tooltip } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { describeError, type ErrorInfo } from "@/lib/errors";
import { isPaidTtsProvider, type TtsProviderGroup, type TtsVoiceItem } from "@/lib/tts";

function fmtAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function VoicePreview({
  provider,
  voice,
  privileged,
  model,
}: {
  provider: TtsProviderGroup | null;
  voice: TtsVoiceItem | null;
  privileged: boolean;
  model?: string;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState<string | ErrorInfo>("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [spendOk, setSpendOk] = useState(false);
  const gen = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const paid = isPaidTtsProvider(provider);
  const blocked = !privileged || Boolean(provider && !provider.available);

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
  }, [provider?.id, voice?.id, model]);

  useEffect(() => {
    const onHide = () => {
      if (!document.hidden) return;
      gen.current += 1;
      abortRef.current?.abort();
      audioRef.current?.pause();
      setBusy(false);
      setPlaying(false);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      gen.current += 1;
      abortRef.current?.abort();
    };
  }, []);

  async function listen() {
    if (!provider || !voice || busy) return;
    if (!privileged) return;
    if (!provider.available) {
      setError(`${provider.label} is unavailable: ${provider.unavailableReason || "not configured"}`);
      return;
    }
    if (paid && !spendOk) {
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
      const preview = await api.intake.preview(provider.id, voice.id, controller.signal, model);
      if (token !== gen.current) return;
      setSrc(preview.audioUrl);
      window.setTimeout(() => {
        if (token !== gen.current) return;
        void audioRef.current?.play().catch(() => undefined);
      }, 40);
    } catch (err) {
      if (token !== gen.current) return;
      setError(describeError(err));
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
    <section
      className="mt-3 rounded-xl bg-background p-3"
      aria-label="Voice sample player"
      data-playing={playing ? "" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant={playing ? "outline" : "default"}
            className="min-h-11"
            disabled={blocked || busy || (paid && !spendOk)}
            onClick={() => (playing ? stop() : void listen())}
          >
            {busy ? "Generating…" : playing ? "Stop" : "Listen sample"}
          </Button>
          {paid ? (
            <label className="flex min-h-11 items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={spendOk}
                onChange={(event) => {
                  setSpendOk(event.target.checked);
                  if (event.target.checked) setError("");
                }}
              />
              <span>
                Allow paid preview
              </span>
            </label>
          ) : (
            <Tooltip side="top" label={
              !privileged
                ? "Temporary accounts cannot generate previews."
                : provider && !provider.available
                  ? `Preview unavailable (${provider.unavailableReason || "not configured"}).`
                  : provider?.costNotice || "Free Edge TTS narration"
            }><button type="button" aria-label="Preview information" className="grid size-11 place-items-center text-muted-foreground"><Info className="size-[18px]" strokeWidth={1.75} aria-hidden /></button></Tooltip>
          )}
        </div>
        {src ? (
          <div className="flex min-w-[220px] flex-1 items-center justify-end gap-2">
            <audio
              ref={audioRef}
              src={src}
              controls
              preload="metadata"
              className="h-9 max-w-xs flex-1"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
            />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {fmtAudioTime(currentTime)} / {fmtAudioTime(duration)}
            </span>
          </div>
        ) : null}
      </div>
      {error ? <ErrorNotice className="mt-2" info={typeof error === "string" ? describeError(error) : error} onRetry={() => void listen()} /> : null}
    </section>
  );
}
