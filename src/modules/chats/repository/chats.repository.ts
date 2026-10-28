import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../../../shared/database/database.module';

@Injectable()
export class ChatsRepository {
  constructor(private readonly db: DatabaseService) {}

  async findOrCreateDirectPair(
    pairKey: string,
    userAId: string,
    userBId: string,
  ) {
    const existing = await this.db.chat.findUnique({
      where: { canonicalDirectPairKey: pairKey },
      select: { id: true },
    });
    if (existing) return existing;
    try {
      return await this.db.$transaction(async (tx) =>
        tx.chat.create({
          data: {
            canonicalDirectPairKey: pairKey,
            participants: {
              create: [{ userId: userAId }, { userId: userBId }],
            },
          },
          select: { id: true },
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.db.chat.findUnique({
          where: { canonicalDirectPairKey: pairKey },
          select: { id: true },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }
  findAccessible(actorId: string, chatId: string) {
    // Missing and inaccessible chats have the same result to avoid disclosure.
    return this.db.chat.findFirst({
      where: { id: chatId, participants: { some: { userId: actorId } } },
      select: { participants: { select: { userId: true } } },
    });
  }
  listForUser(userId: string, limit: number, cursor?: string) {
    return this.db.chat.findMany({
      where: {
        participants: { some: { userId } },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: {
        id: true,
        type: true,
        createdAt: true,
        participants: { select: { userId: true } },
      },
    });
  }
}
