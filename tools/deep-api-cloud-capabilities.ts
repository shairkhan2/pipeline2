/**
 * Optional read-only capability check for host and container deployment.
 *
 * Run explicitly:
 *   npx tsx tools/deep-api-cloud-capabilities.ts
 *
 * Never runs during `npm test` (so CI without `sbx` or Podman stays 100% offline).
 * Never prints secrets or starts/resumes/creates/pauses any cloud resource.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as statusProbe from '../src/telemetry/statusProbe.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkBinary(name: string): string {
  const res = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', timeout: 5000 });
  return res.status === 0 ? res.stdout.trim() : 'missing';
}

export function runCapabilityCheck(): Record<string, unknown> {
  const sbxPath = checkBinary('sbx');
  const podmanPath = checkBinary('podman');
  const ffprobePath = checkBinary('ffprobe');
  const ffmpegPath = checkBinary('ffmpeg');
  const flockPath = checkBinary('flock');
  const edgeTtsPath = checkBinary('edge-tts');

  let sbxCloudListError: string | null = null;
  let sbxCloudAccessible = false;
  if (sbxPath !== 'missing') {
    const [box, err] = statusProbe.listNamedSandbox('__readonly_capability_probe__', 6);
    sbxCloudAccessible = err === 'sandbox not found' || box !== null;
    sbxCloudListError = err;
  } else {
    sbxCloudListError = 'sbx binary not installed';
  }

  let backendContainerCheck: Record<string, string> | null = null;
  if (podmanPath !== 'missing') {
    const imgCheck = spawnSync('podman', ['image', 'exists', 'pipeline-v2-backend:local'], {
      timeout: 5000,
    });
    if (imgCheck.status === 0) {
      const probe = spawnSync(
        'podman',
        [
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          'pipeline-v2-backend:local',
          '-c',
          [
            'printf "sbx=%s\\n" "$(command -v sbx || echo missing)"',
            'printf "ffprobe=%s\\n" "$(command -v ffprobe || echo missing)"',
            'printf "flock=%s\\n" "$(command -v flock || echo missing)"',
            'printf "chromium=%s\\n" "$(command -v chromium || echo missing)"',
            'printf "edge_tts_on_path=%s\\n" "$(command -v edge-tts || echo missing)"',
            'printf "edge_tts_python=%s\\n" "${EDGE_TTS_PYTHON:-unset}"',
          ].join('; '),
        ],
        { encoding: 'utf8', timeout: 15000 },
      );
      if (probe.status === 0) {
        backendContainerCheck = Object.fromEntries(
          probe.stdout
            .trim()
            .split('\n')
            .map((line) => line.split('=') as [string, string]),
        );
      }
    }
  }

  const summary = {
    host: {
      sbx: sbxPath,
      sbxCloudAccessible,
      sbxCloudListStatus: sbxCloudListError,
      podman: podmanPath,
      ffprobe: ffprobePath,
      ffmpeg: ffmpegPath,
      flock: flockPath,
      edgeTtsOnPath: edgeTtsPath,
      envShPresent: fs.existsSync(path.join(REPO_ROOT, 'env.sh')),
      manhwaRenderCloudConfigured: Boolean((process.env.MANHWA_RENDER_CLOUD || '').trim()),
      manhwaRenderRemoteConfigured: Boolean((process.env.MANHWA_RENDER_REMOTE || '').trim()),
    },
    backendImage: backendContainerCheck,
    cloudPreflightReady:
      sbxCloudAccessible && Boolean((process.env.MANHWA_RENDER_CLOUD || '').trim()),
    // Read-only capability harness never resumes, syncs, or renders on a live cloud sandbox;
    // preflight accessibility + env configuration never constitutes end-to-end live render proof.
    cloudProvenEndToEndLive: false,
  };
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(runCapabilityCheck(), null, 2));
}
