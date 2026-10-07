import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";

const { stripe } = vi.hoisted(() => ({
  stripe: {
    paymentIntents: { retrieve: vi.fn(async () => ({ latest_charge: "ch_1" })) },
    transfers: { create: vi.fn() },
  },
}));
const fake = createFakeDb();

vi.mock("../src/config/db.js", () => ({ default: fake.pool }));
vi.mock("../src/config/stripe.js", () => ({ default: stripe }));
vi.mock("../src/services/emailService.js", () => ({ notifyPayoutReceived: vi.fn(async () => {}) }));
vi.mock("../src/services/notificationService.js", () => ({
  createNotification: vi.fn(async () => {}),
  getUserLang: vi.fn(async () => "fr"),
}));
vi.mock("../src/controllers/bookingController.js", () => ({ finalizeCompletion: vi.fn(async () => true) }));
vi.mock("../src/services/auditService.js", () => ({ logAdminAction: vi.fn(async () => {}) }));

const { processUserPayout } = await import("../src/services/payoutService.js");
const { runScheduledPayout } = await import("../src/controllers/walletController.js");

const CREDIT = { tx_id: "tx1", amount: "95.00", booking_id: "b1", previous_payment_status: "paid", stripe_payment_intent_id: "pi_1" };

function setup({ claimed = true } = {}) {
  fake.reset();
  fake.on(/FROM stripe_accounts/, () => [{ stripe_account_id: "acct_1" }]);
  fake.on(/FROM users WHERE id/, () => [{ email: "w@x", display_name: "W" }]);
  fake.on(/FROM transactions t JOIN bookings b/, () => [CREDIT]);
  fake.on(/UPDATE bookings SET payment_status = 'transferred' WHERE id = \$1 AND payment_status = ANY/, () =>
    claimed ? [{ id: "b1" }] : [],
  );
}

describe("processUserPayout", () => {
  beforeEach(() => vi.clearAllMocks());

  it("selects completed bookings and cancelled ones with a retained deposit, never under open dispute", async () => {
    setup();
    stripe.transfers.create.mockResolvedValue({ id: "tr_1" });
    await processUserPayout("worker");
    const [credits] = fake.find(/FROM transactions t JOIN bookings b/);
    expect(credits.sql).toContain("b.status IN ('completed', 'cancelled')");
    expect(credits.sql).toMatch(/NOT EXISTS \( SELECT 1 FROM disputes d WHERE d.booking_id = b.id AND d.status = 'open' \)/);
  });

  it("claims the booking before transferring, with an idempotency key, and records the transfer id", async () => {
    setup();
    stripe.transfers.create.mockResolvedValue({ id: "tr_1" });
    const result = await processUserPayout("worker");

    const claimIndex = fake.queries.findIndex((q) => /SET payment_status = 'transferred' WHERE id = \$1 AND payment_status = ANY/.test(q.sql));
    expect(claimIndex).toBeGreaterThan(-1);
    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9500, destination: "acct_1", source_transaction: "ch_1" }),
      { idempotencyKey: "payout:b1:tx1" },
    );
    const [paymentsUpdate] = fake.find(/UPDATE payments SET status = 'transferred', stripe_transfer_id/);
    expect(paymentsUpdate.params).toEqual(["b1", "tr_1"]);
    expect(fake.find(/UPDATE wallets SET balance = GREATEST/)).toHaveLength(1);
    expect(result.transferred_cents).toBe(9500);
  });

  it("skips a booking another run already claimed: no second transfer", async () => {
    setup({ claimed: false });
    const result = await processUserPayout("worker");
    expect(stripe.transfers.create).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("releases the claim when the transfer fails, so the next run retries", async () => {
    setup();
    stripe.transfers.create.mockRejectedValue(new Error("insufficient funds"));
    const result = await processUserPayout("worker");
    const [release] = fake.find(/UPDATE bookings SET payment_status = \$2 WHERE id = \$1 AND payment_status = 'transferred'/);
    expect(release.params).toEqual(["b1", "paid"]);
    expect(fake.find(/UPDATE wallets/)).toHaveLength(0);
    expect(result).toBeNull();
  });
});

describe("runScheduledPayout", () => {
  const SECRET = "s".repeat(40);
  const call = (authorization) => {
    const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
    return runScheduledPayout({ get: () => authorization }, res).then(() => res);
  };

  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
  });

  it.each([undefined, "", "Bearer wrong", `Bearer ${SECRET}x`])("rejects authorization %j", async (auth) => {
    const res = await call(auth);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("refuses when the server has no (or a short) secret configured", async () => {
    process.env.CRON_SECRET = "short";
    const res = await call("Bearer short");
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("does nothing outside payout Fridays", async () => {
    vi.setSystemTime(new Date("2026-10-07T16:10:00Z")); // a Wednesday
    const res = await call(`Bearer ${SECRET}`);
    expect(res.json).toHaveBeenCalledWith({ skipped: true, reason: "Not a payout day" });
  });
});
