import { transcribeAudio } from '../src/openai.js';

const sampleRate = 16_000, seconds = 1, samples = sampleRate * seconds;
const buffer = Buffer.alloc(44 + samples * 2);
buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i += 1) buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 1000), 44 + i * 2);
const text = await transcribeAudio({ userId: null, buffer, mime: 'audio/wav', filename: 'smoke.wav' });
console.log(JSON.stringify({ ok: true, acceptedAudio: true, transcriptLength: text.length }));
