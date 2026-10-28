import { createHash } from 'node:crypto';
import { config } from './config.js';

export const MAX_RECIPE_PHOTOS = 10;
const hash = value => createHash('sha256').update(value).digest('hex');
export function recipePhotos({ image, photos } = {}) {
  const source = photos === undefined ? (image ? [image] : []) : photos;
  if (!Array.isArray(source) || source.length > MAX_RECIPE_PHOTOS) throw Object.assign(new Error('Можно добавить до 10 фото одного рецепта.'), { status: 413 });
  const result = [], seen = new Set();
  let size = 0;
  for (const photo of source) {
    if (!photo || !Buffer.isBuffer(photo.buffer) || !photo.buffer.length || !/^image\/(jpeg|png|webp)$/.test(photo.mime || '')) throw Object.assign(new Error('Нужны изображения JPEG, PNG или WEBP.'), { status: 415 });
    size += photo.buffer.length;
    if (size > config.maxUploadBytes) throw Object.assign(new Error('Общий размер фото превышает 6 МБ. Добавьте файлы поменьше.'), { status: 413 });
    const key = hash(photo.buffer);
    if (!seen.has(key)) { result.push(photo); seen.add(key); }
  }
  return result;
}
export function photoSourceKey(photos) {
  return photos.length === 1 ? `image:${hash(photos[0].buffer)}` : `photos:${hash(photos.map(photo => hash(photo.buffer)).join(':'))}`;
}
