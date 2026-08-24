/**
 * Generic per-key rate limiter — Architecture v1.0 §22/§24 (3 password
 * attempts, then a 15-minute lockout), backlog M1-T8. Not password-
 * specific: any Cloud Function that needs "N attempts per window" can use
 * this against its own key namespace.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
}

export interface RateLimitCheck {
  allowed: boolean;
  attemptsRemaining: number;
  /** Present only when allowed:false — when the lockout window ends. */
  retryAfter?: Date;
}

interface RateLimitDoc {
  attemptCount: number;
  windowStartedAt: FirebaseFirestore.Timestamp;
}

function rateLimitDocRef(db: Firestore, namespace: string, key: string) {
  return db.collection("rateLimits").doc(namespace).collection("keys").doc(key);
}

/**
 * Checks whether another attempt is allowed for `key` and, if so, records
 * it atomically (so two concurrent attempts can't both slip through as
 * "attempt 3 of 3" — same transactional discipline as
 * check-document-exists.ts's dedupe fix, applied here to a different
 * race). Callers must call this BEFORE doing the sensitive operation
 * (e.g. attempting a password), not after — see decrypt-document.ts.
 */
export async function checkAndRecordAttempt(
  db: Firestore,
  namespace: string,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitCheck> {
  const ref = rateLimitDocRef(db, namespace, key);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();

    if (!snap.exists) {
      tx.set(ref, { attemptCount: 1, windowStartedAt: FieldValue.serverTimestamp() });
      return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
    }

    const data = snap.data() as RateLimitDoc;
    const windowStartedAtMs = data.windowStartedAt.toMillis();
    const windowExpired = now - windowStartedAtMs >= config.windowMs;

    if (windowExpired) {
      tx.set(ref, { attemptCount: 1, windowStartedAt: FieldValue.serverTimestamp() });
      return { allowed: true, attemptsRemaining: config.maxAttempts - 1 };
    }

    if (data.attemptCount >= config.maxAttempts) {
      return {
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: new Date(windowStartedAtMs + config.windowMs),
      };
    }

    tx.update(ref, { attemptCount: FieldValue.increment(1) });
    return { allowed: true, attemptsRemaining: config.maxAttempts - data.attemptCount - 1 };
  });
}

/** Clears a key's rate-limit state — call after a SUCCESSFUL attempt so a correct password doesn't count against future unrelated attempts. */
export async function resetRateLimit(db: Firestore, namespace: string, key: string): Promise<void> {
  await rateLimitDocRef(db, namespace, key).delete();
}
