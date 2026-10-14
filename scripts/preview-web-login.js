// Isolated UI preview. No workers, polling, AI or real bot credentials.
import path from 'node:path';
const port=Number(process.env.WEB_LOGIN_PREVIEW_PORT||3104);
Object.assign(process.env,{NODE_ENV:'development',BOT_PLATFORM:'max',MAX_BOT_TOKEN:'local-preview-disabled',MAX_BOT_USERNAME:'local_preview_bot',MAX_WEBHOOK_SECRET:'local-preview-disabled',TELEGRAM_BOT_TOKEN:'',TELEGRAM_POLLING:'false',OPENAI_API_KEY:'local-preview-disabled',DINNER_LLM_ENABLED:'false',DINNER_IMAGES_ENABLED:'false',DATABASE_PATH:path.resolve('.tmp/web-login-preview.sqlite'),WEB_LOGIN_PROTOTYPE_ENABLED:'true',WEB_LOGIN_OWNER_MAX_ID:'123',WEB_LOGIN_ORIGIN:`http://127.0.0.1:${port}`,APP_URL:`http://127.0.0.1:${port}`});
const {createServer}=await import('../src/server.js');
createServer().listen(port,'127.0.0.1',()=>console.log(`Local prototype UI: http://127.0.0.1:${port}/web-login/prototype (MAX delivery disabled)`));
