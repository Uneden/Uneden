import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";

const { guards } = vi.hoisted(() => ({
  guards: { settlePendingPayments: vi.fn(async () => null) },
}));
const fake = createFakeDb();

vi.mock("../src/config/db.js", () => ({ default: fake.pool }));
vi.mock("../src/config/stripe.js", () => ({ default: {} }));
vi.mock("../src/services/emailService.js", () => ({
  notifyBookingCreated: vi.fn(async () => {}),
  notifyBookingStatusUpdated: vi.fn(async () => {}),
  sendEmail: vi.fn(async () => {}),
}));
vi.mock("../src/services/pushService.js", () => ({
  pushNewBooking: vi.fn(async () => {}),
  pushBookingStatus: vi.fn(async () => {}),
  pushPriceProposed: vi.fn(async () => {}),
  pushPriceConfirmRequest: vi.fn(async () => {}),
  pushPriceAgreed: vi.fn(async () => {}),
}));
vi.mock("../src/services/notificationService.js", () => ({
  createLocalizedNotification: vi.fn(async () => {}),
  getUserLang: vi.fn(async () => "fr"),
  shouldSendEmail: vi.fn(async () => false),
}));
vi.mock("../src/services/paymentGuards.js", async (importOriginal) => ({
  ...(await importOriginal()),
  settlePendingPayments: guards.settlePendingPayments,
}));

const { updateBookingStatus, finalizeCompletion } = await import("../src/controllers/bookingController.js");
const { PaymentConflictError } = await import("../src/services/paymentGuards.js");

const BOOKING = {
  id: "b1",
  client_id: "client",
  worker_id: "worker",
  service_id: "s1",
  service_type: "offer",
  status: "pending",
  payment_status: "unpaid",
  title: "Cours",
};

function setup(booking) {
  fake.reset();
  fake.on(/FROM bookings b JOIN services s ON b.service_id = s.id JOIN users u/, () => [{ ...BOOKING, ...booking }]);
  fake.on(/^UPDATE bookings SET status = \$1/, () => [{ ...BOOKING, ...booking, status: "updated" }]);
}

async function changeStatus(status, userId) {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  await updateBookingStatus({ params: { id: "b1" }, body: { status }, user: { id: userId }, lang: "fr" }, res);
  return res;
}
const statusCode = (res) => res.status.mock.calls[0]?.[0] ?? 200;

describe("updateBookingStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["accepted", { status: "pending" }, "worker", 200],
    ["rejected", { status: "pending" }, "worker", 200],
    ["cancelled", { status: "accepted" }, "client", 200],
    // The bug: the poster could reject a paid, in-progress booking.
    ["rejected", { status: "active", payment_status: "paid" }, "worker", 409],
    ["accepted", { status: "cancelled" }, "worker", 409],
    ["accepted", { status: "rejected" }, "worker", 409],
    ["cancelled", { status: "active", payment_status: "paid" }, "client", 409],
    ["cancelled", { status: "completed", payment_status: "paid" }, "client", 409],
    ["cancelled", { status: "accepted", payment_status: "deposit_paid" }, "client", 409],
    ["active", { status: "accepted" }, "client", 400],
    ["completed", { status: "active" }, "worker", 400],
  ])("%s from %o by %s → %i", async (status, booking, userId, expected) => {
    setup(booking);
    const res = await changeStatus(status, userId);
    expect(statusCode(res)).toBe(expected);
  });

  it("only the listing poster accepts", async () => {
    setup({ status: "pending" });
    expect(statusCode(await changeStatus("accepted", "client"))).toBe(403);
  });

  it("updates only if the status is still the one read (concurrent clicks)", async () => {
    setup({ status: "pending" });
    await changeStatus("accepted", "worker");
    const [update] = fake.find(/^UPDATE bookings SET status = \$1/);
    expect(update.sql).toContain("WHERE id = $2 AND status = $5");
    expect(update.params[4]).toBe("pending");
  });

  it("answers 409 when the booking changed in the meantime", async () => {
    setup({ status: "pending" });
    fake.on(/^UPDATE bookings SET status = \$1/, () => []);
    expect(statusCode(await changeStatus("accepted", "worker"))).toBe(409);
  });

  it("cancels pending payment attempts before cancelling the booking", async () => {
    setup({ status: "accepted" });
    await changeStatus("cancelled", "client");
    expect(guards.settlePendingPayments).toHaveBeenCalledWith("b1", { lang: "fr" });
  });

  it("does not cancel a booking whose payment just went through", async () => {
    setup({ status: "accepted" });
    guards.settlePendingPayments.mockRejectedValueOnce(new PaymentConflictError("ALREADY_PAID"));
    const res = await changeStatus("cancelled", "client");
    expect(statusCode(res)).toBe(409);
    expect(fake.find(/^UPDATE bookings SET status/)).toHaveLength(0);
  });
});

describe("finalizeCompletion", () => {
  const completed = { id: "b1", worker_id: "worker", client_id: "client", payment_status: "paid", title: "Cours", custom_price: 100 };

  it("credits the worker once: the unique index turns a concurrent second credit into a no-op", async () => {
    fake.reset();
    let credits = 0;
    fake.on(/INSERT INTO transactions/, () => (credits++ === 0 ? [{ id: "t1" }] : []));

    const results = await Promise.all([finalizeCompletion(completed), finalizeCompletion(completed)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(fake.find(/UPDATE wallets SET balance = balance \+/)).toHaveLength(1);
    expect(fake.find(/INSERT INTO transactions/)[0].sql).toContain("ON CONFLICT (booking_id, user_id) WHERE type = 'credit'");
  });

  it("does nothing for an unpaid booking", async () => {
    fake.reset();
    expect(await finalizeCompletion({ ...completed, payment_status: "deposit_paid" })).toBe(false);
    expect(fake.queries).toHaveLength(0);
  });
});
