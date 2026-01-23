import { Solver } from '@2captcha/captcha-solver';
import { Injectable } from '@nestjs/common';
import { LogWrapper } from '@utils';
import { Page } from 'puppeteer';

interface TurnstileParams {
  sitekey: string;
  pageurl: string;
  data?: string;
  pagedata?: string;
  action?: string;
  userAgent?: string;
}

interface CaptchaSolveResult {
  success: boolean;
  token?: string;
  error?: string;
}

const TURNSTILE_INJECT_SCRIPT = `
console.clear = () => console.log('Console was cleared')
const i = setInterval(() => {
    if (window.turnstile) {
        clearInterval(i)
        window.turnstile.render = (a, b) => {
            let params = {
                sitekey: b.sitekey,
                pageurl: window.location.href,
                data: b.cData,
                pagedata: b.chlPageData,
                action: b.action,
                userAgent: navigator.userAgent,
                json: 1
            }
            console.log('intercepted-params:' + JSON.stringify(params))
            window.cfCallback = b.callback
            return
        }
    }
}, 50)
`;

@Injectable()
export class CaptchaService {
  private readonly logger = new LogWrapper(CaptchaService.name);
  private solver: Solver | null = null;

  constructor() {
    const apiKey = process.env.CAPTCHA_2CAPTCHA_API_KEY;
    if (apiKey) {
      this.solver = new Solver(apiKey);
      this.logger.info('[CaptchaService] 2captcha solver initialized');
    } else {
      this.logger.warn('[CaptchaService] CAPTCHA_2CAPTCHA_API_KEY not set, captcha solving disabled');
    }
  }

  getTurnstileInjectScript(): string {
    return TURNSTILE_INJECT_SCRIPT;
  }

