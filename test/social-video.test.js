import test from 'node:test';
import assert from 'node:assert/strict';
import { socialVideo, extractSocialVideoSource, downloadPublicVideo } from '../src/social-video.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const okClip = 'https://ok.ru/clip?clip_id=456241789&owner_id=-211246947&ref=ok';
const okCanonical = 'https://ok.ru/clip?owner_id=-211246947&clip_id=456241789';

test('OK query and path clips resolve to the same VK video without losing the OK source', () => {
  for (const url of [okClip, 'https://m.ok.ru/clip/-211246947/456241789?st.cmd=anonymContentSearch', 'https://www.ok.ru/clip?owner_id=-211246947&clip_id=456241789']) {
    assert.deepEqual(socialVideo(url), {platform:'ok',id:'-211246947_456241789',url:okCanonical,
      downloadUrl:'https://vk.com/clip-211246947_456241789',sourceKey:'vk:-211246947_456241789',label:'Одноклассники'});
  }
  assert.equal(socialVideo(okClip).sourceKey, socialVideo('https://vk.com/clip-211246947_456241789').sourceKey);
  assert.equal(socialVideo('https://ok.ru/clip?owner_id=123&clip_id=456').downloadUrl, 'https://vk.com/clip123_456');
  assert.equal(socialVideo('https://ok.ru.attacker.example/clip?owner_id=123&clip_id=456'), null);
  for (const url of ['https://ok.ru/clip?clip_id=456', 'https://ok.ru/clip?owner_id=1&clip_id=2&clip_id=3',
    'https://ok.ru/clip?owner_id=1&owner_id=2&clip_id=3', 'https://ok.ru/clip?owner_id=0&clip_id=2',
    'https://ok.ru/clip?owner_id=1&clip_id=https://evil.example', 'https://ok.ru/clip/1/2/extra',
    'https://user:pass@ok.ru/clip/1/2', 'https://ok.ru:8443/clip/1/2', 'ftp://ok.ru/clip/1/2']) {
    assert.throws(() => socialVideo(url), error => error.code === 'INVALID_SOCIAL_VIDEO_URL');
  }
});

test('OK download uses the public VK clip, retains attribution and removes temporary media', async () => {
  let directory;
  const media = await downloadPublicVideo(okClip, {runDownloader: async (url, dir) => {
    directory = dir;
    assert.equal(url, 'https://vk.com/clip-211246947_456241789');
    await fs.writeFile(path.join(dir, 'media.mp4'), 'video');
    return {title:'Молочный ломтик',description:'Ингредиенты и шаги автора',uploader:'Автор',webpage_url:url};
  }});
  assert.equal(media.info.webpageUrl, okCanonical);
  assert.equal(media.info.description, 'Ингредиенты и шаги автора');
  assert.equal(media.mime, 'video/mp4');
  await assert.rejects(fs.access(directory));
  await assert.rejects(downloadPublicVideo(okClip, {runDownloader: async (_url, dir) => {
    directory = dir; throw Object.assign(new Error('Недоступен'), {code:'SOCIAL_VIDEO_UNAVAILABLE'});
  }}), error => error.code === 'SOCIAL_VIDEO_UNAVAILABLE');
  await assert.rejects(fs.access(directory));
});

test('OK description and speech reach recipe extraction with the original source', async () => {
  const source = await extractSocialVideoSource(okClip, {
    userId:'owner', download: async url => {
      assert.equal(url, okCanonical);
      return {buffer:Buffer.from('video'),mime:'video/mp4',filename:'media.mp4',info:{
        title:'Молочный ломтик',description:'Яйца 4 шт. Мука 80 г. Взбить яйца и добавить муку.',webpageUrl:okCanonical,uploader:'Автор'}};
    }, transcribe: async input => {assert.equal(input.userId,'owner');return 'Выпекать бисквит десять минут. Охладить с кремом один час.';}
  });
  assert.equal(source.url,okCanonical);
  assert.equal(source.sourceName,'Одноклассники · Автор');
  assert.match(source.text,/Мука 80 г/);
  assert.match(source.text,/Охладить с кремом/);
});

test('supported social-video URLs are recognized and stable IDs ignore tracking', () => {
  assert.deepEqual(socialVideo('https://www.instagram.com/reel/DddpiwOunya?igsh=tracking'), {
    platform: 'instagram', id: 'DddpiwOunya', url: 'https://www.instagram.com/reel/DddpiwOunya/', sourceKey: 'instagram:DddpiwOunya', label: 'Instagram'
  });
  assert.equal(socialVideo('https://www.tiktok.com/@cook/video/7481234567890?is_from_webapp=1').sourceKey, 'tiktok:7481234567890');
  assert.equal(socialVideo('https://vm.tiktok.com/ZMshort/').platform, 'tiktok');
  assert.equal(socialVideo('https://vk.com/video-123_456?list=abc').sourceKey, 'vk:-123_456');
  assert.equal(socialVideo('https://vkvideo.ru/video-123_456').platform, 'vk');
  assert.equal(socialVideo('https://instagram.com.attacker.example/reel/DddpiwOunya'), null);
  assert.throws(() => socialVideo('https://www.instagram.com/explore/'), error => error.code === 'INVALID_SOCIAL_VIDEO_URL');
  assert.throws(() => socialVideo('https://www.tiktok.com/@cook'), error => error.code === 'INVALID_SOCIAL_VIDEO_URL');
  assert.throws(() => socialVideo('https://vk.com/cook'), error => error.code === 'INVALID_SOCIAL_VIDEO_URL');
});

test('social-video source combines the full description and audio transcript', async () => {
  let transcribed = 0;
  const source = await extractSocialVideoSource('https://www.instagram.com/reel/DddpiwOunya/', {
    userId: 'user-1',
    download: async () => ({
      buffer: Buffer.from('video'), mime: 'video/mp4', filename: 'media.mp4',
      info: { title: 'Лаваш', description: 'Ингредиенты указаны в описании', uploader: 'cook', thumbnailUrl: 'https://cdn.example/preview.jpg', webpageUrl: 'https://www.instagram.com/reel/DddpiwOunya/' }
    }),
    transcribe: async input => { transcribed++; assert.equal(input.userId, 'user-1'); assert.equal(input.mime, 'video/mp4'); return 'Берём лаваш, сыр и яйцо. Обжариваем пять минут.'; }
  });
  assert.equal(transcribed, 1);
  assert.match(source.text, /Ингредиенты указаны/);
  assert.match(source.text, /Берём лаваш/);
  assert.equal(source.sourceName, 'Instagram · cook');
  assert.equal(source.thumbnailUrl, 'https://cdn.example/preview.jpg');
  assert.match(source.warnings[0], /расшифровка/);
});

test('social-video source refuses to invent a recipe when description and speech are empty', async () => {
  await assert.rejects(extractSocialVideoSource('https://www.tiktok.com/@cook/video/7481234567890', {
    download: async () => ({ buffer: Buffer.from('video'), mime: 'video/mp4', filename: 'media.mp4', info: {} }),
    transcribe: async () => ''
  }), error => error.code === 'SOCIAL_VIDEO_TEXT_UNAVAILABLE');
});
