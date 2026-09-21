// A stand-in for the dashboard server in the tests: an OpenAI-compatible POST /v1/embeddings, and
// PUT for the files that `ideamine publish` uploads. The vectors are a hashed bag of words, so
// texts that share words are similar, and the same text always gets the same vector.

import crypto from 'node:crypto';
import http from 'node:http';

export const DIM = 64;

export function fakeVector(text) {
  const vec = new Array(DIM).fill(0);
  const words = String(text).toLowerCase().replace(/^search_(query|document): /, '').match(/[\p{L}\p{N}]{3,}/gu) || ['empty'];
  for (const w of words) vec[crypto.createHash('sha1').update(w).digest().readUInt16LE(0) % DIM] += 1;
  return vec;
}

/**
 * Start the server on a free port. Options: `maxChars` makes it refuse longer inputs the way
 * llama.cpp does; `down` makes it answer 503. Returns { url, inputs, files, close, options }.
 */
export async function startFakeServer(options = {}) {
  const inputs = []; // every text that /v1/embeddings got, in order
  const files = new Map(); // path -> body of each PUT
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'PUT') {
        files.set(req.url, body);
        res.writeHead(201).end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') return res.writeHead(404).end();
      if (options.down) return res.writeHead(503).end('{"error":"model is loading"}');
      const { input } = JSON.parse(body);
      const texts = Array.isArray(input) ? input : [input];
      inputs.push(...texts);
      const long = texts.find((t) => options.maxChars && t.length > options.maxChars);
      if (long) {
        const error = { code: 500, message: `input (${long.length} tokens) is too large to process. increase the physical batch size`, type: 'server_error' };
        return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));
      }
      const data = texts.map((t, index) => ({ object: 'embedding', index, embedding: fakeVector(t) }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, inputs, files, options, close: () => new Promise((resolve) => server.close(resolve)) };
}
