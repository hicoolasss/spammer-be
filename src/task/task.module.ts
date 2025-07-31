import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskController } from '@task/task.controller';
import { Task, TaskSchema } from '@task/task.schema';
import { TaskService } from '@task/task.service';

import { JobsModule } from '../jobs/jobs.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
    RedisModule,
    JobsModule,
  ],
  controllers: [TaskController],
  providers: [TaskService],
})
export class TaskModule {}
