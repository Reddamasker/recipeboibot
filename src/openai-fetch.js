import { Agent, request as httpsRequest } from 'node:https';

let activeProxy;
let proxyAgent;

function agentFor(proxy) {
  if (proxy === activeProxy && proxyAgent) return proxyAgent;
  proxyAgent?.destroy();
  const url = new URL(proxy);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OPENAI_HTTPS_PROXY must be a plain HTTP proxy URL without credentials or path');
  }
  activeProxy = proxy;
  proxyAgent = new Agent({ keepAlive: true, proxyEnv: { HTTPS_PROXY: proxy } });
  return proxyAgent;
}

// A CONNECT proxy carries encrypted TLS bytes; the proxy never receives the
// OpenAI Authorization header or request body in plaintext.
export async function openaiFetch(input, init) {
  const proxy = process.env.OPENAI_HTTPS_PROXY;
  if (!proxy) return fetch(input, init);

  const url = new URL(input);
  if (url.origin !== 'https://api.openai.com') throw new Error('OpenAI proxy is restricted to api.openai.com');
  const source = new Request(url, init);
  const body = source.body ? Buffer.from(await source.arrayBuffer()) : null;
  const headers = Object.fromEntries(source.headers);
  if (body) headers['content-length'] = String(body.length);

  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      agent: agentFor(proxy),
      method: source.method,
      headers,
      signal: source.signal
    }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: responseHeaders }));
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.end(body);
  });
}
