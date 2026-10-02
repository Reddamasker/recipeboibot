import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const databasePath = path.resolve('data', `youtube-media-${process.pid}.sqlite`);
process.env.DATABASE_PATH = databasePath;
process.env.OPENAI_API_KEY = 'test-key';
process.env.OPENAI_TEXT_MODEL = 'test-model';
const { db } = await import('../src/db.js');
const { mediaPlan, downloadYoutubeMedia, extractYoutubeMediaSource } = await import('../src/youtube-media.js');
const { extractYoutubeRecipe } = await import('../src/youtube-recipe.js');
const { normalizeRecipe } = await import('../src/openai.js');
test.after(async () => { db.close(); for (const suffix of ['', '-wal', '-shm']) await fs.rm(databasePath + suffix, { force: true }); });
const url = 'https://youtube.com/shorts/wVHNa9EWDCU?si=tracking';
const canonical = 'https://www.youtube.com/watch?v=wVHNa9EWDCU';
const probe = (duration = 32, audio = true) => ({ format: { duration: String(duration) }, streams: [{ codec_type: 'video' }, ...(audio ? [{ codec_type: 'audio' }] : [])] });
const frame = { mime: 'image/jpeg', buffer: Buffer.from('frame'), seconds: 1 };
const media = (audio = true) => ({ images: [frame], audio: audio ? { buffer: Buffer.from('audio'), mime: 'audio/mpeg', filename: 'audio.mp3' } : null, info: { title: 'Pasta', uploader: 'cook', description: 'Get the recipe in the app' } });
const notFound = () => Object.assign(new Error('No recipe'), { code: 'RECIPE_NOT_FOUND' });

test('video sampling covers short and long videos; invalid, audio-only and overlong media are rejected', () => {
  assert.deepEqual(mediaPlan(probe()), { duration: 32, interval: 2, hasAudio: true });
  assert.equal(mediaPlan(probe(600)).interval, 37.5);
  assert.equal(mediaPlan(probe(0.5, false)).hasAudio, false);
  for (const duration of [0, NaN, Infinity]) assert.throws(() => mediaPlan(probe(duration)), e => e.code === 'YOUTUBE_MEDIA_METADATA_INVALID');
  assert.throws(() => mediaPlan(probe(601)), e => e.code === 'YOUTUBE_MEDIA_TOO_LONG');
  assert.throws(() => mediaPlan({ format: { duration: 5 }, streams: [{ codec_type: 'audio' }] }), e => e.code === 'YOUTUBE_MEDIA_NO_VIDEO');
});

test('downloader uses one canonical public URL, bounded formats and no login; files are removed after success', async () => {
  let directory;
  const result = await downloadYoutubeMedia(url, { run: async (binary, args, options) => {
    if (args.includes('--print-json')) {
      directory = options.directory;
      assert.equal(args.at(-1), canonical);
      assert.ok(args.includes('--no-playlist'));
      assert.ok(args.includes('--max-filesize'));
      assert.ok(args.includes(`node:${process.execPath}`));
      assert.ok(args.includes('duration <= 600 & !is_live'));
      assert.ok(!args.some(arg => /cookie|username|password/.test(arg)));
      await fs.writeFile(path.join(directory, 'media.mkv'), 'video');
      return JSON.stringify({ id: 'wVHNa9EWDCU', title: 'Pasta' });
    }
    if (args.includes('-show_format')) return JSON.stringify(probe());
    if (args.includes('-frames:v')) {
      assert.equal(args[args.indexOf('-frames:v') + 1], '16');
      await fs.writeFile(path.join(directory, 'frame-01.jpg'), 'frame1');
      await fs.writeFile(path.join(directory, 'frame-02.jpg'), 'frame2');
    } else await fs.writeFile(path.join(directory, 'audio.mp3'), 'audio');
    return '';
  } });
  assert.deepEqual(result.images.map(f => f.seconds), [1, 3]);
  assert.equal(result.audio.mime, 'audio/mpeg');
  await assert.rejects(fs.access(directory));
});

test('failed download removes temporary files and rejects a different video ID', async () => {
  let directory;
  await assert.rejects(downloadYoutubeMedia(url, { run: async (_binary, _args, options) => {
    directory = options.directory;
    await fs.writeFile(path.join(directory, 'media.mkv'), 'partial');
    return JSON.stringify({ id: 'abcdefghijk' });
  } }), e => e.code === 'YOUTUBE_MEDIA_ID_MISMATCH');
  await assert.rejects(fs.access(directory));
  let calls = 0;
  await assert.rejects(downloadYoutubeMedia('https://youtube.com.attacker.example/shorts/wVHNa9EWDCU', { run: async () => { calls++; } }));
  assert.equal(calls, 0);
});

