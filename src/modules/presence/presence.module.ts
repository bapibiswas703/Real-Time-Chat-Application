import { Module } from '@nestjs/common';
import { PresenceService } from './service/presence.service';
@Module({ providers: [PresenceService], exports: [PresenceService] })
export class PresenceModule {}
