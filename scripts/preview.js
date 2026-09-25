// Локальный предпросмотр без ключей, реальных AI-вызовов и Telegram polling.
process.env.TELEGRAM_BOT_TOKEN = 'local-preview-only';
process.env.TELEGRAM_POLLING = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
process.env.OPENAI_API_KEY = 'local-preview-disabled';
process.env.AI_MAX_DAILY_REQUESTS = '0';
process.env.AI_MAX_TOTAL_REQUESTS = '0';
await import('./ui-test-server.js');
