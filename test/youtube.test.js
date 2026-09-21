import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, assertSafeRemoteUrl } from '../src/security.js';
import { youtubeVideo, parseYoutubePlayer, parseYoutubeCaptions, extractYoutubeSource } from '../src/youtube.js';

const id = '79aqvX4RnEU';
const makePlayer = (description = '#wings #chilioil', tracks = []) => ({
  playabilityStatus: { status: 'OK' },
  videoDetails: { videoId: id, title: 'Test wings', author: 'Test author', shortDescription: description },
  captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } }
});
const html = player => `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script><div>Unrelated navigation and recommended recipes</div>`;
const track = { languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=79aqvX4RnEU&lang=en' };

test('public YouTube IPv6 is allowed; reserved addresses stay blocked', () => {
  for (const ip of ['2001:4860:482a:400::', '2001:4860:4860::8888', '2a00:1450:400e:813::200e', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
  for (const ip of ['2001::1', '2001:1ff:ffff::1', '2001:db8::1', '2002:7f00:1::', '3fff:fff::1', 'fc00::1', '::ffff:8.8.8.8', '::1', 'fe80::1']) assert.equal(isPrivateIp(ip), true, ip);
});

test('literal IPv6 localhost rejected before requesting content', async () => {
  await assert.rejects(assertSafeRemoteUrl('http://[::1]/'), /запрещён/);
});

test('YouTube URL formats canonicalize without tracking params', () => {
  for (const input of [`https://youtu.be/${id}?si=tracking`, `https://www.youtube.com/watch?v=${id}&list=abc`, `https://m.youtube.com/shorts/${id}`, `https://youtube.com/embed/${id}`]) {
    assert.deepEqual(youtubeVideo(input), { id, url: `https://www.youtube.com/watch?v=${id}` });
  }
  assert.equal(youtubeVideo(`https://youtube.com.attacker.example/watch?v=${id}`), null);
  for (const input of ['https://youtube.com/@channel', 'https://youtube.com/watch?v=bad', `https://user:pass@youtube.com/watch?v=${id}`, `https://youtube.com:8443/watch?v=${id}`]) assert.throws(() => youtubeVideo(input));
});

test('embedded player is parsed without evaluating JS and tolerates braces in strings', () => {
  const player = makePlayer('Text containing }; and "quoted" strings \\ slash');
  assert.deepEqual(parseYoutubePlayer(html(player)), player);
  assert.throws(() => parseYoutubePlayer('<script>ytInitialPlayerResponse = alert(1)</script>'));
});

test('JSON, XML and srv3 captions are decoded; empty/error pages are ignored', () => {
  assert.equal(parseYoutubeCaptions(JSON.stringify({ events: [{ segs: [{ utf8: 'Mix ' }, { utf8: 'honey' }] }, { segs: [{ utf8: 'Cook wings' }] }] })), 'Mix honey\nCook wings');
  assert.equal(parseYoutubeCaptions('<transcript><text start="0">Mix &amp; stir &#39;sauce&#39;</text></transcript>'), "Mix & stir 'sauce'");
  assert.equal(parseYoutubeCaptions('<timedtext><body><p t="0"><s>Mix </s><s>honey</s></p></body></timedtext>'), 'Mix honey');
  assert.equal(parseYoutubeCaptions('<html>Access denied</html>'), '');
  assert.equal(parseYoutubeCaptions(''), '');
});

test('available captions form source evidence with no unrelated page text', async () => {
  const calls = [];
  const source = await extractYoutubeSource(`https://youtu.be/${id}`, async (url, max) => {
    calls.push({ url, max });
    return { text: calls.length === 1 ? html(makePlayer(undefined, [track])) : '<transcript><text>Season the chicken wings with salt. Cook them, then coat them with honey and chili oil.</text></transcript>' };
  });
  assert.match(source.text, /Season the chicken/);
  assert.doesNotMatch(source.text, /Unrelated navigation/);
  assert.match(source.warnings[0], /автоматические/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.max > 0 && call.max <= 3 * 1024 * 1024));
});

test('empty subtitles plus hashtags fail before AI rather than inventing a recipe', async () => {
  let calls = 0;
  await assert.rejects(extractYoutubeSource(`https://youtu.be/${id}`, async () => ({ text: ++calls === 1 ? html(makePlayer(undefined, [track])) : '' })), error => error.code === 'YOUTUBE_TEXT_UNAVAILABLE');
  assert.equal(calls, 2);
});

test('a substantive description remains usable when captions fail, with warning', async () => {
  let calls = 0;
  const source = await extractYoutubeSource(`https://youtu.be/${id}`, async () => {
    if (++calls === 1) return { text: html(makePlayer('Ingredients: 500g chicken wings, 2 tbsp honey and 1 tbsp chili oil. Roast the wings and coat them in the sauce.', [track])) };
    throw new Error('Caption request failed');
  });
  assert.match(source.text, /500g chicken/);
  assert.match(source.warnings[0], /только из описания/);
});

test('caption destinations outside YouTube are not requested', async () => {
  let calls = 0;
  await assert.rejects(extractYoutubeSource(`https://youtu.be/${id}`, async () => {
    calls++;
    return { text: html(makePlayer(undefined, [{ ...track, baseUrl: 'http://169.254.169.254/latest/meta-data/' }])) };
  }), error => error.code === 'YOUTUBE_TEXT_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('restricted and mismatched video data never go to AI', async () => {
  const restricted = makePlayer(); restricted.playabilityStatus.status = 'LOGIN_REQUIRED';
  await assert.rejects(extractYoutubeSource(`https://youtu.be/${id}`, async () => ({ text: html(restricted) })), error => error.code === 'YOUTUBE_ACCESS_REQUIRED');
  const wrong = makePlayer(); wrong.videoDetails.videoId = 'abcdefghijk';
  await assert.rejects(extractYoutubeSource(`https://youtu.be/${id}`, async () => ({ text: html(wrong) })), /подтвердить/);
});

test('public player refresh supplies working subtitle track with bounded requests', async () => {
  let getCalls = 0, postCalls = 0;
  const source = await extractYoutubeSource(`https://youtu.be/${id}`, async () => ({
    text: ++getCalls === 1 ? html(makePlayer()) + '<script>var cfg={"INNERTUBE_API_KEY":"public-fixture-key"}</script>'
      : '<transcript><text>Mix chicken wings with mustard. Cook the wings, then add honey and chili oil.</text></transcript>'
  }), async (url, body, max) => {
    postCalls++;
    assert.equal(new URL(url).hostname, 'www.youtube.com');
    assert.equal(body.videoId, id);
    assert.ok(max <= 2 * 1024 * 1024);
    return makePlayer(undefined, [track]);
  });
  assert.match(source.text, /Mix chicken wings/);
  assert.equal(getCalls, 2); assert.equal(postCalls, 1);
});

test('player API access restrictions are not bypassed with HTML fallback', async () => {
  let getCalls = 0;
  await assert.rejects(extractYoutubeSource(`https://youtu.be/${id}`, async () => {
    getCalls++;
    return { text: html(makePlayer()) + '"INNERTUBE_API_KEY":"public-fixture-key"' };
  }, async () => ({ playabilityStatus: { status: 'LOGIN_REQUIRED' } })), error => error.code === 'YOUTUBE_ACCESS_REQUIRED');
  assert.equal(getCalls, 1);
});
