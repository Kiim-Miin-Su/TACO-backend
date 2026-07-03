import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module'; // RolesGuard(AuthService) 주입
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';

@Module({
  imports: [AuthModule],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
