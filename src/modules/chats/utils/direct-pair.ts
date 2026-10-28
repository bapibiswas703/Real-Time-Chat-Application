import { AppError } from '../../../common/errors';
export function directPairKey(userAId: string, userBId: string): string {
  const ids = [userAId.toLowerCase(), userBId.toLowerCase()];
  if (ids[0] === ids[1])
    throw new AppError('INVALID_ARGUMENT', 'Self-chat is not supported');
  return ids.sort().join(':');
}
