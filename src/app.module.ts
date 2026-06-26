import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { StudentsModule } from './modules/students/students.module';
import { EnrollmentsModule } from './modules/enrollments/enrollments.module';
import { PaymentsModule } from './modules/payments/payments.module';

@Module({
  imports: [
    // infrastructure
    DatabaseModule,
    // feature modules
    AuthModule,
    HealthModule,
    StudentsModule,
    EnrollmentsModule,
    PaymentsModule,
  ],
})
export class AppModule {}
