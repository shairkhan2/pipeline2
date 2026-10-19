/**
 * Player status bridge.
 *
 * Re-exports the in-process status collector so `server.ts` answers `/api/status`
 * by calling TypeScript directly, with zero `python3` subprocesses.
 *
 * Ported from `player/status.js` (which spawned `player/status_probe.py` via
 * `execFile`). The actual probe lives in `src/telemetry/statusProbe.ts`.
 */
export {
  sampleRates,
  pipelineStatus,
  _resetStatusCache,
} from '../telemetry/statusProbe.js';
export type { Run as StatusSnapshot, CollectOptions } from '../telemetry/statusProbe.js';
