import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TaskController } from '@task/task.controller';
import { Task, TaskSchema } from '@task/task.schema';
import { TaskService } from '@task/task.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Task.name, schema: TaskSchema },
      { name: GeoProfile.name, schema: GeoProfileSchema },
    ]),
  ],
  controllers: [TaskController],
  providers: [TaskService],
})
export class TaskModule {}
