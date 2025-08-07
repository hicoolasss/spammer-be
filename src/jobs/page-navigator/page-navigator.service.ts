import { Injectable } from '@nestjs/common';
import { LogWrapper, TaskLogger } from '@utils';
import { Page } from 'puppeteer';

export interface NavigationResult {
  finalUrl: string;
  visitedUrls: string[];
}

@Injectable()
export class PageNavigatorService {
  private readonly logger = new LogWrapper(PageNavigatorService.name);

  async navigateToTarget(
    page: Page, 
    targetUrl: string, 
    shouldClickRedirectLink: boolean,
    taskId?: string
  ): Promise<NavigationResult> {
    const taskLogger = taskId ? new TaskLogger(PageNavigatorService.name, taskId) : this.logger;
    const visitedUrls: string[] = [];
    
    taskLogger.info(`Navigating to: ${targetUrl}`);

    const effectivePage = await this.navigateToUrl(page, targetUrl, visitedUrls);
    
    if (shouldClickRedirectLink) {
      await this.handleRedirectLink(effectivePage, taskLogger);
    }
    
    await this.simulateUserBehavior(effectivePage, taskLogger);
    
    return {
      finalUrl: effectivePage.url(),
      visitedUrls,
    };
  }

  private async navigateToUrl(page: Page, url: string, visitedUrls: string[]): Promise<Page> {
    const { page: finalPage, visitedUrls: navigationUrls } = await this.getFinalEffectivePage(
      page.browser(),
      page,
      url,
    );
    
    visitedUrls.push(...navigationUrls);
    return finalPage;
  }

  private async getFinalEffectivePage(
    browser: any,
    startPage: Page,
    linkUrl: string,
    maxDepth = 3,
  ): Promise<{ page: Page; effectiveUrl: string; visitedUrls: string[] }> {
    let effectiveUrl = linkUrl;
    let currentPage = startPage;
    const visitedUrls: string[] = [linkUrl];
    let depth = 0;
    let foundFinal = false;
    let u: string | null = null;

    do {
      await currentPage.goto(effectiveUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      
      const currentUrl = currentPage.url();
      visitedUrls.push(currentUrl);
      
      try {
        const urlObj = new URL(currentUrl);
        u = urlObj.searchParams.get('u');
        
        if (u && /^https?:\/\//.test(u)) {
          const decodedU = decodeURIComponent(u);
          
          if (!decodedU.includes('facebook.com')) {
            effectiveUrl = decodedU;
            foundFinal = true;
            break;
          } else {
            effectiveUrl = decodedU;
            if (currentPage !== startPage) await currentPage.close();
            currentPage = await browser.newPage();
            depth++;
            
            if (
              urlObj.hostname.endsWith('facebook.com') &&
              (urlObj.pathname.includes('/login.php') ||
                urlObj.pathname.includes('/login/identify'))
            ) {
              this.logger.warn(`Hit Facebook login page: ${currentPage.url()}`);
              break;
            }
          }
        } else {
          u = null;
        }
      } catch {
        u = null;
      }
    } while (u && depth < maxDepth);

    if (!foundFinal) {
      if (u && /^https?:\/\//.test(u) && !decodeURIComponent(u).includes('facebook.com')) {
        effectiveUrl = decodeURIComponent(u);
      } else {
        effectiveUrl = currentPage.url();
      }
    }

    return { page: currentPage, effectiveUrl, visitedUrls };
  }

  private async handleRedirectLink(page: Page, taskLogger: any): Promise<void> {
    taskLogger.info('Looking for redirect link after page load');
    
    await this.scrollAndSearchForLinks(page, taskLogger);
    
    try {
      await page.evaluate(() => {
        document.querySelectorAll('a[target="_blank"]').forEach((a) => a.removeAttribute('target'));
      });

      const debugLinks: { href: string; text: string }[] = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).map((a) => ({
          href: a.href,
          text: a.textContent?.trim() || '',
        })),
      );

      const counts: Record<string, number> = {};
      debugLinks.forEach((l) => {
        counts[l.href] = (counts[l.href] || 0) + 1;
      });

      const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
      const targetHref = sorted.length > 0 ? sorted[0][0] : null;

      if (!targetHref) {
        taskLogger.warn('No links to redirect to.');
        return;
      }

      await page.goto(targetHref, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch (error) {
      this.handleNavigationError(error);
    }
  }

  private async scrollAndSearchForLinks(page: Page, taskLogger: any): Promise<void> {
    taskLogger.info('Scrolling and searching for links...');
    const start = Date.now();

    while (Date.now() - start < 25_000) {
      await this.simulateScrolling(page, 'down', taskLogger);
      await this.sleep(500 + Math.random() * 500);
      await this.simulateRandomClicks(page, taskLogger);
      await this.sleep(300 + Math.random() * 700);
      await this.simulateScrolling(page, 'up', taskLogger);
      await this.sleep(1_000 + Math.random() * 2_000);
    }
  }

  private async simulateUserBehavior(page: Page, taskLogger: any): Promise<void> {
    await this.simulateScrolling(page, 'down', taskLogger);
    await this.simulateRandomClicks(page, taskLogger);
    await this.simulateScrolling(page, 'up', taskLogger);
    await this.sleep(10_000);
  }

  private async simulateScrolling(page: Page, direction: 'down' | 'up' = 'down', taskLogger?: any): Promise<void> {
    if (page.isClosed()) {
      if (taskLogger) {
        taskLogger.warn('Page is closed, skipping scrolling');
      } else {
        this.logger.warn('Page is closed, skipping scrolling');
      }
      return;
    }

    try {
      const pageHeight = await page.evaluate(() => {
        if (!document.body) return 0;
        return document.body.scrollHeight || 0;
      });
      const viewportHeight = await page.evaluate(() => window.innerHeight || 0);
      const currentScrollY = await page.evaluate(() => window.scrollY || 0);

      if (direction === 'down') {
        let currentPosition = currentScrollY;
        const maxScrollSteps = Math.min(5, Math.ceil((pageHeight - viewportHeight) / 300));

        for (let i = 0; i < maxScrollSteps; i++) {
          if (page.isClosed()) break;

          const scrollAmount = Math.floor(Math.random() * 200) + 300;
          currentPosition += scrollAmount;

          if (currentPosition >= pageHeight - viewportHeight) {
            break;
          }

          await page.evaluate((amount) => {
            window.scrollBy({
              top: amount,
              behavior: 'smooth',
            });
          }, scrollAmount);

          const pauseTime = 500 + Math.random() * 800;
          await this.sleep(pauseTime);

          if (Math.random() < 0.15) {
            const backScroll = Math.floor(Math.random() * 100) + 50;
            await page.evaluate((amount) => {
              window.scrollBy({
                top: -amount,
                behavior: 'smooth',
              });
            }, backScroll);
            await this.sleep(300 + Math.random() * 500);
          }
        }
      } else {
        await page.evaluate(() => {
          window.scrollTo({
            top: 0,
            behavior: 'smooth',
          });
        });
        await this.sleep(1_000 + Math.random() * 1_000);
      }
    } catch (error) {
      if (error.message.includes('Execution context was destroyed')) {
        if (taskLogger) {
          taskLogger.warn('Page context destroyed during scrolling');
        } else {
          this.logger.warn('Page context destroyed during scrolling');
        }
        return;
      }
      throw error;
    }
  }

  private async simulateRandomClicks(page: Page, taskLogger?: any): Promise<void> {
    if (page.isClosed()) {
      if (taskLogger) {
        taskLogger.warn('Page is closed, skipping random clicks');
      } else {
        this.logger.warn('Page is closed, skipping random clicks');
      }
      return;
    }

    try {
      const clickableElements = await page.evaluate(() => {
        const elements = Array.from(
          document.querySelectorAll('a, button, [role="button"], .btn, .button'),
        );
        return elements
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              style.opacity !== '0' &&
              rect.top >= 0 &&
              rect.left >= 0 &&
              rect.bottom <= window.innerHeight &&
              rect.right <= window.innerWidth
            );
          })
          .map((el) => ({
            tagName: el.tagName.toLowerCase(),
            text: el.textContent?.trim().substring(0, 50) || '',
            href: el.getAttribute('href') || '',
            className: el.className || '',
            rect: el.getBoundingClientRect(),
          }));
      });

