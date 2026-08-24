import { TransactionStudio } from "@/features/transaction-studio/components/transaction-studio";

export default async function TransactionStudioPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <TransactionStudio initialDocumentId={documentId} />
    </div>
  );
}
