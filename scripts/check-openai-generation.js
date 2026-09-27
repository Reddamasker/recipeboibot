import { config } from '../src/config.js';
import { openaiFetch } from '../src/openai-fetch.js';

if (!config.openaiKey || !config.textModel) throw new Error('OpenAI key or text model is missing');
const response = await openaiFetch('https://api.openai.com/v1/responses', {
  method: 'POST',
  signal: AbortSignal.timeout(30000),
  headers: { authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ model: config.textModel, input: 'Ответь одним словом: готово', max_output_tokens: 40, store: false })
});
const payload = await response.json();
const output = payload.output_text || payload.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text || '';
console.log(JSON.stringify({ status: response.status, errorCode: payload.error?.code || null, hasOutput: Boolean(output), usage: payload.usage?.total_tokens || 0 }));
if (!response.ok || !output) process.exitCode = 1;
