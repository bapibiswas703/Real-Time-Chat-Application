import { UsersRepository } from '../../src/modules/users/repository/users.repository';
import { Prisma } from '@prisma/client';
import { UsersService } from '../../src/modules/users/service/users.service';
import { DatabaseService } from '../../src/shared/database/database.module';

describe('Verified user mapping', () => {
  const db = {
    user: { upsert: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  };
  const users = new UsersService(
    new UsersRepository(db as unknown as DatabaseService),
  );
  beforeEach(() => {
    db.user.upsert.mockReset();
    db.user.findUnique.mockReset();
  });
  it('creates only by verified Firebase UID without email/phone merge', async () => {
    db.user.upsert.mockResolvedValue({ id: 'first-user' });
    const profile = {
      uid: 'firebase-uid',
      email: 'verified@example.com',
      name: 'Alice',
    };
    await users.resolveIdentity(profile);
    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { firebaseUid: 'firebase-uid' },
        update: {},
        create: expect.objectContaining({
          firebaseUid: 'firebase-uid',
          displayName: 'Alice',
          email: profile.email,
        }),
      }),
    );
  });
  it('resolves a concurrent first-login uniqueness loser to the winner', async () => {
    db.user.upsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: '7',
      }),
    );
    db.user.findUnique.mockResolvedValue({ id: 'winner' });
    await expect(users.resolveIdentity({ uid: 'same-uid' })).resolves.toEqual({
      id: 'winner',
    });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { firebaseUid: 'same-uid' },
    });
  });
  it('does not hide database outages as successful registration', async () => {
    db.user.upsert.mockRejectedValue(new Error('database unavailable'));
    await expect(users.resolveIdentity({ uid: 'uid' })).rejects.toThrow(
      'database unavailable',
    );
  });
});
