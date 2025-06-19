import { LogWrapper } from "@utils/LogWrapper";

type JobHandler = (job) => Promise<void>;

export class JobWrapper {
  private readonly logger: LogWrapper;

  constructor(
    private readonly jobName: string,
    private readonly handler: JobHandler
  ) {
    this.logger = new LogWrapper(jobName);
  }

  async execute(job): Promise<void> {
    try {
      await this.logger.info(`Running job: ${this.jobName}`);
      await this.handler(job);
    } catch (error) {
      await this.logger.error(`Error in ${this.jobName} job, error: ${error}`);
    }
  }
}
