/*
 * Keeps track of live sessions so limits hold across tabs and users, and so
 * disabling the plugin closes every one of them.
 */

export interface ManagedSession {
  readonly id: string;
  readonly userId: string;
  close(reason: string): Promise<void>;
}

export interface SessionLimits {
  perUser: number;
  total: number;
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  get size(): number {
    return this.sessions.size;
  }

  countFor(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values())
      if (session.userId === userId) count++;
    return count;
  }

  /** Reserves a slot or throws; call before the expensive connect. */
  admit(session: ManagedSession, limits: SessionLimits): () => void {
    if (this.sessions.size >= limits.total) {
      throw new LimitError(
        "The server has reached its limit of WinRM sessions. Close one and try again.",
      );
    }
    if (this.countFor(session.userId) >= limits.perUser) {
      throw new LimitError(
        `You already have ${limits.perUser} WinRM sessions open. Close one and try again.`,
      );
    }
    this.sessions.set(session.id, session);
    return () => this.sessions.delete(session.id);
  }

  async closeAll(reason: string): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((session) => session.close(reason)));
  }
}
