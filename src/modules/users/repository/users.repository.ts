import { Injectable } from '@nestjs/common';
import { Prisma, User } from '@prisma/client';
import { DatabaseService } from '../../../shared/database/database.module';

@Injectable()
export class UsersRepository {
  constructor(private readonly db: DatabaseService) {}

  async resolveIdentity(data: Prisma.UserCreateInput): Promise<User> {
    try {
      return await this.db.user.upsert({
        where: { firebaseUid: data.firebaseUid },
        update: {},
        create: data,
      });
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.db.user.findUnique({
          where: { firebaseUid: data.firebaseUid },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }
  count(ids: string[]) {
    return this.db.user.count({ where: { id: { in: ids } } });
  }
  updateProfile(
    id: string,
    profile: { displayName?: string; avatarUrl?: string },
  ) {
    return this.db.user.update({ where: { id }, data: profile });
  }
}
