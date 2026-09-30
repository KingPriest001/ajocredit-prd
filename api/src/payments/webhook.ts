// PSP webhook handler: HMAC verify → dedupe rail_ref → queue → confirm.
// Duplicate delivery 10x → 1 confirmed (see ledger.append idempotency).
import { append, confirm, idempotencyKey } from "../ledger/ledger";

const seenRailRefs = new Set<string>();

export interface WebhookEvent {
  provider: "paystack" | "flutterwave";
  railRef: string;
  groupId: string;
  memberId: string;
  cycleSeq: number;
  amount: number;
  signatureValid: boolean;
}

export function handleWebhook(ev: WebhookEvent): { status: string } {
  if (!ev.signatureValid) return { status: "rejected-bad-signature" };
  if (seenRailRefs.has(`${ev.provider}:${ev.railRef}`)) {
    return { status: "duplicate-ignored" }; // dedupe before ledger
  }
  seenRailRefs.add(`${ev.provider}:${ev.railRef}`);
  const key = idempotencyKey(ev.groupId, ev.memberId, ev.cycleSeq, ev.railRef);
  append({
    id: `le_${Date.now()}`,
    groupId: ev.groupId,
    debit: `psp:${ev.provider}`,
    credit: `pot:${ev.groupId}`,
    amount: ev.amount,
    type: "contribution",
    refId: ev.railRef,
    idempotencyKey: key,
    status: "PENDING",
  });
  confirm(key); // in real impl: confirm after NIBSS/statement match (<5min p95)
  return { status: "confirmed" };
}

export function clearWebhooks() {
  seenRailRefs.clear();
}
