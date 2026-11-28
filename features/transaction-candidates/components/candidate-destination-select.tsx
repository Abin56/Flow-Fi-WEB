"use client";

import { AccountSelect, creditCardOption } from "@/components/finance/account-label";
import type { Account } from "@/lib/models/account";
import type { CreditCardProfile } from "@/lib/models/credit-card";
import type { DestinationOption } from "../lib/candidate-details-view";

export function CandidateDestinationSelect({ options, accounts, cards, value, onChange, className, invalid }: {
  options: DestinationOption[];
  accounts: Account[];
  cards: CreditCardProfile[];
  value: string | null;
  onChange: (key: string) => void;
  className?: string;
  invalid?: boolean;
}) {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const choices = options.map(({ key, label }) => {
    const [kind, id] = key.split(":");
    if (kind === "card") {
      const card = cardsById.get(id);
      if (card) return { ...creditCardOption(card, accountsById.get(card.accountId)), id: key };
    }
    const account = accountsById.get(id);
    return { ...account, id: key, name: account?.name ?? label };
  });

  return (
    <AccountSelect
      accounts={choices}
      value={value ?? ""}
      onChange={onChange}
      placeholder="Select an account or card"
      ariaLabel="Account or card"
      className={className}
      invalid={invalid}
    />
  );
}
