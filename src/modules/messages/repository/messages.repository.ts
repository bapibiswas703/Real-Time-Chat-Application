import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  DocumentSnapshot,
  FieldPath,
  FieldValue,
  Timestamp,
  Transaction,
} from 'firebase-admin/firestore';
import { FirebaseService } from '../../../shared/firebase/firebase.module';
import { AppError } from '../../../common/errors';
import { decodeCursor, encodeCursor, PersistedMessage } from '../utils/message';

@Injectable()
export class MessagesRepository {
  constructor(private readonly firebase: FirebaseService) {}
  private collection(chatId: string) {
    return this.firebase.firestore
      .collection('chats')
      .doc(chatId)
      .collection('messages');
  }
  fromSnapshot(chatId: string, snapshot: DocumentSnapshot): PersistedMessage {
    if (!snapshot.exists) throw new AppError('NOT_FOUND', 'Message not found');
    const data = snapshot.data()!;
    const time = data.createdAt as unknown;
    if (!(time instanceof Timestamp))
      throw new AppError('UNAVAILABLE', 'Message timestamp unavailable; retry');
    return {
      id: snapshot.id,
      chatId,
      senderId: String(data.senderId),
      text: String(data.text),
      createdAt: time.toDate().toISOString(),
      seconds: time.seconds,
      nanoseconds: time.nanoseconds,
      clientRequestId:
        typeof data.clientRequestId === 'string' ? data.clientRequestId : null,
      schemaVersion: 1,
    };
  }
  async send(
    chatId: string,
    senderId: string,
    text: string,
    clientRequestId?: string,
  ): Promise<PersistedMessage> {
    const id = clientRequestId
      ? createHash('sha256')
          .update(`${senderId}:${clientRequestId}`)
          .digest('hex')
      : randomUUID();
    const ref = this.collection(chatId).doc(id);
    await this.firebase.firestore.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists) {
        if (
          existing.get('senderId') !== senderId ||
          existing.get('text') !== text ||
          existing.get('clientRequestId') !== clientRequestId
        )
          throw new AppError(
            'CONFLICT',
            'Idempotency key already used with different content',
          );
        return;
      }
      tx.create(ref, {
        senderId,
        text,
        createdAt: FieldValue.serverTimestamp(),
        clientRequestId: clientRequestId ?? null,
        schemaVersion: 1,
      });
    });
    return this.fromSnapshot(chatId, await ref.get());
  }
  async list(chatId: string, limit: number, cursor?: string) {
    let query = this.collection(chatId)
      .orderBy('createdAt', 'asc')
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(limit + 1);
    if (cursor) {
      const order = decodeCursor(chatId, cursor);
      query = query.startAfter(
        new Timestamp(order.seconds, order.nanoseconds),
        order.id,
      );
    }
    const snapshot = await query.get();
    const items = snapshot.docs
      .slice(0, limit)
      .map((doc) => this.fromSnapshot(chatId, doc));
    const syncCursor = items.length
      ? encodeCursor(chatId, items[items.length - 1]!)
      : (cursor ?? null);
    return {
      items,
      nextCursor: snapshot.size > limit ? syncCursor : null,
      syncCursor,
    };
  }
  async withMessage<T>(
    chatId: string,
    messageId: string,
    operation: (tx: Transaction, message: PersistedMessage) => Promise<T>,
  ): Promise<T> {
    return this.firebase.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.collection(chatId).doc(messageId));
      return operation(tx, this.fromSnapshot(chatId, snapshot));
    });
  }
}
