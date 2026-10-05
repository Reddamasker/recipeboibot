import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);
export async function inspectMaxAudio(buffer) {
  const directory = await mkdtemp(path.join(tmpdir(), 'recipe-max-audio-'));
  try {
    const file = path.join(directory, 'incoming.audio');
    await writeFile(file, buffer);
    const { stdout } = await run(config.ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file], { timeout: 10000, maxBuffer: 16000, windowsHide: true });
    const probe = JSON.parse(stdout);
    const duration = Number(probe.format?.duration);
    const stream = probe.streams?.find(item => item.codec_type === 'audio');
    if (!stream || !Number.isFinite(duration) || duration <= 0 || duration > 120) throw new Error('Пришлите голосовое длительностью до 2 минут.');
    const formats = { opus: ['audio/ogg', 'ogg'], vorbis: ['audio/ogg', 'ogg'], mp3: ['audio/mpeg', 'mp3'], aac: ['audio/mp4', 'm4a'], pcm_s16le: ['audio/wav', 'wav'], pcm_s24le: ['audio/wav', 'wav'] };
    const [mime, extension] = formats[stream.codec_name] || [];
    if (!mime) throw new Error('Не удалось прочитать аудио. Пришлите голосовое ещё раз.');
    return { duration, mime, extension };
  } catch (error) {
    if (error.message.startsWith('Пришлите') || error.message.startsWith('Не удалось прочитать')) throw error;
    throw new Error('Не удалось проверить голосовое. Пришлите его ещё раз или напишите текстом.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
