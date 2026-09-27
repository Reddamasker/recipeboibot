const redact = (value) => {
  if (value instanceof Error) return { name: value.name, message: value.message, causeCode: value.cause?.code, stack: process.env.NODE_ENV === 'development' ? value.stack : undefined };
  if (!value || typeof value !== 'object') return value;
  const clean = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) clean[key] = /token|secret|key|initdata|content|text/i.test(key) ? '[redacted]' : redact(item);
  return clean;
};

export function log(level, event, details = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(details) })}\n`);
}
