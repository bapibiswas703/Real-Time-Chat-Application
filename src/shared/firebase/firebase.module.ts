import {
  Global,
  Inject,
  Injectable,
  Module,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  App,
  applicationDefault,
  deleteApp,
  initializeApp,
} from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { AppConfig, CONFIG } from '@/config/configuration';
import { randomUUID } from 'node:crypto';

@Injectable()
export class FirebaseService implements OnModuleDestroy {
  private readonly app: App;
  readonly auth: Auth;
  readonly firestore: Firestore;
  constructor(@Inject(CONFIG) config: AppConfig) {
    this.app = initializeApp(
      {
        projectId: config.projectId,
        ...(process.env.FIREBASE_AUTH_EMULATOR_HOST &&
        process.env.FIRESTORE_EMULATOR_HOST
          ? {}
          : { credential: applicationDefault() }),
      },
      `chat-${process.pid}-${randomUUID()}`,
    );
    this.auth = getAuth(this.app);
    this.firestore = getFirestore(this.app);
  }
  async onModuleDestroy(): Promise<void> {
    await this.firestore.terminate();
    await deleteApp(this.app);
  }
}
@Global()
@Module({ providers: [FirebaseService], exports: [FirebaseService] })
export class FirebaseModule {}