test('media extraction preserves frame order and combines audio; silent video avoids transcription', async () => {
  let calls = 0;
  const transcribe = async input => { calls++; assert.equal(input.userId, 'owner'); assert.equal(input.mime, 'audio/mpeg'); return 'Mix feta and salmon, bake, then stir in pasta.'; };
  const source = await extractYoutubeMediaSource(url, { userId: 'owner', download: async () => media(), transcribe });
  assert.equal(source.url, canonical);
  assert.match(source.text, /Mix feta/);
  assert.deepEqual(source.images, [frame]);
  await extractYoutubeMediaSource(url, { download: async () => media(false), transcribe });
  assert.equal(calls, 1);
});

test('audio failure leaves usable frames and an honest warning', async () => {
  const source = await extractYoutubeMediaSource(url, { download: async () => media(), transcribe: async () => { throw new Error('ASR timeout'); } });
  assert.equal(source.images.length, 1);
  assert.match(source.warnings.join(' '), /Звук не удалось распознать/);
});

test('successful text extraction does not download video or make another normalization call', async () => {
  let downloads = 0, calls = 0;
  const result = await extractYoutubeRecipe(url, {
    extractText: async () => ({ text: 'Recipe in description', sourceName: 'YouTube' }),
    extractMedia: async () => { downloads++; }, normalize: async () => { calls++; return { title: 'Pasta' }; }
  });
  assert.equal(result.recipe.title, 'Pasta'); assert.equal(downloads, 0); assert.equal(calls, 1);
});

test('advertising-only text falls back once to frames and audio with the same user and job phases', async () => {
  let calls = 0, downloads = 0;
  const phases = [];
  const result = await extractYoutubeRecipe(url, { userId: 'owner', onPhase: phase => phases.push(phase),
    extractText: async () => ({ text: 'Get the recipe in the app', sourceName: 'YouTube' }),
    extractMedia: async (_url, options) => { downloads++; assert.equal(options.userId, 'owner'); return { text: 'Audio', images: [frame], sourceName: 'YouTube' }; },
    normalize: async input => { calls++; if (calls === 1) throw notFound(); assert.deepEqual(input.images, [frame]); assert.equal(input.userId, 'owner'); return { title: 'Pasta' }; }
  });
  assert.equal(result.recipe.title, 'Pasta'); assert.equal(downloads, 1); assert.equal(calls, 2);
  assert.deepEqual(phases, ['normalizing', 'fetching', 'normalizing']);
});

test('missing captions and description go directly to media; final empty result explains all attempted sources', async () => {
  let calls = 0;
  await assert.rejects(extractYoutubeRecipe(url, {
    extractText: async () => { throw Object.assign(new Error('No text'), { code: 'YOUTUBE_TEXT_UNAVAILABLE' }); },
    extractMedia: async () => ({ text: 'No recipe', images: [frame] }), normalize: async () => { calls++; throw notFound(); }
  }), e => e.code === 'YOUTUBE_RECIPE_NOT_FOUND' && /звуке и выбранных кадрах/.test(e.message));
  assert.equal(calls, 1);
});

test('access restrictions, provider failures and nutrition errors do not trigger video retries', async () => {
  for (const code of ['YOUTUBE_ACCESS_REQUIRED', 'YOUTUBE_SOURCE_UNAVAILABLE']) {
    await assert.rejects(extractYoutubeRecipe(url, { extractText: async () => { throw Object.assign(new Error(code), { code }); }, extractMedia: async () => assert.fail('must not download') }), e => e.code === code);
  }
  for (const code of ['request_timeout', 'NUTRITION_FAILED']) {
    await assert.rejects(extractYoutubeRecipe(url, { extractText: async () => ({ text: 'Recipe' }), normalize: async () => { throw Object.assign(new Error(code), { code }); }, extractMedia: async () => assert.fail('must not download') }), e => e.code === code);
  }
});

test('normalization sends timestamped high-detail frames and tags an empty recipe for fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    const content = request.input[0].content;
    assert.match(content[1].text, /1\.0 с/);
    assert.equal(content[2].type, 'input_image'); assert.equal(content[2].detail, 'high');
    assert.equal(content[2].image_url, 'data:image/jpeg;base64,' + frame.buffer.toString('base64'));
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ title: '', ingredients: [], steps: [] }) }] }] }), { status: 200 });
  };
  try { await assert.rejects(normalizeRecipe({ text: 'Source', images: [frame] }), e => e.code === 'RECIPE_NOT_FOUND'); }
  finally { globalThis.fetch = originalFetch; }
});
