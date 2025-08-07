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
  timeFrom: string;

  @Prop({ required: true })
  timeTo: string;

  @Prop({
    type: String,
    enum: Object.values(TaskStatus),
    default: TaskStatus.ACTIVE,
  })
  status: TaskStatus;

  @Prop({ type: Boolean, default: false })
  isRunning: boolean;

  @Prop({ type: Boolean, default: false })
  shouldClickRedirectLink: boolean;

  @Prop({ type: Boolean, default: false })
  isQuiz: boolean;

  @Prop({
    type: {
      total: { type: Number, default: 0 },
      success: { type: Object, default: {} },
      failed: { type: Object, default: {} },
      visitedUrls: { type: [String], default: [] },
      finalUrls: { type: [String], default: [] },
      lastExecution: {
        timestamp: { type: Date },
        finalUrl: { type: String },
        success: { type: Boolean },
        error: { type: String },
      },
    },
    default: {
      total: 0,
      success: {},
      failed: {},
      visitedUrls: [],
      finalUrls: [],
    },
  })
  result: TaskResult;

  @Prop({ type: Date, default: null })
  lastRunAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
