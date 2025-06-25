import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GeoProfileDocument = GeoProfile & Document;

@Schema({ timestamps: true })
export class GeoProfile {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  geo: string;

  @Prop({ type: String })
  leadKey?: string;

  @Prop({ type: String })
  userAgentKey?: string;

  @Prop({ type: String })
  fbclidKey?: string;

  @Prop({ type: Number })
  leadCount?: number;

  @Prop({ type: Number })
  useAgentCount?: number;

  @Prop({ type: Number })
  fbclidCount?: number;

  @Prop({ required: true })
  createdBy: string;

  createdAt: Date;
  updatedAt: Date;
}

export const GeoProfileSchema = SchemaFactory.createForClass(GeoProfile);
