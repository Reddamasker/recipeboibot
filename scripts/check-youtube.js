// Run from project root; no AI calls and no changes to the recipe database.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { extractYoutubeSource } = await import(pathToFileURL(path.resolve('src/youtube.js')));
try {
  const source = await extractYoutubeSource('https://youtu.be/79aqvX4RnEU?si=5VaApkw4KRM4QHpu');
  console.log(JSON.stringify({ ok: true, url: source.url, sourceName: source.sourceName, textChars: source.text.length, warnings: source.warnings }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
  process.exitCode = 1;
}
