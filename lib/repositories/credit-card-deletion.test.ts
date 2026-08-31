import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { Emi } from "@/lib/models/emi";
import type { CreditCardRepository, SharedCreditLimitRepository } from "./credit-card-repository";
import type { EmiRepository } from "./emi-repository";
import type { AccountDeletionRepos } from "./account-deletion";

/**
 * Covers the credit-card-specific extras `permanentlyDeleteCreditCardAndHistory` cascades beyond
 * what `account-deletion.ts` already handles for a plain account (covered separately in
 * `account-deletion.test.ts`): linked EMIs, statements + their payments, and an orphaned shared
 * credit limit. `./account-deletion`'s own account-history cascade is mocked here so these tests
 * stay focused on the card-specific logic instead of re-testing it.
 */
const accountHistoryMock = vi.hoisted(() => ({
  permanentlyDeleteAccountHistory: vi.fn(async () => {}),
  previewAccountDeletionImpact: vi.fn(async () => ({
    transactionCount: 0,
    transferSiblingCount: 0,
    expenseCount: 0,
    affectedPersonCount: 0,
    billCount: 0,
  })),
}));
vi.mock("./account-deletion", () => accountHistoryMock);

interface FakeDocSnapshot {
  ref: { id: string };
}
interface FakeCollectionRef {
  parentId: string;
  name: string;
}

const statementDocsByCard = vi.hoisted(() => new Map<string, FakeDocSnapshot[]>());
const paymentDocsByStatement = vi.hoisted(() => new Map<string, FakeDocSnapshot[]>());

vi.mock("firebase/firestore", () => ({
  collection: vi.fn((parent: { id: string }, name: string): FakeCollectionRef => ({ parentId: parent.id, name })),
  getDocs: vi.fn(async (ref: FakeCollectionRef) => {
    const docs =
      ref.name === "statements"
        ? (statementDocsByCard.get(ref.parentId) ?? [])
        : ref.name === "statementPayments"
          ? (paymentDocsByStatement.get(ref.parentId) ?? [])
          : [];
    return { size: docs.length, docs };
  }),
  writeBatch: vi.fn(() => {
    const ops: Array<{ type: "delete"; ref: unknown }> = [];
    return {
      delete: vi.fn((ref: unknown) => ops.push({ type: "delete", ref })),
      commit: vi.fn(async () => {
        committedDeletes.push(...ops.map((o) => o.ref));
      }),
    };
  }),
}));
vi.mock("@/lib/firebase/client", () => ({ db: {} }));

import {
  permanentlyDeleteCreditCardAndHistory,
  previewCreditCardDeletionImpact,
  type CreditCardDeletionRepos,
} from "./credit-card-deletion";

let committedDeletes: unknown[] = [];

