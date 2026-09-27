import { openaiFetch } from '../src/openai-fetch.js';

const response = await openaiFetch('https://api.openai.com/v1/models', { signal: AbortSignal.timeout(15000) });
const payload = await response.json();
console.log(JSON.stringify({ status: response.status, errorCode: payload.error?.code || null }));
if (response.status !== 401) process.exitCode = 1;
