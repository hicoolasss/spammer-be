export enum SubscriptionPlan {
  FREE = "free",
  START = "start",
  TEAM = "team",
}

export const DEFAULT_USER_PLAN = {
  name: SubscriptionPlan.FREE,
  endAt: null
}