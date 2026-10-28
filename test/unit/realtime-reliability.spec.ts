import { EventEmitter } from 'node:events';
import { Server, Socket } from 'socket.io';
import { ChatGateway } from '../../src/modules/realtime/gateway/chat.gateway';
import { AuthService } from '../../src/modules/auth/service/auth.service';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import { MessagesService } from '../../src/modules/messages/service/messages.service';
import { ReadReceiptsService } from '../../src/modules/read-receipts/service/read-receipts.service';
import { PresenceService } from '../../src/modules/presence/service/presence.service';
import { RedisService } from '../../src/shared/redis/redis.module';
import {
  LiveEvents,
  Metrics,
} from '../../src/shared/observability/observability.module';
import { AppConfig } from '../../src/config/configuration';

const chatId = '00000000-0000-4000-8000-000000000014';
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('Gateway admission and lifecycle (explicit dependency doubles)', () => {
  const leases = new Set<string>();
  const sockets = new Map<string, Socket>();
  const auth = { verify: jest.fn() };
  const chats = { members: jest.fn().mockResolvedValue(['user', 'peer']) };
  const redis = { rateLimit: jest.fn(), client: { isReady: true } };
  const presence = {
    touch: jest.fn(async (_user: string, id: string) => {
      leases.add(id);
      return true;
    }),
    renew: jest.fn(async (_user: string, id: string) => leases.has(id)),
    disconnect: jest.fn(async (_user: string, id: string) => {
      leases.delete(id);
      return false;
    }),
    online: jest.fn().mockResolvedValue(true),
    typingState: jest.fn().mockResolvedValue(false),
  };
  let gateway: ChatGateway;
  let internals: {
    connect(socket: Socket): Promise<void>;
    tick(): Promise<void>;
  };
  let metrics: Metrics;
  let sequence = 0;
  function identity() {
    return { user: { id: 'user' }, expiresAt: Date.now() + 3600000 };
  }
  async function connect() {
    const socket = new EventEmitter() as unknown as Socket;
    Object.assign(socket, {
      id: `device-${++sequence}`,
      connected: true,
      handshake: {
        address: '127.0.0.1',
        headers: {},
        auth: { token: 'private-token' },
      },
      conn: Object.assign(new EventEmitter(), { readyState: 'open' }),
      join: jest.fn(),
      leave: jest.fn(),
      disconnect: jest.fn(() => {
        if (!socket.connected) return socket;
        socket.connected = false;
        socket.conn.readyState = 'closed';
        socket.emit('disconnect');
        return socket;
      }),
    });
    sockets.set(socket.id, socket);
    await internals.connect(socket);
    return socket;
  }
  beforeEach(() => {
    jest.useFakeTimers();
    leases.clear();
    sockets.clear();
    auth.verify.mockReset().mockImplementation(async () => identity());
    redis.rateLimit.mockReset().mockResolvedValue(true);
    Object.values(presence).forEach((mock) => mock.mockClear());
    metrics = new Metrics();
    gateway = new ChatGateway(
      auth as unknown as AuthService,
      chats as unknown as ChatsService,
      {} as MessagesService,
      {} as ReadReceiptsService,
      presence as unknown as PresenceService,
      redis as unknown as RedisService,
      new LiveEvents(),
      metrics,
      { socketRateLimit: 2, corsOrigins: [] } as unknown as AppConfig,
    );
    gateway.server = {
      sockets: { sockets },
      use: jest.fn(),
      on: jest.fn(),
    } as unknown as Server;
    internals = gateway as unknown as typeof internals;
  });
  afterEach(() => {
    gateway.onModuleDestroy();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('rejects twenty IP-limited events without any Firebase/SQL verification', async () => {
    const socket = await connect();
    auth.verify.mockClear();
    chats.members.mockClear();
    redis.rateLimit.mockResolvedValue(false);
    for (let i = 0; i < 20; i++) {
      expect(await gateway.join(socket, { chatId })).toMatchObject({
        ok: false,
        error: { code: 'RATE_LIMITED' },
      });
    }
    expect(auth.verify).not.toHaveBeenCalled();
    expect(chats.members).not.toHaveBeenCalled();
  });
  it('limits a connection locally before coordination and expensive verification', async () => {
    const socket = await connect();
    await gateway.join(socket, { chatId });
    await gateway.join(socket, { chatId });
    auth.verify.mockClear();
    redis.rateLimit.mockClear();
    chats.members.mockClear();
    expect(await gateway.join(socket, { chatId })).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(auth.verify).not.toHaveBeenCalled();
    expect(redis.rateLimit).not.toHaveBeenCalled();
    expect(chats.members).not.toHaveBeenCalled();
  });
  it('rejects an identity-limited event before expensive verification', async () => {
    const socket = await connect();
    auth.verify.mockClear();
    chats.members.mockClear();
    redis.rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await gateway.join(socket, { chatId })).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(auth.verify).not.toHaveBeenCalled();
    expect(chats.members).not.toHaveBeenCalled();
  });
  it('does not recreate a disconnected lease after delayed heartbeat authentication', async () => {
    const socket = await connect();
    const gate = deferred();
    auth.verify.mockImplementation(async () => {
      await gate.promise;
      return identity();
    });
    const tick = internals.tick();
    await flush();
    socket.disconnect(true);
    gate.resolve();
    await tick;
    expect(leases.has(socket.id)).toBe(false);
  });
  it('renews fifty leases independently of delayed authorization with bounded concurrency', async () => {
    for (let i = 0; i < 50; i++) await connect();
    const gate = deferred();
    let active = 0,
      peak = 0;
    auth.verify.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      return identity();
    });
    const tick = internals.tick();
    await flush();
    const renewals = presence.renew.mock.calls.length;
    gate.resolve();
    await tick;
    expect(renewals).toBe(50);
    expect(peak).toBeLessThanOrEqual(32);
    expect(leases.size).toBe(50);
  });
  it('disconnects on a maintenance deadline and fences late authorization completion', async () => {
    const socket = await connect();
    const gate = deferred();
    auth.verify.mockImplementation(async () => {
      await gate.promise;
      return identity();
    });
    const tick = internals.tick();
    await flush();
    await jest.advanceTimersByTimeAsync(5001);
    const connected = socket.connected;
    gate.resolve();
    await tick;
    expect(connected).toBe(false);
    expect(leases.has(socket.id)).toBe(false);
  });
  it('never renews an expired identity', async () => {
    const socket = await connect();
    await jest.advanceTimersByTimeAsync(3600001);
    await internals.tick();
    expect(socket.connected).toBe(false);
    expect(presence.renew).not.toHaveBeenCalled();
  });
  it('rejects events on a removed session without verification', async () => {
    const socket = await connect();
    socket.disconnect(true);
    auth.verify.mockClear();
    expect(await gateway.join(socket, { chatId })).toMatchObject({
      ok: false,
      error: { code: 'UNAUTHENTICATED' },
    });
    expect(auth.verify).not.toHaveBeenCalled();
  });
});
