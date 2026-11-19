import { notFound } from "next/navigation";

/** LOCAL DESIGN/QA ONLY — 404s outside a development server; the showcase import is eliminated from production builds. */
export default async function ToastsPage() {
  if (process.env.NODE_ENV === "development") {
    const { ToastShowcase } = await import("@/features/dev-qa/components/toast-showcase");
    return <ToastShowcase />;
  }
  notFound();
}
