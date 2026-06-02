import type {
  LayerId,
  SessionId,
  SessionLock,
  SessionLockAdapter,
} from "@zettaai/edit-session";

import { WatchableValue } from "#src/trackable_value.js";

interface ActiveSession {
  readonly sessionId: SessionId;
  readonly sessionLayerIds: ReadonlySet<LayerId>;
}

// Approach (a): host calls setActiveSession/clearActiveSession around acquire/release.
export class NgSessionLockAdapter implements SessionLockAdapter {
  readonly activeSession = new WatchableValue<ActiveSession | undefined>(
    undefined,
  );
  private locked = false;

  async acquire(sessionId: SessionId): Promise<SessionLock> {
    if (this.locked) {
      throw new Error("SessionLock: another session is active");
    }
    this.locked = true;
    const acquiredAt = performance.now();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.locked = false;
      if (
        this.activeSession.value !== undefined &&
        this.activeSession.value.sessionId === sessionId
      ) {
        this.activeSession.value = undefined;
      }
    };
    return {
      sessionId,
      acquiredAt,
      release,
    };
  }

  setActiveSession(active: ActiveSession): void {
    this.activeSession.value = active;
  }

  clearActiveSession(): void {
    this.activeSession.value = undefined;
  }

  isLayerDataSourceLocked(layerId: LayerId): boolean {
    const active = this.activeSession.value;
    return active !== undefined && active.sessionLayerIds.has(layerId);
  }
}
