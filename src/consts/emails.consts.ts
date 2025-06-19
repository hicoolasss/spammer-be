import { EmailTemplate } from "src/enums/email.enums";

export const SENDERS: Record<EmailTemplate, string> = {
  [EmailTemplate.RESET_PASSWORD]: "TODO-NAME <test@test.org>",
  [EmailTemplate.VERIFY_EMAIL]: "TODO-NAME <test@test.org>",
  [EmailTemplate.PLAN_END_AFTER_FIVE_DAYS]: "TODO-NAME <test@test.org>",
  [EmailTemplate.PLAN_END_AFTER_ONE_DAY]: "TODO-NAME <test@test.org>",
  [EmailTemplate.PLAN_ENDED]: "TODO-NAME <test@test.org>",
};
