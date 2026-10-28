import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../../common/http-auth';
import { DatabaseService } from '../database/database.module';
import { FirebaseService } from '../firebase/firebase.module';
import { RedisService } from '../redis/redis.module';

async function bounded(check: Promise<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly firebase: FirebaseService,
    private readonly redis: RedisService,
  ) {}
  @Get('live') live() {
    return { status: 'ok' };
  }
  @Get('ready') async ready() {
    const results = await Promise.all([
      bounded(this.db.$queryRaw`SELECT 1`),
      bounded(this.firebase.firestore.doc('_health/connectivity').get()),
      bounded(this.redis.client.ping()),
    ]);
    if (results.some((value) => !value))
      throw new ServiceUnavailableException();
    return { status: 'ready' };
  }
}
