"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AmbientBackground } from "@/components/background/ambient-background";
import { ClayButton } from "@/components/clay/clay-button";
import { ClayPanel } from "@/components/clay/clay-panel";
import { signInWithGoogle } from "@/services/auth/auth-service";
import { useAuthStore } from "@/store/auth-store";

export default function LoginPage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "signed-in") router.replace("/dashboard");
  }, [status, router]);

  async function handleSignIn() {
    setError(null);
    setSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "auth/popup-blocked") {
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
    <div className="relative flex min-h-dvh items-center justify-center px-4">
      <AmbientBackground />
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}>
        <ClayPanel strong className="relative w-full max-w-sm p-8 text-center" style={{ zIndex: "var(--z-surface)" }}>
          <div
            className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary font-heading text-xl font-semibold text-primary-foreground"
            style={{ boxShadow: "var(--shadow-e1)" }}
          >
            F
          </div>
          <h1 className="font-heading text-xl font-semibold">Sign in to FlowFi</h1>
          <p className="mt-1 text-sm text-muted-foreground">Same account as your FlowFi mobile app.</p>

          <ClayButton className="mt-6 h-11 w-full" onClick={handleSignIn} disabled={signingIn}>
            {signingIn ? "Signing in..." : "Continue with Google"}
          </ClayButton>

          {error && (
            <p role="alert" className="mt-3 text-sm text-expense">
              {error}
            </p>
          )}
        </ClayPanel>
      </motion.div>
    </div>
  );
}
