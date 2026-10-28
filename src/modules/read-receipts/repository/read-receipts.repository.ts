import { Injectable } from '@nestjs/common';
import { FieldValue, Timestamp, Transaction } from 'firebase-admin/firestore';
import { FirebaseService } from '@/shared/firebase/firebase.module';
import { AppError } from '@/common/errors';
import {
  compareOrder,
  MessageOrder,
  PersistedMessage,
} from '../../messages/utils/message';

@Injectable()
export class ReadReceiptsRepository {
  constructor(private readonly firebase: FirebaseService) {}
  private chat(chatId: string) {
    return this.firebase.firestore.collection('chats').doc(chatId);
  }
  private receipt(chatId: string, messageId: string, userId: string) {
    return this.chat(chatId)
      .collection('readReceipts')
      .doc(`${messageId}_${userId}`);
  }
  async createReceipt(
    tx: Transaction,
    chatId: string,
    messageId: string,
    userId: string,
  ) {
    const ref = this.receipt(chatId, messageId, userId);
    const existing = await tx.get(ref);
    if (!existing.exists)
      tx.create(ref, {
        messageId,
        userId,
        readAt: FieldValue.serverTimestamp(),
      });
  }
  async getReceipt(chatId: string, messageId: string, userId: string) {
    const doc = await this.receipt(chatId, messageId, userId).get();
    return {
      chatId,
      messageId,
      userId,
      readAt: (doc.get('readAt') as Timestamp).toDate().toISOString(),
    };
  }
  async updateLastSeen(
    tx: Transaction,
    chatId: string,
    userId: string,
    message: PersistedMessage,
  ) {
    const ref = this.chat(chatId).collection('userStates').doc(userId);
    const previous = await tx.get(ref);
    if (previous.exists) {
      const comparison = compareOrder(
        message,
        previous.get('order') as MessageOrder,
      );
      if (comparison < 0)
        throw new AppError('CONFLICT', 'Last-seen-message cannot regress');
      if (comparison === 0) return;
    }
    tx.set(ref, {
      lastSeenMessageId: message.id,
      order: {
        seconds: message.seconds,
        nanoseconds: message.nanoseconds,
        id: message.id,
      },
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  async getState(chatId: string, userId: string) {
    const state = await this.chat(chatId)
      .collection('userStates')
      .doc(userId)
      .get();
    return {
      userId,
      lastSeenMessageId: state.exists
        ? String(state.get('lastSeenMessageId'))
        : null,
      lastSeenAt: state.exists
        ? (state.get('lastSeenAt') as Timestamp).toDate().toISOString()
        : null,
    };
  }
  async listReceipts(tx: Transaction, chatId: string, messageId: string) {
    const result = await tx.get(
      this.chat(chatId)
        .collection('readReceipts')
        .where('messageId', '==', messageId)
        .limit(2),
    );
    return {
      items: result.docs.map((doc) => ({
        messageId,
        userId: String(doc.get('userId')),
        readAt: (doc.get('readAt') as Timestamp).toDate().toISOString(),
      })),
    };
  }
}
