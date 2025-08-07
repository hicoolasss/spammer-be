import { CountryCode } from '@enums';
import { LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { TaskDocument } from '@task/task.schema';
import { LogWrapper, TaskLogger } from '@utils';
import { Page } from 'puppeteer';

import { AIService } from '../../ai/ai.service';
import { checkSuccessIndicators } from '../../utils/success-indicators';

export interface FormField {
  selector: string;
  type: 'name' | 'surname' | 'phone' | 'email' | 'checkbox';
  confidence: number;
}

export interface FormAnalysis {
  bestForm: {
    formIndex: number;
    fields: FormField[];
    checkboxes?: Array<{ selector: string; label?: string; confidence: number }>;
  };
}

@Injectable()
export class FormFillerService {
  private readonly logger = new LogWrapper(FormFillerService.name);

  constructor(private readonly aiService: AIService) {}

  async fillForm(
    page: Page,
    leadData: LeadData,
    task: TaskDocument,
    geo: CountryCode,
    taskId?: string,
  ): Promise<string | null> {
    const taskLogger = taskId ? new TaskLogger(FormFillerService.name, taskId) : this.logger;
    taskLogger.info('Filling form');

    if (page.isClosed()) {
      taskLogger.warn('Page is closed, skipping form filling');
      return null;
    }

    try {
      await this.prepareForm(page);

      const beforeSubmitUrl = page.url();

      if (task.isQuiz) {
        await this.fillQuizForm(page, leadData);
      } else {
        await this.fillRegularForm(page, leadData);
      }

      const afterSubmitUrl = await this.waitForFormSubmission(page, beforeSubmitUrl, geo);
      return afterSubmitUrl;
    } catch (error) {
      taskLogger.error(`Error filling form: ${error.message}`);
      return null;
    }
  }

  private async prepareForm(page: Page): Promise<void> {
    const prePause = Math.random() * 3_000;
    this.logger.info(`Pause before filling form: ${prePause.toFixed(0)}ms`);
    await this.sleep(prePause);

    await this.performRandomClicks(page);
    await this.scrollToForm(page);
    await this.sleep(1_000 + Math.random() * 1_000);
  }

  private async performRandomClicks(page: Page): Promise<void> {
    const randomClicks = 1 + Math.floor(Math.random() * 2);

    for (let i = 0; i < randomClicks; i++) {
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div, p, span, section, article'));
        const candidates = all.filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            (el as HTMLElement).offsetParent !== null &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            el.clientHeight > 10 &&
            el.clientWidth > 10
          );
        });

        if (candidates.length > 0) {
          const el = candidates[Math.floor(Math.random() * candidates.length)] as HTMLElement;
          const rect = el.getBoundingClientRect();
          (window as any).__lastRandomClick = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          };
          el.click();
        }
      });

      if (page.mouse && page.evaluate) {
        const pos = await page.evaluate(
          () => (window as any).__lastRandomClick || { x: 100, y: 100 },
        );
        await page.mouse.move(pos.x, pos.y, { steps: 10 });
      }

      await this.sleep(400 + Math.random() * 600);
    }
  }

  private async scrollToForm(page: Page): Promise<void> {
    await page.evaluate(() => {
      const forms = document.querySelectorAll('form');
      if (forms.length > 0) {
        forms[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  private async fillQuizForm(page: Page, leadData: LeadData): Promise<void> {
    this.logger.info('This is a quiz task, using JavaScript code generation approach');

    try {
      const formsHtml = await this.aiService.extractFormHtml(page);
      if (!formsHtml.trim()) {
        throw new Error('No forms found on the page');
      }

      const jsCode = await this.aiService.generateFormFillScript(formsHtml, leadData);
      this.logger.info('Generated JavaScript code for quiz form filling');

      await page.evaluate(jsCode);
      this.logger.info('Executed JavaScript code for quiz form filling');
    } catch (quizError) {
      this.logger.error(
        `Quiz form filling failed: ${quizError.message}, falling back to regular method`,
      );
      throw quizError;
    }
  }

  private async fillRegularForm(page: Page, leadData: LeadData): Promise<void> {
    const analysis = await this.analyzeForm(page);

    if (!analysis.bestForm || analysis.bestForm.fields.length === 0) {
      throw new Error('Could not identify suitable form fields');
    }

    this.logger.info(
      `Selected form #${analysis.bestForm.formIndex} with ${analysis.bestForm.fields.length} fields`,
    );

    await this.highlightSelectedForm(page, analysis.bestForm.formIndex);
    await this.fillFormFields(page, analysis.bestForm.fields, leadData);
    await this.handleCheckboxes(page, analysis.bestForm.checkboxes);
    await this.submitForm(page, analysis.bestForm.formIndex);
  }

  private async analyzeForm(page: Page): Promise<FormAnalysis> {
    try {
      const formsHtml = await this.aiService.extractFormHtml(page);
      if (!formsHtml.trim()) {
        throw new Error('No forms found on the page');
      }
      return (await this.aiService.analyzeForms(formsHtml)) as FormAnalysis;
    } catch (aiError) {
      this.logger.warn(`AI analysis failed: ${aiError.message}, trying fallback method`);
      try {
        return (await this.aiService.analyzeFormsFallback(page)) as FormAnalysis;
      } catch (fallbackError) {
        throw new Error(`Both AI and fallback analysis failed: ${fallbackError.message}`);
      }
    }
  }

  private async highlightSelectedForm(page: Page, formIndex: number): Promise<void> {
    await page.evaluate((formIndex) => {
      const forms = Array.from(document.querySelectorAll('form'));
      const form = forms[formIndex];
      if (form) {
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, formIndex);
    await this.sleep(1_500 + Math.random() * 1_000);
  }

  private async fillFormFields(page: Page, fields: FormField[], leadData: LeadData): Promise<void> {
    for (const field of fields) {
      if (page.isClosed()) {
        this.logger.warn('Page is closed, stopping form filling');
        return;
      }

      if (field.type === 'checkbox') {
        continue;
      }

      const value = this.getFieldValue(field.type, leadData);
      if (!value) {
        this.logger.error(`No value for field type: ${field.type}, skipping`);
        throw new Error(`No value for field type: ${field.type}, cannot fill form`);
      }

      await this.fillField(page, field, value);
    }
  }

  private getFieldValue(fieldType: string, leadData: LeadData): string {
    switch (fieldType) {
      case 'name':
        return leadData.name;
      case 'surname':
        return leadData.lastname;
      case 'phone':
        return leadData.phone;
      case 'email':
        return leadData.email;
      default:
        return '';
    }
  }

  private async fillField(page: Page, field: FormField, value: string): Promise<void> {
    const fieldExists = await page.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return true;
      }
      return false;
    }, field.selector);

    if (!fieldExists) {
      this.logger.warn(`Field not found: ${field.selector}, skipping`);
      return;
    }

    await this.sleep(500 + Math.random() * 500);
    await this.simulateMouseMovement(page, field.selector);

    if (Math.random() < 0.2) {
      await this.sleep(600 + Math.random() * 800);
    }

    const typingConfig = this.getTypingConfig(field.type);
    await this.fillFieldWithTyping(page, field.selector, value, typingConfig);

    this.logger.info(
      `✅ Filled field ${field.selector} (${field.type}) with value: ${value} (confidence: ${field.confidence})`,
    );
    await this.simulateFieldTransition(page);
  }

  private getTypingConfig(fieldType: string) {
    const baseConfig = {
      baseDelay: 1_000,
      typingSpeed: 15,
      typoChance: 0.2,
      pauseChance: 0.2,
      pauseDuration: { min: 500, max: 1_000 },
    };

    switch (fieldType) {
      case 'email':
        return {
          ...baseConfig,
          icon: '📧',
          baseDelay: 800,
          typingSpeed: 14,
          pauseChance: 0.55,
          pauseDuration: { min: 800, max: 1_500 },
        };
      case 'phone':
        return {
          ...baseConfig,
          icon: '📞',
          baseDelay: 1200,
          typingSpeed: 23,
          pauseChance: 0.5,
          typoChance: 0,
          pauseDuration: { min: 800, max: 1_500 },
        };
      case 'name':
        return {
          ...baseConfig,
          icon: '👤',
          baseDelay: 1500,
          typingSpeed: 16,
          pauseChance: 0.35,
          pauseDuration: { min: 800, max: 1_500 },
        };
      case 'surname':
        return {
          ...baseConfig,
          icon: '👤',
          baseDelay: 1_500,
          typingSpeed: 18,
          pauseChance: 0.45,
          pauseDuration: { min: 800, max: 1_500 },
        };
      default:
        return {
          ...baseConfig,
          icon: '❓',
          baseDelay: 1_000,
          typingSpeed: 20,
        };
    }
  }

  private async fillFieldWithTyping(
    page: Page,
    selector: string,
    value: string,
    config: any,
  ): Promise<void> {
    await this.prepareField(page, selector);

    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      await this.addCharacter(page, selector, char);

      const totalDelay = config.baseDelay + Math.random() * config.typingSpeed;
      await this.sleep(totalDelay);

      if (Math.random() < config.typoChance && i < value.length - 1) {
        await this.simulateTypo(page, selector);
      }

      if (Math.random() < config.pauseChance && i < value.length - 1) {
        const pauseDelay =
          config.pauseDuration.min +
          Math.random() * (config.pauseDuration.max - config.pauseDuration.min);
        await this.sleep(pauseDelay);
      }
    }
  }

  private async prepareField(page: Page, selector: string): Promise<void> {
    await page.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      if (element) {
        element.focus();
        element.click();
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);
    await this.sleep(200 + Math.random() * 300);
  }

  private async addCharacter(page: Page, selector: string, char: string): Promise<void> {
    await page.evaluate(
      (selector, char) => {
        const element = document.querySelector(selector) as HTMLInputElement;
        if (element) {
          element.value += char;
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
      },
      selector,
      char,
    );
  }

  private async simulateTypo(page: Page, selector: string): Promise<void> {
    const typoChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
    await this.addCharacter(page, selector, typoChar);
    await this.sleep(200 + Math.random() * 300);

    await page.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLInputElement;
      if (element) {
        element.value = element.value.slice(0, -1);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, selector);
    await this.sleep(150 + Math.random() * 200);
  }

  private async simulateMouseMovement(page: Page, selector: string): Promise<void> {
    if (!page.mouse) return;

    try {
      const rect = await page.evaluate((selector) => {
        const el = document.querySelector(selector) as HTMLElement;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, selector);

      if (rect) {
        const steps = 10 + Math.floor(Math.random() * 10);
        await page.mouse.move(rect.x, rect.y, { steps });
        await this.sleep(100 + Math.random() * 300);
      }
    } catch (error) {
      this.logger.debug(`Failed to move mouse to field: ${error.message}`);
    }
  }

  private async simulateFieldTransition(page: Page): Promise<void> {
    const basePause = 800 + Math.random() * 1200;
    const readingPause = Math.random() < 0.2 ? 500 + Math.random() * 1_000 : 0;
    const quickPause = Math.random() < 0.1 ? Math.random() * 300 : 0;
    const totalPause = basePause + readingPause + quickPause;

    if (Math.random() < 0.1) {
      await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('div, p, span, section, article'));
        const candidates = all.filter((el) => {
          const style = window.getComputedStyle(el);
          return (
            (el as HTMLElement).offsetParent !== null &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            el.clientHeight > 10 &&
            el.clientWidth > 10
          );
        });
        if (candidates.length > 0) {
          const el = candidates[Math.floor(Math.random() * candidates.length)] as HTMLElement;
          el.click();
        }
      });

      if (page.mouse && page.evaluate) {
        const pos = await page.evaluate(
          () => (window as any).__lastRandomClick || { x: 100, y: 100 },
        );
        await page.mouse.move(pos.x, pos.y, { steps: 10 });
      }

      await this.sleep(400 + Math.random() * 600);
    }

    await this.sleep(totalPause);
  }

  private async handleCheckboxes(
    page: Page,
    checkboxes: Array<{ selector: string; label?: string; confidence: number }> | undefined,
  ): Promise<void> {
    if (!checkboxes?.length) return;

    for (const cb of checkboxes) {
      try {
        const isChecked = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLInputElement;
          return el?.checked === true;
        }, cb.selector);

        if (!isChecked) {
          await this.simulateMouseMovement(page, cb.selector);
          await this.sleep(300 + Math.random() * 700);
          await page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLInputElement;
            el?.click();
          }, cb.selector);

          this.logger.info(
            `✅ Checked checkbox ${cb.selector}` +
              (cb.label ? ` (${cb.label})` : '') +
              ` — confidence: ${cb.confidence}`,
          );

          await this.sleep(400 + Math.random() * 600);
        }
      } catch (err) {
        this.logger.warn(`Failed to check checkbox ${cb.selector}: ${err.message}`);
      }
    }
  }

  private async submitForm(page: Page, formIndex: number): Promise<void> {
    const submitResult = await page.evaluate((formIndex) => {
      const forms = Array.from(document.querySelectorAll('form'));
      const form = forms[formIndex];
      if (!form) return 'form_not_found';

      let submitButton = form.querySelector('button[type="submit"], input[type="submit"]') as
        | HTMLButtonElement
        | HTMLInputElement;

      if (!submitButton) {
        const buttons = Array.from(form.querySelectorAll('button'));
        submitButton = buttons.find((btn) => {
          const text = btn.textContent?.toLowerCase() || '';
          return (
            text.includes('submit') ||
            text.includes('send') ||
            text.includes('отправить') ||
            text.includes('подтвердить')
          );
        }) as HTMLButtonElement;
      }

      if (submitButton && (submitButton as HTMLElement).offsetParent !== null) {
        (submitButton as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(
          () => {
            (submitButton as HTMLElement).click();
          },
          1_000 + Math.random() * 1_000,
        );
        return 'clicked_submit_button';
      } else {
        setTimeout(
          () => {
            form.submit();
          },
          1_000 + Math.random() * 1_000,
        );
        return 'called_form_submit';
      }
    }, formIndex);

    this.logger.info(`🎉 Form submit result: ${submitResult}`);
  }

  private async waitForFormSubmission(
    page: Page,
    beforeSubmitUrl: string,
    geo: CountryCode,
  ): Promise<string | null> {
    await this.sleep(2_000 + Math.random() * 1_000);

    const navigationResult = await this.waitForNavigationReliable(page, beforeSubmitUrl, geo);
    let { navigationDetected, afterUrl: afterSubmitUrl } = navigationResult;

    await this.sleep(45_000);

    const finalUrl = page.url();
    if (finalUrl !== beforeSubmitUrl) {
      afterSubmitUrl = finalUrl;
      navigationDetected = true;
      this.logger.info(`✅ Final URL change detected: ${afterSubmitUrl}`);
    }

    if (!navigationDetected) {
      this.logger.info(`ℹ️ No navigation detected, but form submission completed`);
    }

    return afterSubmitUrl;
  }

  private async waitForNavigationReliable(
    page: Page,
    beforeUrl: string,
    geo: CountryCode,
  ): Promise<{ navigationDetected: boolean; afterUrl: string }> {
    let navigationDetected = false;
    let afterUrl = beforeUrl;

    try {
      await page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: 3_000,
      });
      navigationDetected = true;
      afterUrl = page.url();
      this.logger.info(`✅ Immediate navigation detected: ${afterUrl}`);
      return { navigationDetected, afterUrl };
    } catch {
      this.logger.debug('No immediate navigation, trying alternative methods...');
    }

    await this.sleep(2_000);
    const currentUrl = page.url();
    if (currentUrl !== beforeUrl) {
      navigationDetected = true;
      afterUrl = currentUrl;
      this.logger.info(`✅ Delayed URL change detected: ${afterUrl}`);
      return { navigationDetected, afterUrl };
    }

    if (geo) {
      try {
        const successIndicators = await checkSuccessIndicators(page, geo);
        if (successIndicators.hasSuccessIndicators) {
          this.logger.info(
            `✅ Success indicators found for geo ${geo}: ${successIndicators.indicators.join(', ')}`,
          );
          navigationDetected = true;
          return { navigationDetected, afterUrl };
        }
      } catch (indicatorError) {
        this.logger.debug(`Error checking success indicators: ${indicatorError.message}`);
      }
    }

    await this.sleep(3_000);
    const finalUrl = page.url();
    if (finalUrl !== beforeUrl) {
      navigationDetected = true;
      afterUrl = finalUrl;
      this.logger.info(`✅ Final URL change detected: ${afterUrl}`);
      return { navigationDetected, afterUrl };
    }

    this.logger.info(`ℹ️ No navigation detected, but form submission completed`);
    return { navigationDetected: false, afterUrl };
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
