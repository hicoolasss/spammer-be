import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Type,
} from '@nestjs/common';

@Injectable()
export class AnyOfGuards implements CanActivate {
  constructor(private readonly guards: Type<CanActivate>[]) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const guardResults = await Promise.all(
      this.guards.map(async (Guard) => {
        const guardInstance = new Guard();

        try {
          return await guardInstance.canActivate(context);
        } catch {
          return false;
        }
      }),
    );

    return guardResults.some((result) => result === true);
  }
}

export function UseAnyOfGuards(...guards: Type<CanActivate>[]) {
  return new AnyOfGuards(guards);
}
