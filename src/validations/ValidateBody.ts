import { ValidationOptions } from "@interfaces";
import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from "@nestjs/common";

export const ValidateBody = (fieldName: string, options: ValidationOptions) =>
  createParamDecorator((_, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const body = request.body;

    const { customValidator, defaultValue, enumValues } = options;

    const value = body[fieldName];

    if (!value && defaultValue) {
      return defaultValue;
    }

    if (!value) {
      throw new BadRequestException(`Field '${fieldName}' is required.`);
    }

    if (enumValues && !enumValues.includes(value)) {
      throw new BadRequestException(
        `Incorrect value for '${fieldName}': ${value}.`
      );
    }

    if (customValidator && !customValidator(value)) {
      throw new BadRequestException(
        `Field '${fieldName}' failed custom validation.`
      );
    }

    return value;
  })();
