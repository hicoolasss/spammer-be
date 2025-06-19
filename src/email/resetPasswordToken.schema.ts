import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

@Schema()
export class ResetPasswordToken {
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

export type ResetPasswordTokenDocument = HydratedDocument<ResetPasswordToken>;
export const ResetPasswordTokenSchema =
  SchemaFactory.createForClass(ResetPasswordToken);
