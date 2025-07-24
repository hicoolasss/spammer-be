import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema()
export class EmailToken {
  @Prop({ required: true })
  email: string;

  @Prop({ required: true })
  token: string;

  @Prop({
    type: Date,
    required: true,
  })
  expiresAt: Date;
}

export type EmailTokenDocument = EmailToken & Document;
export const EmailTokenSchema = SchemaFactory.createForClass(EmailToken);
