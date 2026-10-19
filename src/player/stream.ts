import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

// Stream a file with HTTP Range support (required for video seeking).
/** Stream media with bounded ranges and explicit disconnect/error ownership. */
export async function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  contentType: string,
): Promise<void> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const size = info.size;
  let start = 0;
  let end = size - 1;
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      start = NaN;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
  }
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', range ? end - start + 1 : size);
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.statusCode = range ? 206 : 200;
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const source = createReadStream(filePath, range ? { start, end } : undefined);
  const close = () => source.destroy();
  res.once('close', close);
  source.once('close', () => res.off('close', close));
  source.once('error', (error: NodeJS.ErrnoException) => {
    if (res.headersSent) {
      res.destroy(error);
    } else {
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Range');
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(error.code === 'ENOENT' ? 'not found' : 'stream unavailable');
    }
  });
  source.pipe(res);
}
