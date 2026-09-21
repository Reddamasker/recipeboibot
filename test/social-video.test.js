import test from 'node:test';
import assert from 'node:assert/strict';
import { socialVideo, extractSocialVideoSource } from '../src/social-video.js';

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
