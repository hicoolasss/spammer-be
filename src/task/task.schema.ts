import { TaskStatus } from '@enums';
import { GeoProfile } from '@geo-profile/geo-profile.schema';
import { TaskResult } from '@interfaces';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type TaskDocument = Task & Document;

@Schema({ timestamps: true })
export class Task {
  @Prop({ required: true })
  url: string;

  @Prop({ type: String, required: true })
  geo: string;

  @Prop({ type: Types.ObjectId, ref: GeoProfile.name, required: true })
  profileId: Types.ObjectId;

  @Prop({ required: true })
  createdBy: string;

  @Prop({ required: true })
  intervalMinutes: number;

  @Prop({ required: true })
  applicationsNumber: number;

  @Prop({ required: true })
  timeFrom: string;

  @Prop({ required: true })
  timeTo: string;

  @Prop({
    type: String,
    enum: Object.values(TaskStatus),
    default: TaskStatus.ACTIVE,
  })
  status: TaskStatus;

  @Prop({ type: Object, default: { total: 0, success: 0 } })
  result: TaskResult;

  createdAt: Date;
  updatedAt: Date;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
