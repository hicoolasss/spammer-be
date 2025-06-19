import { SubscriptionPlan } from "@enums";

export interface UserPlan {
  name: SubscriptionPlan,
  endAt: Date | null,
}
