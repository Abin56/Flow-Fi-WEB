import type { Person } from "@/lib/models/person";
import { createCategoryRepository, createPersonPaymentRepository } from "@/lib/repositories/repository-factory";

/** The reverter passed to `permanentlyDeleteAgreement` — People's own "Revert payment" (cash leg, entries, person balance), unchanged. */
export function personPaymentReverter(uid: string): (person: Person, paymentId: string) => Promise<void> {
  return async (person, paymentId) => {
    const category = await createCategoryRepository(uid).getOrCreatePersonalLoanCategory();
    await createPersonPaymentRepository(uid, person.id, category.id).revertPayment(person, paymentId);
  };
}
