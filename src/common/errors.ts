export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE';
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export function assertIdentity(actorId: string, claimedId: string): void {
  if (actorId !== claimedId)
    throw new AppError(
      'FORBIDDEN',
      'Identity does not match authenticated user',
    );
}
export const errorStatus: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};
