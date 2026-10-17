import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import type { TerminalManager } from '../terminal/terminalManager.ts';
import { originAllowed } from './routes.ts';

// Phase 3c owner terminals (D-019). Registered after registerRoutes, so the Host check, the token check (also as
// ?token= for the WebSocket) and the JSON/Origin rules for POST/DELETE apply. The WebSocket upgrade is a GET, so its
// Origin is checked here: a browser always sends one, and only the dashboard's own origin may attach.

const MAX_BUFFERED_BYTES = 1024 * 1024;
const sessionParam = z.object({ id: z.string().uuid() });
const terminalParam = z.object({ id: z.string().uuid() });
const openBody = z.object({ confirm: z.literal(true), cols: z.number().int().min(10).max(500).default(100),
  rows: z.number().int().min(5).max(200).default(30) });
const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(64 * 1024) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(5).max(200) }),
]);

export interface TerminalRouteDeps {
  config: AppConfig;
  terminals: TerminalManager;
}

export function registerTerminalRoutes(app: FastifyInstance, { config, terminals }: TerminalRouteDeps): void {
  app.get('/api/v2/terminals', async () => ({ terminals: terminals.list(), unavailableReason: terminals.unavailableReason() }));

  app.post('/api/v2/sessions/:id/terminal', async (request, reply) => {
    const { id } = sessionParam.parse(request.params);
    const { cols, rows } = openBody.parse(request.body);
    return reply.code(201).send(terminals.open(id, { cols, rows }));
  });

  app.delete('/api/v2/terminals/:id', async (request) => {
    await terminals.close(terminalParam.parse(request.params).id);
    return { closed: true };
  });

  app.get('/api/v2/terminals/:id/ws', { websocket: true }, (socket, request) => {
    const origin = request.headers.origin;
    const parsed = terminalParam.safeParse(request.params);
    if (!origin || !originAllowed(config, origin, request.headers.host) || !parsed.success) {
      socket.close(1008, 'Rejected');
      return;
    }
    let detach: () => void;
    try {
      detach = terminals.attach(parsed.data.id, {
        data: (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          // A client that stops reading is dropped instead of buffering output without limit (V21-S7).
          if (socket.bufferedAmount > MAX_BUFFERED_BYTES) socket.close(1013, 'Client too slow');
          else socket.send(chunk);
        },
        end: (reason) => {
          if (socket.readyState === socket.OPEN) socket.send(`\r\n[terminal closed: ${reason}]\r\n`);
          socket.close(1000, 'Terminal closed');
        },
      });
    } catch (error) {
      socket.close(1011, error instanceof Error ? error.message.slice(0, 100) : 'Terminal not available');
      return;
    }
    socket.on('message', (raw: Buffer) => {
      const message = clientMessage.safeParse(safeJson(raw.toString('utf8')));
      if (!message.success) return;
      try {
        if (message.data.type === 'input') terminals.input(parsed.data.id, message.data.data);
        else terminals.resize(parsed.data.id, message.data.cols, message.data.rows);
      } catch {
        socket.close(1011, 'Terminal closed');
      }
    });
    socket.on('close', () => detach());
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
