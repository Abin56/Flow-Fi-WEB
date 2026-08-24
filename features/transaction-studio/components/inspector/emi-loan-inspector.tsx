"use client";

/**
 * Right-sidebar editor for Action = Existing/Create EMI, Existing/Create
 * Loan, Recurring Bill (architecture §5/§6). "Create New" stages the terms
 * only — the real `Emi`/`Loan` record isn't created until Approve & Import
 * (locked decision), matching the rest of the workspace's non-destructive
 * review discipline.
 */

import { useState } from "react";
import { Landmark, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrencyPrecise } from "@/lib/format";
import type { Emi } from "@/lib/models/emi";
import type { Loan } from "@/lib/models/loan";
import type { Bill } from "@/lib/models/bill";
import type { Person } from "@/lib/models/person";
import type { RecordActionDetail } from "@/lib/models/document-import";
import { deriveRecordAction } from "../../lib/action-metadata";
import type { GridRow } from "../../lib/grid-types";
import { InspectorShell } from "./inspector-shell";

export type EmiLoanTargetType = "existing_emi" | "create_emi" | "existing_loan" | "create_loan" | "recurring_bill";

export function EmiLoanInspector({
  row,
  emis,
  loans,
  bills,
  people,
  onCommit,
  onClose,
  hideClose,
  embedded,
}: {
  row: GridRow;
  emis: Emi[];
  loans: Loan[];
  bills: Bill[];
  people: Person[];
  onCommit: (action: EmiLoanTargetType, detail: RecordActionDetail) => void;
  onClose: () => void;
  hideClose?: boolean;
  embedded?: boolean;
}) {
  const [search, setSearch] = useState("");
  const action = deriveRecordAction(row);
  const isCreate = action === "create_emi" || action === "create_loan";
  const kind: "emi" | "loan" | "bill" = action === "existing_loan" || action === "create_loan" ? "loan" : action === "recurring_bill" ? "bill" : "emi";

  return (
    <InspectorShell
      title={isCreate ? `Create ${kind === "loan" ? "Loan" : "EMI"}` : "Link Payment"}
      subtitle={formatCurrencyPrecise(row.amount)}
      onClose={onClose}
      hideClose={hideClose}
      embedded={embedded}
    >
      <div className="flex flex-col gap-4">
        <Tabs value={kind}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="emi" onClick={() => onCommit(isCreate ? "create_emi" : "existing_emi", { kind: "existing_emi", emiId: "" })}>
              EMI
            </TabsTrigger>
            <TabsTrigger value="loan" onClick={() => onCommit(isCreate ? "create_loan" : "existing_loan", { kind: "existing_loan", loanId: "" })}>
              Loan
            </TabsTrigger>
            <TabsTrigger value="bill" onClick={() => onCommit("recurring_bill", { kind: "recurring_bill", billId: "" })}>
              Bill
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {!isCreate && kind !== "bill" && (
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${kind === "loan" ? "loans" : "EMIs"}…`} className="h-8 pl-8 text-sm" />
            </div>
            <div className="flex flex-col gap-1">
              {(kind === "loan" ? loans.filter((l) => !l.isClosed) : emis.filter((e) => !e.isClosed))
                .filter((item) => matchesSearch(item, kind, people, search))
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() =>
                      onCommit(
                        kind === "loan" ? "existing_loan" : "existing_emi",
                        kind === "loan" ? { kind: "existing_loan", loanId: item.id } : { kind: "existing_emi", emiId: item.id },
                      )
                    }
                    className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left text-sm hover:border-primary hover:bg-primary/5"
                  >
                    <Landmark className="size-3.5 shrink-0 text-warning" />
                    <span className="truncate">{"name" in item ? item.name || displayLoanName(item as Loan, people) : ""}</span>
                  </button>
                ))}
            </div>
          </>
        )}

        {!isCreate && kind === "bill" && (
          <div className="flex flex-col gap-1">
            {bills.map((bill) => (
              <button
                key={bill.id}
                type="button"
                onClick={() => onCommit("recurring_bill", { kind: "recurring_bill", billId: bill.id })}
                className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left text-sm hover:border-primary hover:bg-primary/5"
              >
                <Landmark className="size-3.5 shrink-0 text-warning" />
                <span className="truncate">{bill.name}</span>
              </button>
            ))}
          </div>
        )}

        {isCreate && kind === "emi" && (
          <CreateEmiForm row={row} onSubmit={(detail) => onCommit("create_emi", detail)} />
        )}
        {isCreate && kind === "loan" && (
          <CreateLoanForm row={row} people={people} onSubmit={(detail) => onCommit("create_loan", detail)} />
        )}
      </div>
    </InspectorShell>
  );
}

function displayLoanName(loan: Loan, people: Person[]): string {
  if (loan.name) return loan.name;
  return people.find((p) => p.id === loan.personId)?.name ?? "Untitled loan";
}

function matchesSearch(item: Emi | Loan, kind: "emi" | "loan", people: Person[], search: string): boolean {
  if (!search.trim()) return true;
  const name = kind === "loan" ? displayLoanName(item as Loan, people) : (item as Emi).name;
  return name.toLowerCase().includes(search.trim().toLowerCase());
}

function CreateEmiForm({ row, onSubmit }: { row: GridRow; onSubmit: (detail: RecordActionDetail) => void }) {
  const existing = row.actionDetail?.kind === "create_emi" ? row.actionDetail : null;
  const [name, setName] = useState(existing?.name ?? row.counterpartyNormalized ?? row.counterpartyRaw);
  const [principal, setPrincipal] = useState(String(existing?.principalAmount ?? ""));
  const [rate, setRate] = useState(String(existing?.interestRatePercent ?? ""));
  const [months, setMonths] = useState(String(existing?.months ?? 12));
  const [startDate, setStartDate] = useState(() => (existing?.startDate ?? row.date).toISOString().slice(0, 10));

  function submit() {
    const principalAmount = Number(principal);
    const monthsCount = Number(months);
    if (!name.trim() || !Number.isFinite(principalAmount) || principalAmount <= 0 || !Number.isFinite(monthsCount) || monthsCount <= 0) return;
    onSubmit({
      kind: "create_emi",
      name: name.trim(),
      principalAmount,
      interestRatePercent: rate ? Number(rate) : null,
      months: monthsCount,
      startDate: new Date(`${startDate}T00:00:00.000Z`),
    });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <LabeledInput label="Loan Name" value={name} onChange={setName} onBlur={submit} />
      <LabeledInput label="Principal" value={principal} onChange={setPrincipal} onBlur={submit} type="number" />
      <LabeledInput label="Interest Rate (%)" value={rate} onChange={setRate} onBlur={submit} type="number" />
      <LabeledInput label="Months" value={months} onChange={setMonths} onBlur={submit} type="number" />
      <LabeledInput label="Start Date" value={startDate} onChange={setStartDate} onBlur={submit} type="date" />
      <Button size="sm" onClick={submit}>
        Stage EMI
      </Button>
    </div>
  );
}

function CreateLoanForm({ row, people, onSubmit }: { row: GridRow; people: Person[]; onSubmit: (detail: RecordActionDetail) => void }) {
  const existing = row.actionDetail?.kind === "create_loan" ? row.actionDetail : null;
  const [name, setName] = useState(existing?.name ?? row.counterpartyNormalized ?? row.counterpartyRaw);
  const [personId, setPersonId] = useState(existing?.personId ?? people[0]?.id ?? "");
  const [amount, setAmount] = useState(String(existing?.loanAmount ?? row.amount));
  const [rate, setRate] = useState(String(existing?.interestRatePercent ?? ""));
  const [months, setMonths] = useState(String(existing?.months ?? ""));
  const [startDate, setStartDate] = useState(() => (existing?.startDate ?? row.date).toISOString().slice(0, 10));

  function submit() {
    const loanAmount = Number(amount);
    if (!name.trim() || !personId || !Number.isFinite(loanAmount) || loanAmount <= 0) return;
    onSubmit({
      kind: "create_loan",
      name: name.trim(),
      personId,
      loanAmount,
      interestRatePercent: rate ? Number(rate) : null,
      months: months ? Number(months) : null,
      startDate: new Date(`${startDate}T00:00:00.000Z`),
    });
  }

  return (
    <div className="flex flex-col gap-2.5">
      <LabeledInput label="Loan Name" value={name} onChange={setName} onBlur={submit} />
      <div>
        <Label className="mb-1 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">Lender / Person</Label>
        <select
          value={personId}
          onChange={(e) => {
            setPersonId(e.target.value);
            submit();
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
        >
          <option value="" disabled>
            Choose a person
          </option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <LabeledInput label="Amount" value={amount} onChange={setAmount} onBlur={submit} type="number" />
      <LabeledInput label="Interest Rate (%)" value={rate} onChange={setRate} onBlur={submit} type="number" />
      <LabeledInput label="Months (optional)" value={months} onChange={setMonths} onBlur={submit} type="number" />
      <LabeledInput label="Start Date" value={startDate} onChange={setStartDate} onBlur={submit} type="date" />
      <Button size="sm" onClick={submit}>
        Stage Loan
      </Button>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  onBlur,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  type?: string;
}) {
  return (
    <div>
      <Label className="mb-1 block text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</Label>
      <Input value={value} type={type} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} className="h-9 text-sm" />
    </div>
  );
}
