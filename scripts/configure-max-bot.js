// Run inside the isolated MAX container with its existing environment.
import { config, assertConfig } from '../src/config.js';
import { maxApiCall } from '../src/max-client.js';

const mode = process.argv[2];
if (!['--check', '--apply'].includes(mode)) throw new Error('Usage: node scripts/configure-max-bot.js --check | --apply');
assertConfig();
if (config.botPlatform !== 'max' || !config.appUrl.startsWith('https://')) throw new Error('Expected isolated MAX configuration');
const bot = await maxApiCall('/me');
if (!bot.is_bot || bot.username !== config.maxBotUsername) throw new Error('Unexpected MAX bot');
const url = `${config.appUrl}/api/max/webhook`;
const updateTypes = ['bot_started', 'message_created', 'message_callback'];
if (mode === '--apply') await maxApiCall('/subscriptions', { method: 'POST', body: { url, update_types: updateTypes, secret: config.maxWebhookSecret } });
const subscriptions = await maxApiCall('/subscriptions');
const active = subscriptions.subscriptions?.find(item => item.url === url);
if (!active || !updateTypes.every(type => active.update_types?.includes(type))) throw new Error('MAX webhook is not configured for all recipe events');
console.log(JSON.stringify({ bot: bot.username, webhook: url, updateTypes, verified: true }));
