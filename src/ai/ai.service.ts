import { FormAnalysisResult, LeadData } from '@interfaces';
import { Injectable } from '@nestjs/common';
import { LogWrapper } from '@utils';

@Injectable()
export class AIService {
  private readonly logger = new LogWrapper(AIService.name);

  constructor() {}

  async analyzeForms(formsHtml: string): Promise<FormAnalysisResult> {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
              content: `You are an expert at analyzing HTML forms. Your task is to find the correct form for filling lead data and determine selectors for name, surname, phone, email fields, and any checkboxes.

RULES:
1. Ignore hidden fields (hidden, display:none, visibility:hidden)
2. Ignore fields with type="hidden"
3. Look only for visible input fields with type="text", "email", "tel", "checkbox" or without a type attribute
4. Analyze name, id, placeholder, label to determine field purpose
5. Collect all checkboxes: capture selector + whatever name/label text exists (do not assume any fixed names/labels)
6. Return JSON in strictly defined format
7. Indicate confidence (0-1) for each field, checkbox, and form
8. Choose form with the most suitable fields

RETURN ONLY JSON WITHOUT ADDITIONAL TEXT:`,
            },
            {
              role: 'user',
              content: `Analyze these forms and find the best one for filling lead data (name, surname, phone, email), and list all checkboxes:

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
    "checkboxes": [
      {
        "selector": "input[name='subscribe']",
        "label": "Subscribe to newsletter",
        "confidence": 0.8
      }
    ],
    "confidence": 0.8,
    "reason": "Contains all necessary fields and checkboxes"
  },
  "allForms": [
    {
      "formIndex": 0,
      "fields": [
        {
          "selector": "input[name='first_name']",
          "type": "name",
          "confidence": 0.9
        }
      ],
      "checkboxes": [
        {
          "selector": "input[type='checkbox']",
          "label": "<any label>",
          "confidence": 0.7
        }
      ],
      "confidence": 0.7,
      "reason": "Best coverage"
    }
  ]
}`,
            },
          ],
          max_tokens: 1400,
          temperature: 0,
        }),
      });

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

            const formHtml =
              form.outerHTML.length > 5_000
                ? form.outerHTML.substring(0, 5_000) + '... (truncated)'
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
        const bestForm = forms.find((form) => {
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
          return visibleInputs.length >= 2;
        });

        if (!bestForm) return null;

        const formIndex = forms.indexOf(bestForm);
        const inputs = Array.from(bestForm.querySelectorAll('input'));
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

        const fields = visibleInputs
          .map((input) => {
            const name = input.name?.toLowerCase() || '';
            const id = input.id?.toLowerCase() || '';
            const placeholder = input.placeholder?.toLowerCase() || '';
            const type = input.type?.toLowerCase() || 'text';

            let fieldType = 'unknown';
            let confidence = 0.5;

            if (
              type === 'email' ||
              name.includes('email') ||
              id.includes('email') ||
              placeholder.includes('email')
            ) {
              fieldType = 'email';
              confidence = 0.9;
            } else if (
              type === 'tel' ||
              name.includes('phone') ||
              name.includes('tel') ||
              id.includes('phone') ||
              id.includes('tel') ||
              placeholder.includes('phone') ||
              placeholder.includes('tel')
            ) {
              fieldType = 'phone';
              confidence = 0.9;
            } else if (
              name.includes('name') ||
              name.includes('first') ||
              id.includes('name') ||
              id.includes('first') ||
              placeholder.includes('name') ||
              placeholder.includes('first')
            ) {
              fieldType = 'name';
              confidence = 0.8;
            } else if (
              name.includes('last') ||
              name.includes('surname') ||
              id.includes('last') ||
              id.includes('surname') ||
              placeholder.includes('last') ||
              placeholder.includes('surname')
            ) {
              fieldType = 'surname';
              confidence = 0.8;
            }

            return {
              selector: `input[name="${input.name}"], input[id="${input.id}"]`,
              type: fieldType,
              confidence,
            };
          })
          .filter((field) => field.type !== 'unknown');

        return {
          formIndex,
          fields,
          confidence: 0.7,
          reason: 'Fallback analysis based on field attributes',
        };
      });

      if (!formData) {
        throw new Error('No suitable form found for fallback analysis');
      }

      return {
        bestForm: formData,
        allForms: [formData],
      };
    } catch (error) {
      this.logger.error(`Error in fallback form analysis: ${error.message}`);
      throw new Error('Failed to analyze forms with fallback method');
    }
  }

  async generateFormFillScript(formsHtml: string, leadData: LeadData): Promise<string> {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
              content: `You are an expert at generating JavaScript code to fill HTML forms. Your task is to create a self-executing function that fills form fields with provided lead data.

RULES:
1. Generate ONLY JavaScript code that can be executed directly in browser console
2. Use the exact field selectors from the form analysis
3. Fill visible fields with appropriate lead data
4. Clear honeypot fields (website, url, comment, notes, etc.)
5. Submit the form at the end
6. Handle cases where fields might not exist
7. Use proper error handling
8. Return ONLY the JavaScript code without any explanations or markdown

LEAD DATA FORMAT:
- name: string
- lastname: string  
- email: string
- phone: string

EXAMPLE OUTPUT FORMAT:
(() => {
  const form = document.querySelector('form#commentForm');
  if (!form) {
    console.error('Форма не найдена');
    return;
  }

  form.querySelector('input[name="name"]').value = 'Ivan';
  form.querySelector('input[name="last"]').value = 'Petrenko';
  form.querySelector('input[name="email"]').value = 'ivan.petrenko@example.com';
  form.querySelector('input[name="phone"]').value = '501234567';
  form.querySelector('input[name="phonecc"]').value = '380';

  ['website', 'url', 'comment', 'notes'].forEach((name) => {
    const input = form.querySelector(\`input[name="\${name}"]\`);
    if (input) input.value = '';
  });

  form.submit();
})();`,
            },
            {
              role: 'user',
              content: `Generate JavaScript code to fill this form with lead data:

FORMS HTML:
${formsHtml}

LEAD DATA:
${JSON.stringify(leadData, null, 2)}

Return ONLY the JavaScript code that can be executed directly in browser console.`,
            },
          ],
          max_tokens: 1500,
          temperature: 0,
        }),
      });

      const data = await response.json();

      if (data.error) {
        this.logger.error(`OpenAI API error: ${data.error.message}`);
        throw new Error('Failed to generate form fill script');
      }

      const content = data.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      const jsCodeMatch = content.match(/```javascript\s*([\s\S]*?)\s*```/) ||
        content.match(/```js\s*([\s\S]*?)\s*```/) ||
        content.match(/```\s*([\s\S]*?)\s*```/) || [null, content];

      const jsCode = jsCodeMatch[1] || content;
      return jsCode;
    } catch (error) {
      this.logger.error(`Error generating form fill script: ${error.message}`, error);
      throw new Error('Failed to generate form fill script with AI');
    }
  }
}
