export function isWithinTimeRange(timeFrom: string, timeTo: string): boolean {
  const now = new Date();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  const [fromHours, fromMinutes] = timeFrom.split(':').map(Number);
  const [toHours, toMinutes] = timeTo.split(':').map(Number);

  const startTime = fromHours * 60 + fromMinutes;
  const endTime = toHours * 60 + toMinutes;

  if (endTime < startTime) {
    return currentTime >= startTime || currentTime <= endTime;
  } else {
    return currentTime >= startTime && currentTime <= endTime;
  }
}

export function getTimeUntilNextAllowedRun(timeFrom: string, timeTo: string): number {
  const now = new Date();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  const [fromHours, fromMinutes] = timeFrom.split(':').map(Number);
  const [toHours, toMinutes] = timeTo.split(':').map(Number);

  const startTime = fromHours * 60 + fromMinutes;
  const endTime = toHours * 60 + toMinutes;

  if (isWithinTimeRange(timeFrom, timeTo)) {
    return 0;
  }

  if (endTime < startTime) {
    if (currentTime > endTime && currentTime < startTime) {
      const nextStart = new Date(now);
      nextStart.setHours(fromHours, fromMinutes, 0, 0);
      return nextStart.getTime() - now.getTime();
    }
  } else {
    if (currentTime < startTime) {
      const nextStart = new Date(now);
      nextStart.setHours(fromHours, fromMinutes, 0, 0);
      return nextStart.getTime() - now.getTime();
    } else {
      const nextStart = new Date(now);
      nextStart.setDate(nextStart.getDate() + 1);
      nextStart.setHours(fromHours, fromMinutes, 0, 0);
      return nextStart.getTime() - now.getTime();
    }
  }

  return 0;
}

export function formatTimeForLogging(timeString: string): string {
  const [hours, minutes] = timeString.split(':').map(Number);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}
