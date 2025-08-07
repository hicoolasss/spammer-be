import { Module } from '@nestjs/common';

import { AIModule } from '../../ai/ai.module';
import { FormFillerService } from './form-filler.service';

@Module({
  imports: [AIModule],
  providers: [FormFillerService],
  exports: [FormFillerService],
})
export class FormFillerModule {} 