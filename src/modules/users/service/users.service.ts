import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { UsersRepository } from '../repository/users.repository';
import { AppError } from '../../../common/errors';

export interface VerifiedProfile {
  uid: string;
  name?: string;
  phoneNumber?: string;
  email?: string;
  avatarUrl?: string;
}
@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository) {}
  async resolveIdentity(profile: VerifiedProfile): Promise<User> {
    return this.repository.resolveIdentity({
      firebaseUid: profile.uid,
      displayName: profile.name?.trim().slice(0, 80) || 'Chat user',
      phoneNumber: profile.phoneNumber?.slice(0, 32),
      email: profile.email?.slice(0, 320),
      avatarUrl: profile.avatarUrl?.startsWith('https://')
        ? profile.avatarUrl.slice(0, 2048)
        : null,
    });
  }
  async requireUsers(ids: string[]): Promise<void> {
    if ((await this.repository.count(ids)) !== ids.length)
      throw new AppError('NOT_FOUND', 'Participant not found');
  }
  async updateProfile(
    id: string,
    profile: { displayName?: string; avatarUrl?: string },
  ): Promise<User> {
    return this.repository.updateProfile(id, profile);
  }
}
