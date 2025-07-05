import { Module } from '@nestjs/common';
import { TaskController } from '@task/task.controller';
import { TaskService } from '@task/task.service';
import { MongooseModule } from '@nestjs/mongoose';
import { Task, TaskSchema } from '@task/task.schema';
import { GeoProfile, GeoProfileSchema } from '@geo-profile/geo-profile.schema';

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
