import { SENDERS } from "@consts";
import { EmailDataMap, EmailDetails, PlanPayloadStrict } from "@interfaces";
import { Resend } from "resend";
import { EmailTemplate,  } from "src/enums/email.enums";
import { FiveDaysPlanExpirationTemplate } from "templates/email/FiveDaysPlanExpirationTemplate";
import { OneDayPlanExpirationTemplate } from "templates/email/OneDaysPlanExpirationTemplate";
import { PlanExpiredTemplate } from "templates/email/PlanExpiredTemplate";
import { ResetPasswordTemplate } from "templates/email/reset-passwordTemplate";
import { VerifyEmailTemplate } from "templates/email/VerifyEmailTemplate";

const resend = new Resend(process.env.RESEND_KEY || "re_123");

const templates: {
  [K in EmailTemplate]: (data: EmailDataMap[K]) => string;
} = {
  [EmailTemplate.RESET_PASSWORD]: (link: string) => ResetPasswordTemplate(link),
  [EmailTemplate.VERIFY_EMAIL]: (link: string) => VerifyEmailTemplate(link),
  [EmailTemplate.PLAN_END_AFTER_FIVE_DAYS]: (plan: PlanPayloadStrict) =>
    FiveDaysPlanExpirationTemplate(plan),
  [EmailTemplate.PLAN_END_AFTER_ONE_DAY]: (plan: PlanPayloadStrict) => 
    OneDayPlanExpirationTemplate(plan),
  [EmailTemplate.PLAN_ENDED]: (plan: { name: string }) =>
    PlanExpiredTemplate(plan.name),
};

const getSender = (template: EmailTemplate): string => {
  return SENDERS[template] || "TODO <test@todo.org>";
};

export const sendEmail = async <T extends EmailTemplate>(
  template: T,
  details: EmailDetails,
  emailData: EmailDataMap[T]
): Promise<{ error: Error }> => {
  try {
    await resend.emails.send({
      from: getSender(template),
      ...details,
      react: templates[template](emailData),
    });
  } catch (error) {
    return error;
  }
};
