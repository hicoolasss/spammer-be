import { createParamDecorator, ExecutionContext } from "@nestjs/common";

export const CurrentUser = createParamDecorator(
  (data: unknown, context: ExecutionContext) => {
    const response = context.switchToHttp().getResponse();
    return response.locals.user;
  },
);
