// Relay OpenSSH's byte stream through the Codex Cloud VPN connection.
import { createConnection } from 'node:net';

const [host, port] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9.-]*$/i.test(host || '') || port !== '22') {
  throw new Error('Invalid SSH destination');
}

const socket = createConnection({ host: 'proxy', port: 8088 });
const destination = `${host}:${port}`;
let response = Buffer.alloc(0);
let connected = false;
socket.setTimeout(10000, () => socket.destroy(new Error('Timed out connecting to the VPN proxy')));
socket.on('connect', () => socket.write(
  `CONNECT ${destination} HTTP/1.1\r\nHost: ${destination}\r\n\r\n`,
));
socket.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
  process.stdin.pause();
});
socket.on('close', () => {
  if (!connected) process.exitCode = 1;
  process.stdin.pause();
});
socket.on('data', function acceptTunnel(chunk) {
  response = Buffer.concat([response, chunk]);
  const headerEnd = response.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    if (response.length > 8192) socket.destroy(new Error('Invalid VPN proxy response'));
    return;
  }
  const status = response.subarray(0, headerEnd).toString().match(/^HTTP\/1\.[01] (\d{3})\b/)?.[1];
  if (status !== '200') {
    socket.destroy(new Error(`VPN proxy refused SSH (${status || 'invalid response'})`));
    return;
  }
  connected = true;
  socket.setTimeout(0);
  socket.off('data', acceptTunnel);
  const remainder = response.subarray(headerEnd + 4);
  if (remainder.length) process.stdout.write(remainder);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
});
