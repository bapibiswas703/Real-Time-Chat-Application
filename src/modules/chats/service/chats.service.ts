import { Injectable } from '@nestjs/common';
import { ChatsRepository } from '../repository/chats.repository';
import { AppError, assertIdentity } from '../../../common/errors';
import { UsersService } from '../../users/service/users.service';
import { directPairKey } from '../utils/direct-pair';

@Injectable()
export class ChatsService {
  constructor(
    private readonly repository: ChatsRepository,
    private readonly users: UsersService,
  ) {}
  async create(
    actorId: string,
    userAId: string,
    userBId: string,
  ): Promise<{ chatId: string }> {
    if (actorId !== userAId && actorId !== userBId)
      throw new AppError('FORBIDDEN', 'Caller must be a participant');
    const pairKey = directPairKey(userAId, userBId);
    await this.users.requireUsers([userAId, userBId]);
    const chat = await this.repository.findOrCreateDirectPair(
      pairKey,
      userAId,
      userBId,
    );
    return { chatId: chat.id };
  }
  async members(actorId: string, chatId: string): Promise<string[]> {
    const chat = await this.repository.findAccessible(actorId, chatId);
    if (!chat) throw new AppError('FORBIDDEN', 'Chat access denied');
    return chat.participants.map((p) => p.userId);
  }
  async list(actorId: string, userId: string, limit: number, cursor?: string) {
    assertIdentity(actorId, userId);
    if (
      cursor &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        cursor,
      )
    )
      throw new AppError('INVALID_ARGUMENT', 'Invalid cursor');
    const rows = await this.repository.listForUser(userId, limit, cursor);
    const items = rows.slice(0, limit).map((chat) => ({
      chatId: chat.id,
      type: chat.type,
      createdAt: chat.createdAt,
      memberIds: chat.participants.map((p) => p.userId),
    }));
    return {
      items,
      nextCursor: rows.length > limit ? (items.at(-1)?.chatId ?? null) : null,
    };
  }
}
