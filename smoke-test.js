import { spawn } from 'child_process';
import { createInterface } from 'readline';

const EXPECTED_TOOLS = [
  'get_airbnb_reservations',
  'get_booking_reservations',
  'get_airbnb_messages',
  'get_airbnb_calendar',
  'get_booking_calendar',
];

const proc = spawn('node', ['index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  cwd: process.cwd(),
});

const pending = new Map();

const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// MCP handshake: initialize → initialized → tools/list
await request(1, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'smoke-test', version: '1.0.0' },
});

notify('notifications/initialized');

const toolsRes = await request(2, 'tools/list', {});

proc.kill();

const toolNames = (toolsRes.result?.tools ?? []).map((t) => t.name);

let allPass = true;
console.log('\nSmoke test — tools/list\n');
for (const name of EXPECTED_TOOLS) {
  const pass = toolNames.includes(name);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) allPass = false;
}
console.log('');

if (allPass) {
  console.log('All tools registered. Server is working correctly.\n');
} else {
  console.error('One or more tools missing from server response.\n');
}

process.exit(allPass ? 0 : 1);
