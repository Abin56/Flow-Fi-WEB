"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { OperationProgressHost } from "@/components/feedback/operation-progress";
import { Toaster } from "@/components/feedback/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuthListener } from "@/hooks/use-auth-listener";

function AuthBootstrap({ children }: { children: React.ReactNode }) {
  useAuthListener();
  return <>{children}</>;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <AuthBootstrap>{children}</AuthBootstrap>
          <OperationProgressHost />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}