import { getRandomItem } from './random';
import { USER_AGENTS } from './userAgents';

export function getRandomDefaultUserAgent(): string {
  return getRandomItem(USER_AGENTS);
}