import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AuthService } from './service/auth.service';
import { AuthController } from './controller/auth.controller';
@Global()
@Module({
  imports: [UsersModule],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
