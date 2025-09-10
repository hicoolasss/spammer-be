import { CountryCode } from "@enums";
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

@Schema()
export class GeoRegions extends Document {
  @Prop({
    type: String,
    enum: CountryCode,
    required: true,
    unique: true,
  })
  name: CountryCode;

  @Prop({ required: false })
  username?: string;

  @Prop({ required: false })
  password?: string;

  @Prop({ required: false })
  port?: number;

  @Prop({ required: false })
  host?: string;
}

export const GeoRegionsSchema = SchemaFactory.createForClass(GeoRegions);
