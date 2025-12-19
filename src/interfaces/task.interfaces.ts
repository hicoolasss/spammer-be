export interface TaskRedirectEvent {
  url: string;
  at: Date;
}

export interface TaskResult {
  total: number;
  redirects: TaskRedirectEvent[];
}