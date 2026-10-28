import { ChatsRepository } from '../../src/modules/chats/repository/chats.repository';
import { directPairKey } from '../../src/modules/chats/utils/direct-pair';
import { ChatsService } from '../../src/modules/chats/service/chats.service';
import { DatabaseService } from '@/shared/database/database.module';
import { UsersService } from '../../src/modules/users/service/users.service';

describe('Direct chat authorization and canonical identity', () => {
  it('uses a stable unordered pair and rejects self chats', () => {
    expect(directPairKey('B', 'a')).toBe('a:b');
    expect(directPairKey('a', 'b')).toBe(directPairKey('b', 'a'));
    expect(() => directPairKey('A', 'a')).toThrow('Self-chat');
  });
  const db = {
    chat: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const users = { requireUsers: jest.fn() };
  const service = new ChatsService(
    new ChatsRepository(db as unknown as DatabaseService),
    users as unknown as UsersService,
  );
  it('rejects creating a chat for two other users before data access', async () => {
    await expect(
      service.create('mallory', 'alice', 'bob'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(users.requireUsers).not.toHaveBeenCalled();
  });
  it('denies both missing and private chats without disclosure', async () => {
    db.chat.findFirst.mockResolvedValue(null);
    await expect(service.members('mallory', 'private')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('protects chat listings against cross-user access', async () => {
    await expect(service.list('mallory', 'alice', 10)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.chat.findMany).not.toHaveBeenCalled();
  });
  it('reuses existing pair', async () => {
    users.requireUsers.mockResolvedValue(undefined);
    db.chat.findUnique.mockResolvedValue({ id: 'chat' });
    await expect(service.create('a', 'a', 'b')).resolves.toEqual({
      chatId: 'chat',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
