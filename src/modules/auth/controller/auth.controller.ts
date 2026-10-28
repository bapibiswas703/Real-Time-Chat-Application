import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { Actor } from '../../../common/http-auth';
import { UsersService } from '../../users/service/users.service';
import { ProfileDto } from '../dto/profile.dto';

export function publicProfile(user: User) {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
@ApiTags('Authentication')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly users: UsersService) {}
  @Post('session') session(@Actor() user: User) {
    return publicProfile(user);
  }
  @Get('me') me(@Actor() user: User) {
    return publicProfile(user);
  }
  @Patch('profile') async profile(
    @Actor() user: User,
    @Body() body: ProfileDto,
  ) {
    return publicProfile(await this.users.updateProfile(user.id, body));
  }
}
