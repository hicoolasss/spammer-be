export interface TaskResult {
  total: number;
  success: Record<string, number>;
  failed: Record<string, number>;
  visitedUrls: string[];
  finalUrls: string[];
  lastExecution?: {
    timestamp: Date;
    finalUrl?: string;
    success: boolean;
    error?: string;
  };
}
