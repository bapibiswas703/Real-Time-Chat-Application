import { AuthService } from '../../src/modules/auth/service/auth.service';
import { FirebaseService } from '../../src/shared/firebase/firebase.module';
import { UsersService } from '../../src/modules/users/service/users.service';

describe('Firebase authentication policy', () => {
  const verifyIdToken = jest.fn();
  const resolveIdentity = jest.fn();
  const service = new AuthService(
    { auth: { verifyIdToken } } as unknown as FirebaseService,
    { resolveIdentity } as unknown as UsersService,
  );
  const decoded = {
    uid: 'verified-uid',
    firebase: { sign_in_provider: 'phone' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  beforeEach(() => {
    verifyIdToken.mockReset();
    resolveIdentity.mockReset();
  });
  it('uses verified identity and checks revocation every time', async () => {
    verifyIdToken.mockResolvedValue(decoded);
    resolveIdentity.mockResolvedValue({ id: 'user-id' });
    expect((await service.verify('id-token')).user.id).toBe('user-id');
    expect(verifyIdToken).toHaveBeenCalledWith('id-token', true);
    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'verified-uid' }),
    );
  });
  it.each([
    'auth/id-token-expired',
    'auth/id-token-revoked',
    'auth/user-disabled',
    'auth/invalid-id-token',
  ])('rejects %s', async (code) => {
    verifyIdToken.mockRejectedValue({ code });
    await expect(service.verify('invalid')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
  it('rejects password provider and expired tokens', async () => {
    verifyIdToken.mockResolvedValue({
      ...decoded,
      firebase: { sign_in_provider: 'password' },
    });
    await expect(service.verify('password')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    verifyIdToken.mockResolvedValue({ ...decoded, exp: 0 });
    await expect(service.verify('expired')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
  it('fails closed when Firebase is unavailable', async () => {
    verifyIdToken.mockRejectedValue(new Error('network'));
    await expect(service.verify('token')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
  it('accepts verified Google identities without trusting an unverified email', async () => {
    resolveIdentity.mockResolvedValue({ id: 'google-user' });
    verifyIdToken.mockResolvedValue({
      ...decoded,
      firebase: { sign_in_provider: 'google.com' },
      email: 'unverified@example.com',
      email_verified: false,
    });
    expect((await service.verify('google-token')).user.id).toBe('google-user');
    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ uid: decoded.uid, email: undefined }),
    );
  });
});
