import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { DecodedIdToken } from 'firebase-admin/auth';
import { AppError } from '@/common/errors';
import { FirebaseService } from '@/shared/firebase/firebase.module';
import { UsersService } from '../../users/service/users.service';

export interface AuthenticatedIdentity {
  user: User;
  expiresAt: number;
}
@Injectable()
export class AuthService {
  constructor(
    private readonly firebase: FirebaseService,
    private readonly users: UsersService,
  ) {}
  async verify(token: string): Promise<AuthenticatedIdentity> {
    if (!token || token.length > 8192)
      throw new AppError('UNAUTHENTICATED', 'Invalid authentication');
    let decoded: DecodedIdToken;
    try {
      decoded = await this.firebase.auth.verifyIdToken(token, true);
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (
        code &&
        [
          'auth/id-token-expired',
          'auth/id-token-revoked',
          'auth/user-disabled',
          'auth/user-not-found',
          'auth/argument-error',
          'auth/invalid-id-token',
          'auth/invalid-argument',
        ].includes(code)
      )
        throw new AppError('UNAUTHENTICATED', 'Invalid authentication');
      throw new AppError('UNAVAILABLE', 'Authentication unavailable');
    }
    if (!['phone', 'google.com'].includes(decoded.firebase.sign_in_provider))
      throw new AppError(
        'UNAUTHENTICATED',
        'Unsupported authentication provider',
      );
    if (decoded.exp * 1000 <= Date.now())
      throw new AppError('UNAUTHENTICATED', 'Invalid authentication');
    const user = await this.users.resolveIdentity({
      uid: decoded.uid,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
      phoneNumber: decoded.phone_number,
      email: decoded.email_verified ? decoded.email : undefined,
      avatarUrl:
        typeof decoded.picture === 'string' ? decoded.picture : undefined,
    });
    return { user, expiresAt: decoded.exp * 1000 };
  }
}
