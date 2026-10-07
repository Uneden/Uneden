import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";

const { stripe, completion } = vi.hoisted(() => ({
  stripe: {
    paymentIntents: { retrieve: vi.fn(), cancel: vi.fn() },
    checkout: { sessions: { retrieve: vi.fn(), expire: vi.fn() } },
  },
  completion: { completePaymentFromIntent: vi.fn(), completeCheckoutPayment: vi.fn() },
}));
const fake = createFakeDb();

vi.mock("../src/config/db.js", () => ({ default: fake.pool }));
vi.mock("../src/config/stripe.js", () => ({ default: stripe }));
vi.mock("../src/services/paymentCompletionService.js", () => completion);

const { settlePendingPayments, PaymentConflictError } = await import("../src/services/paymentGuards.js");

const intent = (overrides = {}) => ({
  id: "pi_old",
  status: "requires_payment_method",
  amount: 11497,
  customer: "cus_1",
  metadata: { payment_kind: "full", service_price_cents: "10000", taxes_cents: "1497" },
  ...overrides,
});

describe("settlePendingPayments", () => {
  beforeEach(() => {
    fake.reset();
    vi.clearAllMocks();
    fake.on(/FROM payments WHERE booking_id = \$1 AND status = 'pending'/, () => [
      { id: "row1", stripe_payment_intent_id: "pi_old", stripe_checkout_session_id: null },
    ]);
  });

  const markedCancelled = () => fake.find(/UPDATE payments SET status = 'cancelled'/);

  it("hands back an earlier attempt for the same charge instead of creating a second one", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue(intent());
    const reusable = await settlePendingPayments("b1", { reuse: (pi) => pi.amount === 11497 });
    expect(reusable.id).toBe("pi_old");
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(markedCancelled()).toHaveLength(0);
  });

  it("cancels an attempt for a different amount at Stripe before forgetting it", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue(intent());
    stripe.paymentIntents.cancel.mockResolvedValue(intent({ status: "canceled" }));
    const reusable = await settlePendingPayments("b1", { reuse: (pi) => pi.amount === 999 });
    expect(reusable).toBeNull();
    expect(stripe.paymentIntents.cancel).toHaveBeenCalledWith("pi_old");
    expect(markedCancelled()).toHaveLength(1);
  });

  it("applies an attempt that was already paid and stops the caller", async () => {
    const paid = intent({ status: "succeeded" });
    stripe.paymentIntents.retrieve.mockResolvedValue(paid);
    await expect(settlePendingPayments("b1")).rejects.toMatchObject({ code: "ALREADY_PAID", statusCode: 409 });
    expect(completion.completePaymentFromIntent).toHaveBeenCalledWith(paid);
    expect(markedCancelled()).toHaveLength(0);
  });

  it("refuses to go on while a payment is processing", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue(intent({ status: "processing" }));
    const error = await settlePendingPayments("b1").catch((err) => err);
    expect(error).toBeInstanceOf(PaymentConflictError);
    expect(error.code).toBe("PAYMENT_IN_PROGRESS");
    expect(markedCancelled()).toHaveLength(0);
  });

  it("treats an attempt confirmed during the cancel as paid", async () => {
    stripe.paymentIntents.retrieve
      .mockResolvedValueOnce(intent())
      .mockResolvedValueOnce(intent({ status: "succeeded" }));
    stripe.paymentIntents.cancel.mockRejectedValue(new Error("already succeeded"));
    await expect(settlePendingPayments("b1")).rejects.toMatchObject({ code: "ALREADY_PAID" });
  });

  it("never marks an attempt cancelled when Stripe did not cancel it", async () => {
    stripe.paymentIntents.retrieve.mockResolvedValue(intent());
    stripe.paymentIntents.cancel.mockRejectedValue(new Error("network"));
    await expect(settlePendingPayments("b1")).rejects.toThrow(/Could not cancel/);
    expect(markedCancelled()).toHaveLength(0);
  });

  it("expires an open Checkout Session", async () => {
    fake.on(/FROM payments WHERE booking_id = \$1 AND status = 'pending'/, () => [
      { id: "row2", stripe_payment_intent_id: null, stripe_checkout_session_id: "cs_1" },
    ]);
    stripe.checkout.sessions.retrieve.mockResolvedValue({ id: "cs_1", status: "open", payment_status: "unpaid" });
    stripe.checkout.sessions.expire.mockResolvedValue({ id: "cs_1", status: "expired", payment_status: "unpaid" });
    await settlePendingPayments("b1");
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_1");
    expect(markedCancelled()).toHaveLength(1);
  });
});