  async isChallengePage(page: Page): Promise<boolean> {
    try {
      if (page.isClosed()) return false;

      return await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const body = document.body?.innerText?.toLowerCase() || '';
        return (
          title.includes('just a moment') ||
          body.includes('verify you are human') ||
          body.includes('checking your browser') ||
          body.includes('please wait') ||
          body.includes('one more step')
        );
      });
    } catch {
      return false;
    }
  }

  async solveTurnstileChallenge(
    page: Page,
    taskId: string,
    targetUrl: string,
    overrideSitekey?: string,
    maxAttempts = 2,
  ): Promise<CaptchaSolveResult> {
    const taskPrefix = `[TASK_${taskId}]`;

    if (!this.solver) {
      return { success: false, error: '2captcha solver not configured' };
    }

    let captchaSolved = false;
    let tokenApplied = false;
    let captchaAttempts = 0;
    let solveError: string | null = null;
    let resolvedToken: string | null = null;

    const consoleHandler = async (msg: any) => {
      const txt = msg.text();

      if (txt.includes('intercepted-params:') && !tokenApplied && captchaAttempts < maxAttempts) {
        captchaSolved = true;
        captchaAttempts++;

        this.logger.info(`${taskPrefix} Intercepted Turnstile params (attempt ${captchaAttempts}/${maxAttempts})`);

        try {
          const params: TurnstileParams = JSON.parse(txt.replace('intercepted-params:', ''));

          if (overrideSitekey) {
            params.sitekey = overrideSitekey;
            this.logger.debug(`${taskPrefix} Using override sitekey: ${params.sitekey}`);
          } else {
            this.logger.debug(`${taskPrefix} Using intercepted sitekey: ${params.sitekey}`);
          }

          params.pageurl = targetUrl;

          this.logger.info(`${taskPrefix} Sending captcha to 2captcha...`);
          this.logger.debug(`${taskPrefix} Params: pageurl=${params.pageurl.substring(0, 60)}..., action=${params.action || 'null'}`);

          const res = await this.solver!.cloudflareTurnstile({
            sitekey: params.sitekey,
            pageurl: params.pageurl,
            data: params.data,
            pagedata: params.pagedata,
            action: params.action,
            userAgent: params.userAgent,
          } as any);

          this.logger.info(`${taskPrefix} Captcha solved! ID: ${res.id}`);
          this.logger.debug(`${taskPrefix} Token: ${res.data.substring(0, 50)}...`);

          await page.evaluate((token: string) => {
            if (typeof (window as any).cfCallback === 'function') {
              (window as any).cfCallback(token);
            }
          }, res.data);

          tokenApplied = true;
          resolvedToken = res.data;
          this.logger.info(`${taskPrefix} Turnstile token applied!`);
        } catch (e: any) {
          solveError = e.message || e.err || String(e);
          this.logger.error(`${taskPrefix} 2captcha error: ${solveError}`);
          captchaSolved = false;
        }
      }
    };

    page.on('console', consoleHandler);

    try {
      this.logger.info(`${taskPrefix} Waiting for captcha interception (20s)...`);
      await this.sleep(9999999);

      if (!captchaSolved) {
        this.logger.info(`${taskPrefix} No params intercepted, reloading page...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await this.sleep(20000);
      }

      if (captchaSolved && !tokenApplied) {
        this.logger.info(`${taskPrefix} Waiting for 2captcha solution (max 70s)...`);
        for (let i = 0; i < 70; i++) {
          await this.sleep(1000);

          if (tokenApplied) {
            this.logger.info(`${taskPrefix} Token applied, checking challenge...`);
            await this.sleep(3000);
            break;
          }

          const isChallenge = await this.isChallengePage(page);
          if (!isChallenge) {
            this.logger.info(`${taskPrefix} Challenge passed!`);
            break;
          }

          if (i % 10 === 0 && i > 0) {
            this.logger.debug(`${taskPrefix} Still waiting for solution... (${i}s)`);
          }
        }

        if (!tokenApplied && captchaAttempts < maxAttempts) {
          this.logger.info(`${taskPrefix} Captcha not solved, reloading for retry...`);
          captchaSolved = false;
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          await this.sleep(20000);

          for (let i = 0; i < 70; i++) {
            await this.sleep(1000);
            if (tokenApplied) {
              this.logger.info(`${taskPrefix} Token applied on retry!`);
              await this.sleep(3000);
              break;
            }
            if (i % 10 === 0 && i > 0) {
              this.logger.debug(`${taskPrefix} Retry waiting... (${i}s)`);
            }
          }
        }
      }

      this.logger.info(`${taskPrefix} Final challenge check (60s max)...`);
      for (let i = 0; i < 60; i++) {
        await this.sleep(1000);

        try {
          const isChallenge = await this.isChallengePage(page);
          if (!isChallenge) {
            this.logger.info(`${taskPrefix} Challenge passed!`);
            break;
          }

          if (i % 10 === 0 && i > 0) {
            this.logger.debug(`${taskPrefix} Still on challenge page... (${i}s)`);
          }
        } catch {
          this.logger.debug(`${taskPrefix} Navigation in progress...`);
          await this.sleep(2000);
          break;
        }
      }

      const stillOnChallenge = await this.isChallengePage(page);
      if (stillOnChallenge) {
        return {
          success: false,
          error: solveError || 'Challenge not passed after all attempts',
        };
      }

      return {
        success: true,
        token: resolvedToken || undefined,
      };
    } finally {
      page.off('console', consoleHandler);
    }
  }

  async solveFormTurnstile(
    page: Page,
    taskId: string,
    formSitekey?: string,
  ): Promise<CaptchaSolveResult> {
    const taskPrefix = `[TASK_${taskId}]`;

    if (!this.solver) {
      return { success: false, error: '2captcha solver not configured' };
    }

    this.logger.info(`${taskPrefix} Solving Turnstile on form...`);

    try {
      const detectedSitekey = await page.evaluate(() => {
        const widget = document.querySelector('.cf-turnstile');
        return widget?.getAttribute('data-sitekey') || null;
      });

      const sitekey = formSitekey || detectedSitekey;

      if (!sitekey) {
        this.logger.warn(`${taskPrefix} No Turnstile sitekey found on form`);
        return { success: false, error: 'No sitekey found' };
      }

      const currentUrl = page.url();
      this.logger.info(`${taskPrefix} Form sitekey: ${sitekey}`);
      this.logger.debug(`${taskPrefix} Page URL: ${currentUrl}`);

      const res = await this.solver.cloudflareTurnstile({
        sitekey,
        pageurl: currentUrl,
      } as any);

      this.logger.info(`${taskPrefix} Form captcha solved! ID: ${res.id}`);
      this.logger.debug(`${taskPrefix} Token: ${res.data.substring(0, 50)}...`);

      const applied = await page.evaluate((token: string) => {
        const result: string[] = [];

        const responseInputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
        responseInputs.forEach((input, idx) => {
          (input as HTMLInputElement).value = token;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          result.push(`input-${idx}`);
        });

        const allInputs = document.querySelectorAll('input[id*="response"]');
        allInputs.forEach((input) => {
          if (input.id.includes('cf-chl') || input.id.includes('turnstile')) {
            (input as HTMLInputElement).value = token;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });

        const widget = document.querySelector('.cf-turnstile');
        if (widget) {
          (widget as HTMLElement).setAttribute('data-status', 'solved');
          (widget as HTMLElement).style.opacity = '0.5';
        }

        if (typeof (window as any).tsOk2 === 'function') {
          try {
            (window as any).tsOk2(token);
            result.push('callback-tsOk2');
          } catch {
            result.push('callback-error');
          }
        }

        if ((window as any).turnstile && typeof (window as any).turnstile.getResponse === 'function') {
          try {
            (window as any).turnstile.getResponse = () => token;
            result.push('turnstile-patched');
          } catch { /* empty */ }
        }

        return result.join(', ');
      }, res.data);

      this.logger.info(`${taskPrefix} Form captcha token applied! (${applied})`);

      return {
        success: true,
        token: res.data,
      };
    } catch (e: any) {
      const error = e.message || e.err || String(e);
      this.logger.error(`${taskPrefix} Form captcha error: ${error}`);
      return { success: false, error };
    }
  }

  async checkAndSolveFormCaptcha(page: Page, taskId: string): Promise<boolean> {
    const taskPrefix = `[TASK_${taskId}]`;

    try {
      const hasTurnstile = await page.evaluate(() => {
        return !!document.querySelector('.cf-turnstile') ||
               !!document.querySelector('input[name="cf-turnstile-response"]');
      });

      if (!hasTurnstile) {
        this.logger.debug(`${taskPrefix} No Turnstile widget found on form`);
        return true;
      }

      this.logger.info(`${taskPrefix} Turnstile widget detected on form, solving...`);

      const result = await this.solveFormTurnstile(page, taskId);
      return result.success;
    } catch (e: any) {
      this.logger.error(`${taskPrefix} Error checking form captcha: ${e.message}`);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
