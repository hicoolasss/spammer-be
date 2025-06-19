import { EmailTemplate } from "src/enums/email.enums";

export interface PlanPayloadStrict {
  name: string;
  endAt: Date;
}

export interface PlanPayloadNotStrict {
  name: string;
  endAt?: Date;
}

export interface EmailTask {
  template: EmailTemplate;
  recipient: { to: string; subject: string };
  payload: EmailPayload;
}

export type EmailPayload = PlanPayloadNotStrict | string;

export interface EmailDetails {
  to: string;
  subject: string;
}

export interface EmailDataMap {
  [EmailTemplate.RESET_PASSWORD]: string;
  [EmailTemplate.VERIFY_EMAIL]: string;
  [EmailTemplate.PLAN_END_AFTER_FIVE_DAYS]: PlanPayloadStrict;
  [EmailTemplate.PLAN_END_AFTER_ONE_DAY]: PlanPayloadStrict;
  [EmailTemplate.PLAN_ENDED]: { name: string };
}
