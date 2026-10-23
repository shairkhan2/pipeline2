import { useEffect, useState } from "react";

export interface AutoRetry { count: number; max: number; lastFailure: string | null }
export interface AutoRetrySettings { enabled: boolean; maxRetries: number }
export interface StageRetryFields {
  retryAt?: number;
  attempt?: number;
  maxAttempts?: number;
  flagged?: number;
  findings?: number;
}

export function useRetryClock(until = 0): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    setNow(Date.now() / 1000);
    if (until <= Date.now() / 1000) return;
    const timer = globalThis.setInterval(() => {
      const current = Date.now() / 1000;
      setNow(current);
      if (current >= until) globalThis.clearInterval(timer);
    }, 1000);
    return () => globalThis.clearInterval(timer);
  }, [until]);
  return Math.max(now, Date.now() / 1000);
}

export function retryCountdown(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil(until - now));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}
