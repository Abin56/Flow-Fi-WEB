This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Financial Document Intelligence Engine

See `docs/architecture.md` (locked v1.0), `docs/backlog.md`, and `docs/adr/` for the design/implementation source of truth. Cloud Functions live in `functions/` (separate package — `npm install` there too).

Test commands:

```bash
npm test                 # web app unit tests (no emulator needed)
npm run test:rules       # Firestore + Storage security rules, against a real emulator
npm run test:functions   # Cloud Functions package, against a real Firestore emulator
```

**Known local dev friction:** the Firebase Emulator Suite doesn't always shut down cleanly on Windows after `firebase emulators:exec` — a leftover Java process can hold port 8080 and/or 9199, causing the *next* `test:rules`/`test:functions` run to fail with "port taken." If that happens:

```bash
netstat -ano | grep -E ':8080|:9199'   # find the PID(s) still listening
# then, in PowerShell:
Stop-Process -Id <pid> -Force
```

This is an emulator-tooling quirk, not a sign the tests themselves are broken.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
