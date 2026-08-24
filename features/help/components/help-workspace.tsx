import { LifeBuoy, Mail, MessageCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const FAQS = [
  {
    question: "Why is my statement stuck on \"Awaiting Password\"?",
    answer:
      "Your bank encrypts statement PDFs with a password. Enter it once from the document card, and FlowFi can remember it for future statements from the same card.",
  },
  {
    question: "How does FlowFi detect duplicate transactions?",
    answer:
      "Every imported row is compared against your existing transactions by amount, date, and merchant. Likely duplicates are flagged for review before anything is imported.",
  },
  {
    question: "Can I undo a transaction import?",
    answer:
      "Yes — Transaction Studio keeps a full undo/redo history while you're reviewing a statement, and each row shows exactly what will be imported before you approve it.",
  },
];

export function HelpWorkspace() {
  return (
    <div className="flex flex-col gap-6 px-1">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <LifeBuoy className="size-5" />
        </div>
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Help &amp; Support</h1>
          <p className="text-sm text-muted-foreground">Answers to common questions, and how to reach us.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-3">
          {FAQS.map((faq) => (
            <Card key={faq.question}>
              <CardHeader>
                <CardTitle>{faq.question}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{faq.answer}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Contact us</CardTitle>
            <CardDescription>Can&apos;t find what you&apos;re looking for?</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <a
              href="mailto:support@flowfi.app"
              className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              <Mail className="size-4 text-primary" />
              support@flowfi.app
            </a>
            <div className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-sm text-muted-foreground">
              <MessageCircle className="size-4 text-primary" />
              In-app chat is coming soon.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
