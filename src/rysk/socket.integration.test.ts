import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { JsonRpcSocket } from './socket.ts';

describe('JsonRpcSocket against a real ws server', () => {
  let server: WebSocketServer;
  let url: string;

  beforeAll(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (client) => {
      client.on('message', (data) => {
        const frame = JSON.parse(String(data)) as { id: unknown; params: unknown };
        client.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { echo: frame.params } }));
      });
    });
    await once(server, 'listening');
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('round-trips one call through the global WebSocket', async () => {
    const socket = new JsonRpcSocket({ url });
    try {
      await expect(socket.call('ping', { a: 1 }, { timeoutMs: 5_000 })).resolves.toEqual({ echo: { a: 1 } });
      expect(socket.state).toBe('open');
      expect(socket.connectionId).toBe(1);
    } finally {
      socket.close();
    }
  });
});