      if (clickableElements.length > 0) {
        const randomClicks = Math.floor(Math.random() * 2) + 1;
        for (let i = 0; i < randomClicks; i++) {
          const el = clickableElements[Math.floor(Math.random() * clickableElements.length)];

          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) el.click();
            },
            `${el.tagName}${el.href ? `[href="${el.href}"]` : ''}`,
          );
          await this.sleep(800 + Math.random() * 1_200);
        }
      }

      const elementsToClick = clickableElements
        .filter((el) => {
          const href = el.href.toLowerCase();
          return (
            !href.includes('logout') &&
            !href.includes('signout') &&
            !href.includes('exit') &&
            !href.includes('javascript:') &&
            !href.startsWith('#')
          );
        })
        .slice(0, Math.min(3, clickableElements.length));

      for (const element of elementsToClick) {
        if (page.isClosed()) break;

        try {
          await page.evaluate(
            (selector) => {
              const el = document.querySelector(selector) as HTMLElement;
              if (el) {
                el.click();
              }
            },
            `${element.tagName}${element.href ? `[href="${element.href}"]` : ''}`,
          );

          await this.sleep(1_000 + Math.random() * 1_500);

          if (element.href && !element.href.startsWith('#')) {
            await page
              .waitForNavigation({ waitUntil: 'networkidle2', timeout: 5_000 })
              .catch(() => {
                if (taskLogger) {
                  taskLogger.warn('Page navigation timeout');
                } else {
                  this.logger.warn('Page navigation timeout');
                }
              });

            await this.sleep(1_000 + Math.random() * 2_000);
          }
        } catch (error) {
          if (taskLogger) {
            taskLogger.warn(`Failed to click element: ${error.message}`);
          } else {
            this.logger.warn(`Failed to click element: ${error.message}`);
          }
        }
      }
    } catch (error) {
      if (
        error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target closed')
      ) {
        if (taskLogger) {
          taskLogger.warn('Page context destroyed during random clicks');
        } else {
          this.logger.warn('Page context destroyed during random clicks');
        }
        return;
      }
      throw error;
    }
  }

  private handleNavigationError(error: any): void {
    if (
      error.message.includes('Navigation timeout') ||
      error.message.includes('Navigation failed') ||
      error.message.includes('Navigation timeout after form submission') ||
      error.message.includes('net::ERR_') ||
      error.message.includes('ERR_TUNNEL_CONNECTION_FAILED')
    ) {
      this.logger.warn(`Navigation error: ${error.message}`);
    } else {
      this.logger.warn(`Error in navigation: ${error.message}`);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
} 