import { Injectable } from "@nestjs/common";
import { LogWrapper } from "@utils/LogWrapper";

@Injectable()
export class AIService {
  private readonly logger = new LogWrapper(AIService.name);

  constructor() {}

  private async getDataFromOpenAI(): Promise<string> {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPEN_AI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [], // TODO
            max_tokens: 150,
            temperature: 0,
          }),
        }
      );

      const tagData = await response.json();

      if (tagData.error) {
        await this.logger.error("Error extracting tags");
        throw new Error("Failed to extract tags");
      }

      return tagData.choices[0]?.message?.content?.trim() || "";
    } catch (error) {
      await this.logger.error(`Error in extractTagsFromOpenAI: ${error}`);
      throw new Error("Failed to communicate with third party API");
    }
  }
}