function card(overrides: Partial<CreditCardProfile> = {}): CreditCardProfile {
  return {
    id: "card-1",
    accountId: "acc-card-1",
    sharedLimitId: null,
    statementDay: 15,
    paymentDueDay: 5,
    creditLimit: 50000,
    minimumDuePercent: null,
    autoPay: false,
    status: "active",
    cardNetwork: null,
    lastFourDigits: null,
    issuer: null,
    annualFee: 0,
    joiningFee: 0,
    interestRatePercent: null,
    rewardNotes: null,
    autoDebitAccount: null,
    cardHolderName: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function emi(overrides: Partial<Emi> = {}): Emi {
  return {
    id: "emi-1",
    name: "Phone EMI",
    lenderName: null,
    categoryId: null,
    principalAmount: 20000,
    interest: null,
    startDate: new Date("2026-01-01T00:00:00Z"),
    installmentFrequency: "monthly",
    installmentCount: 12,
    endDate: new Date("2026-12-01T00:00:00Z"),
    notes: "",
    scheduleId: "schedule-emi-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    loanNumber: null,
    loanType: "other",
    branch: null,
    customerId: null,
    sanctionDate: null,
    disbursementDate: null,
    processingFee: 0,
    insuranceAmount: 0,
    extraCharges: 0,
    foreclosureAmount: null,
    prepaymentCharges: null,
    isAutoDebitEnabled: false,
    autoDebitAccount: null,
    isDefaulted: false,
    linkedCreditCardId: "card-1",
    dueDayOfMonth: null,
    isClosed: false,
    deletedAt: null,
    lastEditedAt: null,
    editHistory: [],
    ...overrides,
  };
}

function makeFixture(params: {
  cards?: CreditCardProfile[];
  emis?: Emi[];
  statements?: FakeDocSnapshot[];
  paymentsByStatementId?: Record<string, FakeDocSnapshot[]>;
  sharedLimit?: { id: string; permanentlyDeleted?: boolean } | null;
}) {
  const { cards = [], emis = [], statements = [], paymentsByStatementId = {}, sharedLimit = null } = params;
  statementDocsByCard.set("acc-card-1", statements);
  for (const [statementId, payments] of Object.entries(paymentsByStatementId)) {
    paymentDocsByStatement.set(statementId, payments);
  }

  const emiRepository = {
    getAll: vi.fn(async () => emis),
    getTrash: vi.fn(async () => []),
    permanentlyDeleteEmi: vi.fn(async () => {}),
  } as unknown as EmiRepository;

  // Every test in this file exercises a single card whose statements live under the fixed
  // "acc-card-1" key `statementDocsByCard`/`paymentDocsByStatement` are seeded with above, so
  // `docRef` doesn't need to vary by the id it's called with.
  const creditCardRepository = {
    getAll: vi.fn(async () => cards),
    docRef: vi.fn(() => ({ id: "acc-card-1" })),
    permanentlyDelete: vi.fn(async () => {}),
  } as unknown as CreditCardRepository;

  const sharedCreditLimitRepository = {
    getByKey: vi.fn(async (id: string) => (sharedLimit && sharedLimit.id === id ? { id, deletedAt: null } : null)),
    permanentlyDelete: vi.fn(async () => {}),
  } as unknown as SharedCreditLimitRepository;

  const accountRepository = {
    getByKey: vi.fn(async () => ({ id: "acc-card-1" })),
    permanentlyDelete: vi.fn(async () => {}),
  };

  const repos: CreditCardDeletionRepos = {
    uid: "user-1",
    transactionRepository: {} as AccountDeletionRepos["transactionRepository"],
    accountRepository: accountRepository as unknown as AccountDeletionRepos["accountRepository"],
    billRepository: {} as AccountDeletionRepos["billRepository"],
    expenseRepository: {} as AccountDeletionRepos["expenseRepository"],
    personRepository: {} as AccountDeletionRepos["personRepository"],
    ledgerRepositoryFor: vi.fn(),
    paymentScheduleRepository: {} as AccountDeletionRepos["paymentScheduleRepository"],
    installmentRepositoryFor: vi.fn(),
    creditCardRepository,
    sharedCreditLimitRepository,
    emiRepository,
  };

  return { repos, emiRepository, creditCardRepository, sharedCreditLimitRepository, accountRepository };
}

// `creditCardRepository.docRef` always resolves to the fixed "acc-card-1" statements-subcollection
// parent id above — the tests below only ever use a single card, so this simplification is safe.

describe("previewCreditCardDeletionImpact", () => {
  beforeEach(() => {
    statementDocsByCard.clear();
    paymentDocsByStatement.clear();
  });

  it("reports linked EMI/statement counts and flags an orphaned shared limit", async () => {
    const theCard = card({ id: "card-1", sharedLimitId: "limit-1" });
    const linkedEmi = emi({ linkedCreditCardId: "card-1" });
    const unrelatedEmi = emi({ id: "emi-2", linkedCreditCardId: "card-other" });
    const statements: FakeDocSnapshot[] = [{ ref: { id: "stmt-1" } }, { ref: { id: "stmt-2" } }];

    const { repos } = makeFixture({
      cards: [theCard],
      emis: [linkedEmi, unrelatedEmi],
      statements,
      sharedLimit: { id: "limit-1" },
    });

    const impact = await previewCreditCardDeletionImpact(theCard, repos);

    expect(impact.emiCount).toBe(1);
    expect(impact.statementCount).toBe(2);
    expect(impact.sharedLimitWillBeRemoved).toBe(true);
  });

  it("does not flag the shared limit for removal when a sibling card still uses it", async () => {
    const theCard = card({ id: "card-1", sharedLimitId: "limit-1" });
    const sibling = card({ id: "card-2", sharedLimitId: "limit-1" });

    const { repos } = makeFixture({ cards: [theCard, sibling], sharedLimit: { id: "limit-1" } });

    const impact = await previewCreditCardDeletionImpact(theCard, repos);

    expect(impact.sharedLimitWillBeRemoved).toBe(false);
  });
});

describe("permanentlyDeleteCreditCardAndHistory", () => {
  beforeEach(() => {
    statementDocsByCard.clear();
    paymentDocsByStatement.clear();
    committedDeletes = [];
    accountHistoryMock.permanentlyDeleteAccountHistory.mockClear();
  });

  it("cascades linked EMIs, statement payments/statements, an orphaned shared limit, then the account history and the card/account docs", async () => {
    const theCard = card({ id: "card-1", sharedLimitId: "limit-1", accountId: "acc-card-1" });
    const linkedEmi = emi({ id: "emi-1", linkedCreditCardId: "card-1" });
    const statements: FakeDocSnapshot[] = [{ ref: { id: "stmt-1" } }];
    const payments: FakeDocSnapshot[] = [{ ref: { id: "pay-1" } }];

    const { repos, emiRepository, sharedCreditLimitRepository, creditCardRepository, accountRepository } = makeFixture({
      cards: [theCard],
      emis: [linkedEmi],
      statements,
      paymentsByStatementId: { "stmt-1": payments },
      sharedLimit: { id: "limit-1" },
    });

    await permanentlyDeleteCreditCardAndHistory(theCard, repos);

    expect(emiRepository.permanentlyDeleteEmi).toHaveBeenCalledWith(linkedEmi);
    expect(committedDeletes).toContainEqual({ id: "pay-1" });
    expect(committedDeletes).toContainEqual({ id: "stmt-1" });
    expect(sharedCreditLimitRepository.permanentlyDelete).toHaveBeenCalledWith({ id: "limit-1", deletedAt: null });
    expect(accountHistoryMock.permanentlyDeleteAccountHistory).toHaveBeenCalledWith("acc-card-1", repos);
    expect(creditCardRepository.permanentlyDelete).toHaveBeenCalledWith(theCard);
    expect(accountRepository.permanentlyDelete).toHaveBeenCalled();
  });

  it("leaves the shared limit alone when a sibling card still uses it", async () => {
    const theCard = card({ id: "card-1", sharedLimitId: "limit-1", accountId: "acc-card-1" });
    const sibling = card({ id: "card-2", sharedLimitId: "limit-1" });

    const { repos, sharedCreditLimitRepository } = makeFixture({ cards: [theCard, sibling], sharedLimit: { id: "limit-1" } });

    await permanentlyDeleteCreditCardAndHistory(theCard, repos);

    expect(sharedCreditLimitRepository.permanentlyDelete).not.toHaveBeenCalled();
  });
});
