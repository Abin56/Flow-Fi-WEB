import { Bot } from "lucide-react";
import { FeaturePlaceholder } from "@/components/layout/feature-placeholder";

export default function AiAssistantPage() {
  return (
    <FeaturePlaceholder
      icon={Bot}
      title="AI Assistant"
      description="Persistent assistant over your Firestore data, powered by the OpenAI Responses API — coming in a later pass."
    />
  );
}
