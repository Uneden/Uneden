import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";

const { stripe, notifications, finalize } = vi.hoisted(() => ({
  stripe: { refunds: { create: vi.fn() } },
  notifications: { createLocalizedNotification: vi.fn(async () => {}), getUserLang: vi.fn(async () => "fr") },
  finalize: vi.fn(async () => true),
}));
const fake = createFakeDb();

vi.mock("../src/config/db.js", () => ({ default: fake.pool }));
vi.mock("../src/config/stripe.js", () => ({ default: stripe }));
vi.mock("../src/services/notificationService.js", () => notifications);
vi.mock("../src/services/emailService.js", () => ({ notifyPaymentReceipt: vi.fn() }));
vi.mock("../src/controllers/bookingController.js", () => ({ finalizeCompletion: finalize }));

const { applySuccessfulPayment, bookingAcceptsPayment } = await import("../src/services/paymentCompletionService.js");
const { splitRefundAcrossCharges, processBookingRefund } = await import("../src/services/refundService.js");

const BOOKING = {
  id: "b1",
  client_id: "client",
  worker_id: "worker",
  status: "accepted",
  payment_status: "unpaid",
  paid_service_base_cents: 0,
  pricing_mode: "fixed",
  service_price: 100,
};

function setup({ payment = { id: "row1", status: "pending" }, booking = BOOKING } = {}) {
  fake.reset();
  fake.on(/SELECT id, status FROM payments/, () => (payment ? [payment] : []));
  fake.on(/FROM bookings b JOIN services s ON s.id = b.service_id JOIN users uc/, () => [booking]);
  fake.on(/SELECT b.client_id, p.amount/, () => [
    { client_id: "client", amount: 11497, payment_kind: "full", title: "Cours", worker_name: "W", client_name: "C", client_email: "c@x" },
  ]);
}

const pay = (overrides = {}) =>
  applySuccessfulPayment({
    bookingId: "b1",
    paymentIntentId: "pi_1",
    paymentKind: "full",
    paidServiceCents: 10000,
    totalAmountCents: 11497,
    buyerCommissionCents: 500,
    taxesCents: 997,
    ...overrides,
  });

describe("applySuccessfulPayment", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks the payment paid and the booking active in one committed transaction", async () => {
    setup();
    await pay();
    const sql = fake.queries.map((q) => q.sql);
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("COMMIT");
    expect(fake.find(/UPDATE payments SET status = 'paid'/)).toHaveLength(1);
    expect(fake.find(/UPDATE bookings SET payment_status = 'paid', status = 'active'/)).toHaveLength(1);
    // Booking locked while it is read and updated.
    expect(fake.find(/FOR UPDATE OF b/)).toHaveLength(1);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refunds a payment that lands on a cancelled booking instead of keeping it", async () => {
    setup({ booking: { ...BOOKING, status: "cancelled" } });
    await pay();
    expect(fake.find(/UPDATE payments SET status = 'paid'/)).toHaveLength(0);
    expect(fake.find(/UPDATE bookings/)).toHaveLength(0);
    expect(fake.find(/SET status = 'refunding'/)).toHaveLength(1);
    expect(stripe.refunds.create).toHaveBeenCalledWith(
      { payment_intent: "pi_1" },
      { idempotencyKey: "unapplied-payment:pi_1" },
    );
    expect(fake.find(/SET status = 'refunded'/)).toHaveLength(1);
    expect(notifications.createLocalizedNotification).toHaveBeenCalled();
  });

  it("refunds an attempt that was superseded but still got paid", async () => {
    setup({ payment: { id: "row1", status: "cancelled" } });
    await pay();
    expect(fake.find(/UPDATE payments SET status = 'paid'/)).toHaveLength(0);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a payment already applied (webhook + verify)", async () => {
    setup({ payment: { id: "row1", status: "paid" } });
    await pay();
    expect(fake.find(/^UPDATE/)).toHaveLength(0);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("retries a refund that failed after being recorded", async () => {
    setup({ payment: { id: "row1", status: "refunding" } });
    await pay();
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("rolls everything back and throws when a write fails, so Stripe retries", async () => {
    setup();
    fake.on(/UPDATE bookings SET payment_status = 'paid'/, () => new Error("connection lost"));
    await expect(pay()).rejects.toThrow("connection lost");
    const sql = fake.queries.map((q) => q.sql);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
  });

  it("only applies a balance to an active booking with the deposit paid", async () => {
    setup({ booking: { ...BOOKING, status: "active", payment_status: "deposit_paid" } });
    await pay({ paymentKind: "balance" });
    expect(fake.find(/UPDATE payments SET status = 'paid'/)).toHaveLength(1);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe("bookingAcceptsPayment", () => {
  it.each([
    [{ status: "accepted", payment_status: "unpaid" }, "full", true],
    [{ status: "accepted", payment_status: null }, "deposit", true],
    [{ status: "cancelled", payment_status: "unpaid" }, "full", false],
    [{ status: "rejected", payment_status: "unpaid" }, "deposit", false],
    [{ status: "active", payment_status: "paid" }, "full", false],
    [{ status: "negotiating", payment_status: "unpaid" }, "full", false],
    [{ status: "active", payment_status: "deposit_paid" }, "balance", true],
    [{ status: "completed", payment_status: "deposit_paid" }, "balance", true],
    [{ status: "cancelled", payment_status: "deposit_paid" }, "balance", false],
  ])("%o + %s → %s", (booking, kind, expected) => {
    expect(bookingAcceptsPayment(booking, kind)).toBe(expected);
  });
});

describe("refunds", () => {
  it("splits a refund over deposit and balance charges, newest first", () => {
    expect(splitRefundAcrossCharges(15000, [10000, 8000])).toEqual([10000, 5000]);
    expect(splitRefundAcrossCharges(5000, [10000, 8000])).toEqual([5000, 0]);
  });

  it("refuses a refund larger than what the charges can still refund", () => {
    expect(splitRefundAcrossCharges(20000, [10000, 8000])).toBeNull();
  });

  it.each([undefined, null, "abc", 49, 101])("rejects refund percentage %s with a 400", async (pct) => {
    await expect(processBookingRefund({ bookingId: "b1", refundPercentage: pct })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
