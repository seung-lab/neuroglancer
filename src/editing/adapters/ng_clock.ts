import type { Clock } from "@zetta-ai/edit-session";

export class NgClock implements Clock {
  now(): number {
    return performance.now();
  }
  wallTime(): number {
    return Date.now();
  }
}
