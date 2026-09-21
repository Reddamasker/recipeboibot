import fs from 'node:fs';
import path from 'node:path';
import { transcribeAudio } from '../src/openai.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) throw new Error('Pass an existing audio file');
const buffer = fs.readFileSync(file);
const text = await transcribeAudio({ userId: null, buffer, mime: 'audio/wav', filename: path.basename(file) });
console.log(JSON.stringify({ ok: true, transcript: text }));
