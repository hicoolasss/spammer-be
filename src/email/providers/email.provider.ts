import { sendEmail } from "@_helpers/email.helper";
import { EmailPayload, EmailTask, PlanPayloadStrict } from "@interfaces";
import { Injectable } from "@nestjs/common";
import { LogWrapper } from "@utils/LogWrapper";
import { EmailTemplate } from "src/enums/email.enums";

@Injectable()
export class EmailProvider {
  private readonly logger = new LogWrapper("EmailProvider");
  private emailQueue: EmailTask[] = [];
  private isProcessing = false;

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.emailQueue.length > 0) {
      const { template, recipient, payload } = this.emailQueue.shift()!;

      try {
        const error = await sendEmail(template, recipient, payload);

        if (error) {
          await this.logger.error(`Error sending email: ${error}`);
        }
      } catch (err) {
        await this.logger.error(`Unexpected error sending email: ${err}`);
      }
    }

    this.isProcessing = false;
  }

  async sendEmailVerificationEmail(email: string, token: string): Promise<void> {
    this.enqueueEmail(EmailTemplate.VERIFY_EMAIL, { to: email, subject: "Email verification" }, process.env.CLIENT_URL + `/confirm-email/${token}`);
  }

  async sendResetPasswordEmail(email: string, token: string): Promise<void> {
    this.enqueueEmail(EmailTemplate.RESET_PASSWORD, { to: email, subject: "Reset password" }, process.env.CLIENT_URL + `/reset-password/${token}`);
  }

  async FiveDaysExpirationEmail(email: string, plan: PlanPayloadStrict): Promise<void> {
    this.enqueueEmail(EmailTemplate.PLAN_END_AFTER_FIVE_DAYS, { to: email, subject: "Your plan expires in 5 days" }, plan);
  }

  async OneDayExpirationEmail(email: string, plan: PlanPayloadStrict ): Promise<void> {
    this.enqueueEmail(EmailTemplate.PLAN_END_AFTER_ONE_DAY, { to: email, subject: "Your plan expires in 1 day" }, plan);
  }

  async PlanExpiredEmail(email: string, plan: { name: string }): Promise<void> {
    this.enqueueEmail(EmailTemplate.PLAN_ENDED, { to: email, subject: "Your plan has expired" }, plan);
  }

  private enqueueEmail(template: EmailTemplate, recipient: { to: string; subject: string }, payload: EmailPayload) {
    this.emailQueue.push({ template, recipient, payload });
    this.processQueue();
  }
}
