import { spawn } from 'node:child_process';
import { config } from './config.js';
import { log } from './log.js';

const MAX_BYTES = 2 * 1024 * 1024;
function crop(buffer, x, y) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', 'pipe:0',
      '-vf', `crop=iw*0.6:ih*0.6:iw*${x}:ih*${y},scale=1024:1024:force_original_aspect_ratio=decrease`,
      '-frames:v', '1', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '2', 'pipe:1'],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const chunks = []; let size = 0, failed = false;
    const fail = () => { failed = true; child.kill('SIGKILL'); };
    const timer = setTimeout(fail, 5000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) fail(); else chunks.push(chunk); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0 || !size) reject(new Error('Photo crop unavailable'));
      else resolve({ mime: 'image/jpeg', buffer: Buffer.concat(chunks) });
    });
    child.stdin.end(buffer);
  });
}

// Original plus overlapping quarters: small print stays readable, lines crossing
// a boundary remain visible elsewhere. Only bounded in-memory copies, no files.
export async function photoDetailImages(image, render = crop) {
  if (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 4096) return [];
  const result = [];
  try {
    for (const [x, y] of [[0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4]]) result.push(await render(image.buffer, x, y));
    return result;
  } catch {
    log('warn', 'photo_detail_unavailable');
    return []; // The original still uses high detail; the quality gate still applies.
  }
}
