"use client";

import { BellOffIcon } from "lucide-react";
import { Banner } from "@/components/feedback/banner";
import { Button } from "@/components/ui/button";

export interface PermissionBannerProps {
  onEnable: () => void;
  onDismiss?: () => void;
}

/** Prompts the user to grant browser push-notification permission — shown at the top of the Notifications
 *  section when permission hasn't been granted yet. */
export function PermissionBanner({ onEnable, onDismiss }: PermissionBannerProps) {
  return (
    <Banner
      tone="warning"
      title="Push notifications are off"
      description="Enable browser notifications to get real-time alerts for bills, budgets, and unusual activity."
      onDismiss={onDismiss}
      action={
        <Button size="sm" onClick={onEnable}>
          <BellOffIcon className="size-3.5" />
          Enable notifications
        </Button>
      }
    />
  );
}
