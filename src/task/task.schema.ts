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

  @Prop({ type: Types.ObjectId, ref: GeoProfile.name, required: false })
  profileId?: Types.ObjectId;

  @Prop({ required: true })
  createdBy: string;

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
      redirects: {
        type: [
          {
            url: { type: String, required: true },
            at: { type: Date, required: true },
          },
        ],
        default: [],
      },
    },
    default: { total: 0, redirects: [] },
  })
  result: TaskResult;

  @Prop({ type: Date, default: null })
  lastRunAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

export const TaskSchema = SchemaFactory.createForClass(Task);
