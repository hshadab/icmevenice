// server.js — HTTP server for the procurement agent demo UI
// Serves the frontend and provides an SSE endpoint for streaming agent events.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAgent } from './agent.js';

const PORT = process.env.PORT || 3000;
let running = false; // mutex: one run at a time

const server = createServer(async (req, res) => {
  // CORS + common headers
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/run') {
    if (running) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Agent is already running. Wait for it to finish.' }));
      return;
    }
    running = true;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let closed = false;
    req.on('close', () => { closed = true; });

    const send = (type, data) => {
      if (closed) return;
      // BigInt-safe JSON serialization
      const json = JSON.stringify({ type, ...data }, (k, v) =>
        typeof v === 'bigint' ? v.toString() : v
      );
      res.write(`data: ${json}\n\n`);
    };

    // Keepalive: send comment every 15s to prevent proxy timeout
    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 15000);

    try {
      const agent = createAgent({ emit: send });
      await agent.run();
    } catch (err) {
      send('error', { step: 0, message: err.message });
    } finally {
      clearInterval(keepalive);
      running = false;
      if (!closed) res.end();
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Procurement Agent Demo UI`);
  console.log(`  http://localhost:${PORT}\n`);
});
