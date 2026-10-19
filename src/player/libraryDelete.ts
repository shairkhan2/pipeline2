/**
 * Player library-delete bridge.
 *
 * Re-exports the in-process rendered-video deletion contract from
 * `src/locks/seriesLock.ts`, replacing the v1 `player/library-delete.js`
 * `execFile('python3', 'pipeline/series_lock.py', ...)` bridge.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BlockingIOError, LockPathError, checkNoActivePipelineRun, hasActiveLocalRenderScratch,
  pendingKey, resolveChapterVideo, resolveChapterVideoSync, validateChapter, validateSlug,
  withExclusiveSeriesLock,
} from '../locks/seriesLock.js';
import type { DeleteChapterVideoOptions, DeleteChapterVideoFailure, DeleteChapterVideoSuccess as LegacySuccess } from '../locks/seriesLock.js';
import { assertNoSymlinks, moveToTmpTrash } from './storageTrash.js';

export {
  MAX_DELETE_BODY_BYTES,
  validateChapter,
  validateSlug,
  resolveChapterVideo,
  pendingKey,
  VIDEO_REL,
} from '../locks/seriesLock.js';

export type {
  DeleteChapterVideoOptions,
  DeleteChapterVideoFailure,
  ResolvedChapterVideoResult,
} from '../locks/seriesLock.js';

export type DeleteChapterVideoSuccess = LegacySuccess & { trashId: string };
export type DeleteChapterVideoResult = DeleteChapterVideoSuccess | DeleteChapterVideoFailure;
const pending = new Set<string>();

/** Keep deletion's process, flock, inode and scratch guards while retaining the payload. */
export function deleteChapterVideo(options: DeleteChapterVideoOptions): Promise<DeleteChapterVideoResult>;
export function deleteChapterVideo(seriesRoot: string, slug: string, ch: string, options?: DeleteChapterVideoOptions): Promise<DeleteChapterVideoResult>;
export async function deleteChapterVideo(
  rootOrOptions: string | DeleteChapterVideoOptions, slugArg?: string, chArg?: string,
  options: DeleteChapterVideoOptions = {},
): Promise<DeleteChapterVideoResult> {
  const opts = typeof rootOrOptions === 'string' ? { ...options, seriesRoot: rootOrOptions, slug: slugArg, ch: chArg } : rootOrOptions;
  const slug = validateSlug(opts.slug);
  const ch = validateChapter(opts.ch ?? opts.chapter);
  const fail = (status: number, code: string, error: string): DeleteChapterVideoFailure => ({ ok: false, status, code, error });
  if (!slug || !ch) return fail(400, 'invalid_path', 'Series slug or chapter name is invalid.');
  const root = path.resolve(opts.seriesRoot || '');
  const key = pendingKey(slug, ch);
  if (pending.has(key)) return fail(409, 'pending', `A delete for ${slug} ${ch} is already in progress.`);
  pending.add(key);
  try {
    const procRoot = opts.procRoot ?? process.env.MANHWA_PROC_ROOT ?? '/proc';
    const active = checkNoActivePipelineRun(procRoot, slug);
    if (!active.ok) return { ...active, ok: false };
    const before = await resolveChapterVideo(root, slug, ch);
    if (!before.ok) return before;
    return await withExclusiveSeriesLock(path.join(root, slug), { seriesRoot: root, nonblocking: true }, async () => {
      const ready = opts.lockReadyFile ?? opts.readyFile;
      if (ready) fs.writeFileSync(ready, 'locked\n');
      const hold = Number(opts.lockHoldMs ?? opts.holdMs ?? 0);
      if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
      const activeNow = checkNoActivePipelineRun(procRoot, slug);
      if (!activeNow.ok) return { ...activeNow, ok: false as const };
      const current = resolveChapterVideoSync(root, slug, ch);
      if (!current.ok) return current;
      const st = fs.lstatSync(current.path, { bigint: true });
      if (fs.existsSync(`${current.path}.part`) || hasActiveLocalRenderScratch(current.path) ||
        st.dev !== BigInt(opts.expectedDev ?? before.dev) || st.ino !== BigInt(opts.expectedIno ?? before.ino) ||
        st.size !== BigInt(opts.expectedSize ?? before.size) || st.mtimeNs !== BigInt(opts.expectedMtimeNs ?? before.mtimeNs)) {
        return fail(409, 'render_in_progress', `A render for ${slug} ${ch} is still writing or modified video.mp4.`);
      }
      const stamps = [`${current.path}.done`, path.join(path.dirname(current.path), '.done'), path.join(root, slug, 'out', ch, '.done')];
      const reportPath = path.join(root, slug, 'out', ch, 'report.json');
      // Validate all cleanup targets before moving the payload, not after a partial deletion.
      for (const target of [...stamps, reportPath]) {
        assertNoSymlinks(target);
        if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) return fail(400, 'invalid_path', 'Completion metadata must be a regular file.');
      }
      const item = moveToTmpTrash(current.path, { kind: 'chapter-video', slug, chapter: ch, label: `${slug}/${ch}` });
      // Completion stamps cannot survive a removed video. Preserve scripts, audio and panel caches.
      for (const stamp of stamps) {
        fs.rmSync(stamp, { force: true });
      }
      if (fs.existsSync(reportPath)) {
        try {
          const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
          if (report && typeof report === 'object' && !Array.isArray(report)) {
            report.video = false;
            report.videoDeletedAt = item.deletedAt;
            const temp = `${reportPath}.${item.id}.tmp`;
            fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n');
            fs.renameSync(temp, reportPath);
          }
        } catch { /* An unreadable report must not mask a recoverable video deletion. */ }
      }
      return { ok: true as const, status: 200 as const, slug, ch, trashId: item.id, freedBytes: current.size,
        deleted: [current.rel], message: `Moved the rendered video for ${slug} ${ch} to temporary trash. Source chapters, images and caches were not touched.` };
    });
  } catch (err) {
    if (err instanceof LockPathError) return fail(err.status, err.code, err.message);
    if (err instanceof BlockingIOError) return fail(409, 'pipeline_active', `The pipeline is writing ${slug} right now.`);
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fail(404, 'not_found', 'No rendered video found.');
    return fail(500, 'delete_failed', 'Could not move the rendered video to temporary trash.');
  } finally { pending.delete(key); }
}
