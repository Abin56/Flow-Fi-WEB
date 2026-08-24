import { Compass } from "lucide-react";
import Link from "next/link";
import { FeaturePlaceholder } from "@/components/layout/feature-placeholder";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background px-4">
      <div className="w-full max-w-md">
        <FeaturePlaceholder
          icon={Compass}
          title="Page not found"
          description="The page you're looking for doesn't exist or may have moved."
        />
      </div>
      <Link
        href="/dashboard"
        className="text-sm font-medium text-primary underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
      >
        Go to dashboard
      </Link>
    </div>
  );
}
