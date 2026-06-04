import type { Clock } from "@zettaai/edit-session";

export class NgClock implements Clock {
  now(): number {
    return performance.now();
  }
  wallTime(): number {
    return Date.now();
  }
}
