// An ideamine server in its own process, as on a real server: its own IDEAMINE_HOME, sync off. The
// tests switch IDEAMINE_HOME between machines in the test process, so the server must not share it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/ideamine.js', import.meta.url));

/** A port that nothing listens on now. */
export async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** Start `ideamine serve`. Resolves to { url, home, port, stop }. `env` adds settings. */
export async function startServerProcess(env = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ideamine-server-'));
  const port = await freePort();
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('IDEAMINE_')) delete clean[key];
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
    env: { ...clean, IDEAMINE_HOME: home, IDEAMINE_EMBED_URL: 'http://127.0.0.1:9/v1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}api/ping`)).ok) break;
    } catch {
      // Not listening yet.
    }
    if (i > 100 || child.exitCode !== null) throw new Error(`the server did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    });
  return { url, home, port, stop, output: () => output };
}
