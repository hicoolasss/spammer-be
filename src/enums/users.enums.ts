export enum SubscriptionPlan {
  FREE = 'FREE',
  START = 'START',
  TEAM = 'TEAM',
}

export const DEFAULT_USER_PLAN = {
  name: SubscriptionPlan.FREE,
  endAt: null,
};
