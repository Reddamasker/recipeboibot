import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { safeFetchText } from './security.js';
import { parseYoutubePlayer, youtubeVideo } from './youtube.js';
import { extractYoutubeRecipe } from './youtube-recipe.js';
import { extractSocialVideoSource, socialVideo } from './social-video.js';
import { normalizeRecipe } from './openai.js';
import { catalogVideoUrl, catalogVideoSource } from './catalog-video-source.js';

const execute = promisify(execFile);
async function publicAuthor(url) {
  const youtube = youtubeVideo(url);
  if (youtube) {
    const page = await safeFetchText(url, 3 * 1024 * 1024);
    const player = parseYoutubePlayer(page.text);
    const details = player.videoDetails;
    if (details?.videoId === youtube.id && player.playabilityStatus?.status === 'OK' &&
        details.isPrivate === false && player.microformat?.playerMicroformatRenderer?.isUnlisted === false && details.author) {
      return 'YouTube · ' + details.author;
    }
    return null;
  }
  const video = socialVideo(url);
  const { stdout } = await execute(config.ytDlpPath, ['--ignore-config','--no-playlist','--skip-download','--dump-json','--',video.downloadUrl || url],
    { timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const info = JSON.parse(stdout);
  const author = info.uploader || info.channel;
  return info.availability === 'public' && socialVideo(info.webpage_url)?.sourceKey === video.sourceKey && author ? video.label + ' · ' + author : null;
}

async function extractOriginal(url) {
  if (youtubeVideo(url)) return (await extractYoutubeRecipe(url)).recipe;
  const source = await extractSocialVideoSource(url);
  return normalizeRecipe({text: source.text, sourceName: source.sourceName});
}

export async function prepareSavedVideos(db, store, platform, {author = publicAuthor, extract = extractOriginal} = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS catalog_video_checks(source_key TEXT PRIMARY KEY,state TEXT NOT NULL,next_check TEXT)');
  const rows = db.prepare(`SELECT j.source_key,j.source_url,r.id,r.created_at=r.updated_at AS original
    FROM import_jobs j JOIN recipes r ON r.id=j.recipe_id AND r.user_id=j.user_id
    LEFT JOIN catalog_video_checks c ON c.source_key=j.source_key
    WHERE j.source_type='url' AND j.status='ready' AND r.status='ready' AND r.origin='imported'
    AND r.source_type='url' AND r.source_key=j.source_key
    AND (j.source_key GLOB 'youtube:*' OR j.source_key GLOB 'instagram:*' OR j.source_key GLOB 'vk:*' OR j.source_key GLOB 'tiktok:*')
    AND (c.source_key IS NULL OR c.next_check<=?) ORDER BY j.created_at DESC`).all(new Date().toISOString());
  const checked = new Set();
  const mark = db.prepare('INSERT OR REPLACE INTO catalog_video_checks VALUES(?,?,?)');
  for (const row of rows) {
    if (checked.size >= 2) break;
    if (checked.has(row.source_key)) continue;
    checked.add(row.source_key);
    try {
      const url = catalogVideoUrl(row.source_url);
      const source = url && catalogVideoSource({sourceUrl:url,sourceName:await author(url)});
      if (!source) {
        mark.run(row.source_key,'unconfirmed',new Date(Date.now()+86400000).toISOString());
        continue;
      }
      // Imported fields are reusable only while the server's original row is untouched.
      // After any edit, rebuild from the public video using no account context.
      let recipe;
      if (row.original) {
        const raw = db.prepare(`SELECT title,description,servings,prep_minutes AS prepMinutes,cook_minutes AS cookMinutes,
          ingredients_json,steps_json,tags_json FROM recipes WHERE id=? AND created_at=updated_at`).get(row.id);
        if (raw) recipe = {...raw,ingredients:JSON.parse(raw.ingredients_json),steps:JSON.parse(raw.steps_json),tags:JSON.parse(raw.tags_json)};
      }
      recipe ||= await extract(url);
      store.enqueue(platform,{...recipe,videoSource:source},'public_video');
      mark.run(row.source_key,'processed',null);
    } catch {
      mark.run(row.source_key,'error',new Date(Date.now()+3600000).toISOString());
    }
  }
}
