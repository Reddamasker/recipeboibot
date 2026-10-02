import { extractYoutubeSource } from './youtube.js';
import { extractYoutubeMediaSource } from './youtube-media.js';
import { normalizeRecipe } from './openai.js';
import { log } from './log.js';

export async function extractYoutubeRecipe(input, { userId = null, extractText = extractYoutubeSource, extractMedia = extractYoutubeMediaSource, normalize = normalizeRecipe, onPhase = () => {} } = {}) {
  let source;
  try { source = await extractText(input); }
  catch (error) { if (error.code !== 'YOUTUBE_TEXT_UNAVAILABLE') throw error; }
  if (source) {
    onPhase('normalizing');
    try { return { source, recipe: await normalize({ userId, text: source.text, sourceName: source.sourceName }) }; }
    catch (error) { if (error.code !== 'RECIPE_NOT_FOUND') throw error; }
  }
  log('info', 'youtube_video_fallback', { userId, reason: source ? 'recipe_not_found_in_text' : 'text_unavailable' });
  onPhase('fetching');
  source = await extractMedia(input, { userId });
  onPhase('normalizing');
  try { return { source, recipe: await normalize({ userId, text: source.text, images: source.images, sourceName: source.sourceName }) }; }
  catch (error) {
    if (error.code === 'RECIPE_NOT_FOUND') throw Object.assign(new Error('В описании, звуке и выбранных кадрах YouTube не удалось найти достаточно данных рецепта. Пришлите текст или скриншот с ингредиентами и шагами.'), { code: 'YOUTUBE_RECIPE_NOT_FOUND', status: 422 });
    throw error;
  }
}
