import { FormAnalysisResult } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { LogWrapper } from '@utils';

@Injectable()
export class AIService {
  private readonly logger = new LogWrapper(AIService.name);

  constructor() {}

  async analyzeForms(formsHtml: string): Promise<FormAnalysisResult> {
    try {
      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPEN_AI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are an expert at analyzing HTML forms. Your task is to find the correct form for filling lead data and determine selectors for name, surname, phone, email fields.

RULES:
1. Ignore hidden fields (hidden, display:none, visibility:hidden)
2. Ignore fields with type="hidden"
3. Look only for visible input fields with type="text", "email", "tel" or without type
4. Analyze name, id, placeholder, label to determine field purpose
5. Return JSON in strictly defined format
6. Indicate confidence (0-1) for each field and form
7. Choose form with the most suitable fields

RETURN ONLY JSON WITHOUT ADDITIONAL TEXT:`,
              },
              {
                role: 'user',
                content: `Analyze these forms and find the best one for filling lead data (name, surname, phone, email):

${formsHtml}

Return JSON in format:
{
  "bestForm": {
    "formIndex": 0,
    "fields": [
      {
        "selector": "input[name='first_name']",
        "type": "name",
        "confidence": 0.9
      }
    ],
    "confidence": 0.8,
    "reason": "Contains all necessary fields"
  },
  "allForms": [...]
}`,
              },
            ],
            max_tokens: 1000,
            temperature: 0,
          }),
        },
      );

      const data = await response.json();

      if (data.error) {
        this.logger.error(`OpenAI API error: ${data.error.message}`);
        throw new Error('Failed to analyze forms');
      }

      const content = data.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);

      if (!jsonMatch) {
        throw new Error('Invalid JSON response from OpenAI');
      }

      const result: FormAnalysisResult = JSON.parse(jsonMatch[0]);

      this.logger.info(
        `Form analysis completed. Best form: ${result.bestForm.formIndex}, confidence: ${result.bestForm.confidence}`,
      );

      return result;
    } catch (error) {
      this.logger.error(`Error analyzing forms: ${error.message}`, error);
      throw new Error('Failed to analyze forms with AI');
    }
  }

  async extractFormHtml(page): Promise<string> {
    try {
      const formsHtml = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        return forms
          .map((form, index) => {
            const inputs = Array.from(form.querySelectorAll('input'));
            const visibleInputs = inputs.filter((input) => {
              const style = window.getComputedStyle(input);
              const rect = input.getBoundingClientRect();
              return (
                input.type !== 'hidden' &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0
              );
            });

            const formHtml = form.outerHTML.length > 5000 
              ? form.outerHTML.substring(0, 5000) + '... (truncated)'
              : form.outerHTML;

            return `
FORM ${index}:
${formHtml}

VISIBLE INPUTS:
${visibleInputs
  .map(
    (input) => `
- type: "${input.type || 'text'}"
- name: "${input.name || ''}"
- id: "${input.id || ''}"
- placeholder: "${input.placeholder || ''}"
- class: "${input.className || ''}"
`,
  )
  .join('')}
---
`;
          })
          .join('\n');
      });

      const maxLength = 30000;
      if (formsHtml.length > maxLength) {
        this.logger.warn(`Form HTML too large (${formsHtml.length} chars), truncating to ${maxLength} chars`);
        return formsHtml.substring(0, maxLength) + '... (truncated)';
      }

      return formsHtml;
    } catch (error) {
      this.logger.error(`Error extracting form HTML: ${error.message}`);
      throw new Error('Failed to extract form HTML');
    }
  }

  async analyzeFormsFallback(page): Promise<FormAnalysisResult> {
    try {
      const formData = await page.evaluate(() => {
        const forms = Array.from(document.querySelectorAll('form'));
        const bestForm = forms.find(form => {
          const inputs = Array.from(form.querySelectorAll('input'));
          const visibleInputs = inputs.filter(input => {
            const style = window.getComputedStyle(input);
            const rect = input.getBoundingClientRect();
            return (
              input.type !== 'hidden' &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            );
          });
          return visibleInputs.length >= 2;
        });

        if (!bestForm) return null;

        const formIndex = forms.indexOf(bestForm);
        const inputs = Array.from(bestForm.querySelectorAll('input'));
        const visibleInputs = inputs.filter(input => {
          const style = window.getComputedStyle(input);
          const rect = input.getBoundingClientRect();
          return (
            input.type !== 'hidden' &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
        });

        const fields = visibleInputs.map(input => {
          const name = input.name?.toLowerCase() || '';
          const id = input.id?.toLowerCase() || '';
          const placeholder = input.placeholder?.toLowerCase() || '';
          const type = input.type?.toLowerCase() || 'text';

          let fieldType = 'unknown';
          let confidence = 0.5;

          if (type === 'email' || name.includes('email') || id.includes('email') || placeholder.includes('email')) {
            fieldType = 'email';
            confidence = 0.9;
          } else if (type === 'tel' || name.includes('phone') || name.includes('tel') || id.includes('phone') || id.includes('tel') || placeholder.includes('phone') || placeholder.includes('tel')) {
            fieldType = 'phone';
            confidence = 0.9;
          } else if (name.includes('name') || name.includes('first') || id.includes('name') || id.includes('first') || placeholder.includes('name') || placeholder.includes('first')) {
            fieldType = 'name';
            confidence = 0.8;
          } else if (name.includes('last') || name.includes('surname') || id.includes('last') || id.includes('surname') || placeholder.includes('last') || placeholder.includes('surname')) {
            fieldType = 'surname';
            confidence = 0.8;
          }

          return {
            selector: `input[name="${input.name}"], input[id="${input.id}"]`,
            type: fieldType,
            confidence
          };
        }).filter(field => field.type !== 'unknown');

        return {
          formIndex,
          fields,
          confidence: 0.7,
          reason: 'Fallback analysis based on field attributes'
        };
      });

      if (!formData) {
        throw new Error('No suitable form found for fallback analysis');
      }

      this.logger.info(`Fallback form analysis completed. Form: ${formData.formIndex}, fields: ${formData.fields.length}`);

      return {
        bestForm: formData,
        allForms: [formData]
      };
    } catch (error) {
      this.logger.error(`Error in fallback form analysis: ${error.message}`);
      throw new Error('Failed to analyze forms with fallback method');
    }
  }
}
