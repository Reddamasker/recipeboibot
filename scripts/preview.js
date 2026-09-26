// Локальный предпросмотр без ключей, реальных AI-вызовов и Telegram polling.
process.env.TELEGRAM_BOT_TOKEN = 'local-preview-only';
process.env.TELEGRAM_POLLING = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
process.env.OPENAI_API_KEY = 'local-preview-disabled';
await import('./ui-test-server.js');
