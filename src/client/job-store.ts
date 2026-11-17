import type { Data } from "./protocol.js";

export type Saved = {
  jobId: string;
  job: Data | null;
  unknown: boolean;
  requestId: string;
};
const empty: Saved = Object.freeze({
  jobId: "",
  job: null,
  unknown: false,
  requestId: "",
});
export const sessionKey = (session?: { id: string; cwd?: string }) =>
  JSON.stringify([session?.id, session?.cwd ?? ""]);

// Immutable snapshots and notifications let late execute responses reach replacement panels.
export function createJobStore() {
  const values = new Map<string, Saved>();
  const listeners = new Set<() => void>();
  const storageKey = (key: string) => "auto-debug-request:" + key;
  return {
    get(key: string): Saved {
      if (!values.has(key)) {
        let requestId = "";
        try {
          requestId = globalThis.sessionStorage?.getItem(storageKey(key)) || "";
        } catch {
          /* Storage may be disabled. */
        }
        values.set(
          key,
          requestId ? { ...empty, requestId, unknown: true } : empty,
        );
      }
      return values.get(key)!;
    },
    set(key: string, value: Saved) {
      values.set(key, value);
      // Only the correlation identity is persisted, never preview contents or session secrets.
      try {
        if (value.requestId)
          globalThis.sessionStorage?.setItem(storageKey(key), value.requestId);
        else globalThis.sessionStorage?.removeItem(storageKey(key));
      } catch {
        /* Backend listJobs remains available after reload. */
      }
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
