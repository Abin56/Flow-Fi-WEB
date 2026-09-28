"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2Icon, LockKeyholeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AmbientBackground } from "@/components/background/ambient-background";
import { ClayButton } from "@/components/clay/clay-button";
import { ClayPanel } from "@/components/clay/clay-panel";
import { PasswordField } from "@/components/forms/password-field";
import { restoreAccess, submitAccessPassword, useAccessStore, type VerifyResult } from "@/services/access/access-gate";
import { signInWithGoogle } from "@/services/auth/auth-service";
import { useAuthStore } from "@/store/auth-store";

const ACCESS_MESSAGES: Record<Exclude<VerifyResult["kind"], "granted">, string> = {
  denied: "Incorrect access password.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  unavailable: "Unable to verify access right now. Please try again.",
};

export default function LoginPage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const accessStatus = useAccessStore((state) => state.status);

  useEffect(() => {
    if (status === "signed-in") router.replace("/dashboard");
  }, [status, router]);

  useEffect(() => {
    void restoreAccess();
  }, []);

  return (
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <AmbientBackground />
      <motion.div
        className="w-full max-w-sm"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        <ClayPanel strong className="relative w-full p-8 text-center" style={{ zIndex: "var(--z-surface)" }}>
          <div
            className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary font-heading text-xl font-semibold text-primary-foreground"
            style={{ boxShadow: "var(--shadow-e1)" }}
          >
            F
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {accessStatus === "granted" ? (
              <motion.div key="google" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <GoogleSignIn />
              </motion.div>
            ) : accessStatus === "locked" ? (
              <motion.div key="gate" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                <AccessGate />
              </motion.div>
            ) : (
              <motion.p key="checking" role="status" className="py-6 text-sm text-muted-foreground" exit={{ opacity: 0 }}>
                Checking access…
              </motion.p>
            )}
          </AnimatePresence>
        </ClayPanel>
      </motion.div>
    </div>
  );
}

function AccessGate() {
  const [password, setPassword] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (verifying) return;
    if (!password) {
      setError("Enter the access password.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setVerifying(true);
    const result = await submitAccessPassword(password);
    if (result.kind === "granted") return; // store flips to "granted" and this form unmounts
    setVerifying(false);
    setError(ACCESS_MESSAGES[result.kind]);
    if (result.kind === "denied") setPassword("");
    inputRef.current?.focus();
  }

  return (
    <>
      <h1 className="font-heading text-xl font-semibold">FlowFi</h1>
      <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <LockKeyholeIcon className="size-3.5" aria-hidden />
        Private Access
      </p>
      <p className="mt-3 text-sm text-muted-foreground">Enter the access password to continue.</p>

      <form className="mt-6 space-y-3 text-left" onSubmit={handleSubmit} noValidate>
        <PasswordField
          ref={inputRef}
          label="Access password"
          name="flowfi-access-password"
          autoComplete="current-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          maxLength={256}
          value={password}
          disabled={verifying}
          aria-describedby={error ? "access-error" : undefined}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
        />
        <ClayButton type="submit" className="h-11 w-full" disabled={verifying}>
          {verifying ? "Verifying…" : "Continue"}
        </ClayButton>
        {error && (
          <p id="access-error" role="alert" className="text-center text-sm text-expense">
            {error}
          </p>
        )}
      </form>

      <div className="mt-6 border-t border-border pt-4">
        <p className="text-xs text-muted-foreground">Google Sign-In becomes available after access verification.</p>
      </div>
    </>
  );
}

function GoogleSignIn() {
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setError(null);
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "flowfi/access-required") {
        setError(null); // gate re-locked (expired) — the access form is shown again
      } else if (code === "auth/popup-blocked") {
        setError("Your browser blocked the sign-in popup. Please allow popups for this site and try again.");
      } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        setError(null);
      } else if (code === "auth/network-request-failed") {
        setError("Network error. Check your connection and try again.");
      } else {
        setError("Sign-in failed. Please try again.");
      }
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <>
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
        <CheckCircle2Icon className="size-4" aria-hidden />
        Access verified
      </p>
      <h1 className="mt-3 font-heading text-xl font-semibold">Sign in to FlowFi</h1>
      <p className="mt-1 text-sm text-muted-foreground">Same account as your FlowFi mobile app.</p>

      <ClayButton className="mt-6 h-11 w-full" onClick={handleSignIn} disabled={signingIn}>
        {signingIn ? "Signing in..." : "Continue with Google"}
      </ClayButton>

      {error && (
        <p role="alert" className="mt-3 text-sm text-expense">
          {error}
        </p>
      )}
    </>
  );
}
