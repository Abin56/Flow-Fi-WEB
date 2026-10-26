import type { Metadata } from "next";
import type { ReactNode } from "react";
import { CONTACT_EMAIL, CONTACT_MAILTO } from "@/lib/config/contact";

/**
 * Public privacy policy. Every statement here was checked against the code (2026-10-25); change it together with
 * Finance_App `SmsAccessConsentSheet` / `SmsAiConsentDialog` and keep the two in step.
 *
 * Sources: candidate fields — Finance_App `SmsTransactionCandidateCloud.toFirestore`; AI request — `FinancialEventAiRequest
 * .toJson` + `SmsBodyRedactor`, gated by `ConsentGatedFinancialEventAiProvider`; notification capture —
 * `NotificationCaptureListenerService` / `NotificationCaptureStore` (500-row cap); device status — `sms_device_status_reporter
 * .dart`; tombstones — firestore.rules `smsCandidateTombstones` (no delete); pairing — functions/src/sms-pairing.
 */

const PRIVACY_POLICY_UPDATED = "25 October 2026";

export const metadata: Metadata = {
  title: "Privacy policy · FlowFi",
  description: "How FlowFi handles your SMS, transaction and device data.",
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6 border-t border-border pt-8">
      <h2 id={`${id}-h`} className="text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

const Strong = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-foreground">{children}</strong>;

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground/60">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Contact() {
  return (
    <a data-testid="privacy-contact" className="font-medium text-primary underline-offset-4 hover:underline" href={CONTACT_MAILTO}>
      {CONTACT_EMAIL}
    </a>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-background px-4 py-10 text-foreground sm:py-16">
      <article className="mx-auto max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">FlowFi</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Privacy policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated {PRIVACY_POLICY_UPDATED}</p>

        <p className="mt-6 text-[15px] leading-relaxed text-muted-foreground">
          FlowFi is a personal finance app for Android and the web. This page explains what FlowFi collects, where it goes,
          how long it is kept and what you can do about it. The SMS features described here exist only in the FlowFi
          Android app installed from FlowFi&apos;s own download page.
        </p>

        <nav aria-label="On this page" className="mt-6 rounded-xl border border-border bg-card p-4 text-sm">
          <p className="font-medium text-foreground">In short</p>
          <List
            items={[
              "FlowFi reads bank SMS on your phone and recognises transactions there.",
              "Parsed transaction details, not the message text, are saved to your FlowFi account for review.",
              "Nothing becomes a transaction until you import it.",
              "AI help is off unless you turn it on. When on, unclear messages are sent with long numbers masked to Anthropic.",
              "FlowFi does not sell your data, show ads or use advertising identifiers.",
            ]}
          />
        </nav>

        <div className="mt-10 space-y-10">
          <Section id="sms" title="SMS access and on-device processing">
            <p>
              With your permission (<Strong>READ_SMS</Strong>), FlowFi reads the SMS inbox on your phone when you scan, and
              looks for bank and payment alerts. With <Strong>Auto Sync</Strong>, which you turn on separately, it also uses{" "}
              <Strong>RECEIVE_SMS</Strong> to notice new messages and check them in the background. FlowFi never sends SMS.
            </p>
            <p>
              Matching messages are parsed on the phone into transaction details. The full message text, sender and
              parsing results are stored in a database on the phone so you can review them in the app. Android backup is
              turned off for FlowFi, so this local data is not copied to your Google backup.
            </p>
          </Section>

          <Section id="candidates" title="Transaction details saved to your account">
            <p>
              So you can review them on the phone and on FlowFi Web, each recognised transaction is saved as a{" "}
              <Strong>candidate</Strong> in your FlowFi account (Google Firebase Cloud Firestore). A candidate contains:
            </p>
            <List
              items={[
                "amount, direction (money in or out) and transaction type",
                "transaction date",
                "merchant, bank name and the last 4 digits of the account or card",
                "reference number, if the message has one",
                "which of your FlowFi accounts or cards it matched, the confidence score and review reasons",
                "an internal message id and when the candidate was created",
              ]}
            />
            <p>
              A candidate does <Strong>not</Strong> contain the message text or the sender&apos;s address. Candidates are
              never recorded as transactions on their own: each one waits until you import or dismiss it.
            </p>
          </Section>

          <Section id="ai" title="Optional AI classification (Anthropic)">
            <p>
              AI help is <Strong>off by default</Strong>, including for anyone who installed FlowFi before this option
              existed. You can turn it on, after reading what it does, in the SMS Inbox, and turn it off there at any
              time. Turning it off takes effect for the very next message.
            </p>
            <p>
              When it is on, and only for messages FlowFi can&apos;t read confidently, FlowFi sends this to its own server,
              which passes it to <Strong>Anthropic</Strong>, an external AI provider, for classification:
            </p>
            <List
              items={[
                "the message text, with every run of 5 or more digits cut to its last 4 (amounts are kept)",
                "the bank name",
                "what FlowFi already found (amount, direction, masked account, reference number, merchant and category guesses)",
              ]}
            />
            <p>
              FlowFi uses the answer only to suggest the type, merchant and category for your review. FlowFi&apos;s server
              logs record a request id and any error, not the message. Anthropic processes the request under its own
              terms.
            </p>
            <p>With AI help off, FlowFi does not send message text from your phone.</p>
          </Section>

          <Section id="notifications" title="Notification access">
            <p>
              Some banks send alerts as RCS chat messages, which never reach the SMS inbox. If you grant notification
              access, FlowFi looks only at notifications from your default SMS app or a known messaging app, ignoring
              all others without reading them. From those it keeps only alerts that look financial and come from a
              bank or UPI service, and skips anything that looks like a one-time password. It stores the notification title, text and time on the
              phone (at most the latest 500), and handles them like bank SMS.
            </p>
          </Section>

          <Section id="device" title="Device information and diagnostics">
            <List
              items={[
                <>
                  <Strong>Pairing a phone</Strong> with FlowFi Web stores a random install id (not a hardware id), the
                  phone&apos;s manufacturer and model as its label, platform, app version and pairing time.
                </>,
                <>
                  <Strong>SMS Sync status</Strong>: the paired phone reports its SMS permission and Auto Sync state, the
                  time and outcome of its last scan and upload, counts and app version, so FlowFi Web can show setup
                  progress.
                </>,
                <>
                  <Strong>Crash reports</Strong>: the app uses Firebase Crashlytics to send crash details (stack trace,
                  device model, OS and app version) to Google. A crash report includes the error message of whatever failed.
                </>,
              ]}
            />
          </Section>

          <Section id="other" title="Other data and services">
            <p>
              The finances you enter or import (accounts, cards, transactions, loans, bills, people and settings) are
              stored in your account using Google Firebase (Authentication, Cloud Firestore, Cloud Storage and Cloud
              Functions), and are used only to run FlowFi for you. Camera access is requested only when you choose to
              scan a document, and text recognition for it runs on the phone.
            </p>
            <p>FlowFi does not sell data, show ads, use advertising identifiers or include an analytics SDK.</p>
          </Section>

          <Section id="retention" title="Retention and deletion">
            <List
              items={[
                <>
                  <Strong>Candidates</Strong> are kept until you import or dismiss them. Then the candidate is deleted
                  and a small record is kept (its id, imported or dismissed, the linked transaction id and when) so the
                  same message isn&apos;t offered again. That record is kept indefinitely.
                </>,
                <>
                  <Strong>On the phone</Strong>, SMS, notification and parsing data stay until you uninstall FlowFi or
                  clear its data.
                </>,
                <>
                  <Strong>Disconnecting a phone</Strong> (on the web or the phone) stops its uploads. Candidates already
                  uploaded are kept for your review.
                </>,
                <>
                  <Strong>Pairing codes</Strong> expire after 10 minutes and can be used only once.
                </>,
                <>
                  <Strong>Deleting your account</Strong>: there is no self-service option yet. Email <Contact /> from the
                  address you sign in with to ask for your account and its data to be deleted.
                </>,
              ]}
            />
          </Section>

          <Section id="controls" title="Your choices">
            <List
              items={[
                "Withdraw SMS or notification access at any time in Android settings.",
                "Turn Auto Sync and AI help on or off in the SMS Inbox.",
                "Dismiss any candidate you don't want, or disconnect a paired phone.",
                <>
                  Ask about or request access to your data: <Contact />.
                </>,
              ]}
            />
          </Section>

          <Section id="contact" title="Contact">
            <p>
              Questions about this policy: <Contact />. If this policy changes, the date at the top changes too.
            </p>
          </Section>
        </div>
      </article>
    </main>
  );
}
