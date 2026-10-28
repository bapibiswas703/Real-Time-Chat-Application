import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@/config/configuration';
import { DatabaseModule } from '@/shared/database/database.module';
import { FirebaseModule } from '@/shared/firebase/firebase.module';
import { RedisModule } from '@/shared/redis/redis.module';
import { ObservabilityModule } from '@/shared/observability/observability.module';
import { HealthController } from '@/shared/observability/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { ChatsModule } from './modules/chats/chats.module';
import { MessagesModule } from './modules/messages/messages.module';
import { ReadReceiptsModule } from './modules/read-receipts/read-receipts.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { HttpAuthGuard } from '@/common/http-auth';
import { HttpErrorFilter } from '@/common/http-boundary';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    FirebaseModule,
    RedisModule,
    ObservabilityModule,
    AuthModule,
    ChatsModule,
    MessagesModule,
    ReadReceiptsModule,
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: HttpAuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
