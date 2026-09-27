import { openaiFetch } from '../src/openai-fetch.js';

const key = process.env.OPENAI_API_KEY;
const response = await openaiFetch('https://api.openai.com/v1/models', {
  signal: AbortSignal.timeout(15000),
  ...(key ? { headers: { authorization: `Bearer ${key}` } } : {})
});
const payload = await response.json();
console.log(JSON.stringify({ status: response.status, modelCount: payload.data?.length || 0, errorCode: payload.error?.code || null }));
if (response.status !== (key ? 200 : 401)) process.exitCode = 1;
