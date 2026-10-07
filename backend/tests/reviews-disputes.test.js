import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";

const { email, notifications } = vi.hoisted(() => ({
  email: { notifyNewReview: vi.fn(async () => {}), notifyDisputeCreated: vi.fn(async () => {}), notifyDisputeOutcome: vi.fn() },
  notifications: {
    createLocalizedNotification: vi.fn(async () => {}),
    getUserLang: vi.fn(async () => "fr"),
    shouldSendEmail: vi.fn(async () => true),
  },
}));
const fake = createFakeDb();

vi.mock("../src/config/db.js", () => ({ default: fake.pool }));
vi.mock("../src/config/stripe.js", () => ({ default: {} }));
vi.mock("../src/lib/supabase.js", () => ({ supabaseAdmin: {} }));
vi.mock("../src/services/emailService.js", () => email);
vi.mock("../src/services/notificationService.js", () => notifications);
vi.mock("../src/services/auditService.js", () => ({ logAdminAction: vi.fn() }));

const { createReview } = await import("../src/controllers/reviewController.js");
const { CreateDispute } = await import("../src/controllers/disputeController.js");

const BOOKING_ID = "00000000-0000-4000-8000-0000000000b1";
const BOOKING = {
  id: BOOKING_ID,
  client_id: "client",
  worker_id: "worker",
  status: "completed",
  payment_status: "paid",
  completed_at: new Date().toISOString(),
};

function setup(booking, { inserted = true } = {}) {
  fake.reset();
  fake.on(/SELECT \* FROM bookings WHERE id/, () => [{ ...BOOKING, ...booking }]);
  fake.on(/INSERT INTO (reviews|disputes)/, () => (inserted ? [{ id: "new" }] : []));
  fake.on(/FROM users u1, users u2/, () => [{ target_email: "t@x", client_email: "c@x", worker_email: "w@x" }]);
}

async function call(handler, body, userId = "client") {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  await handler({ body, user: { id: userId } }, res);
  return res.status.mock.calls[0]?.[0] ?? 200;
}

describe("createReview", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([4.5, 0, 6, undefined, "abc"])("rejects rating %s with a 400 (reviews.rating is an integer)", async (rating) => {
    setup({});
    expect(await call(createReview, { booking_id: BOOKING_ID, rating })).toBe(400);
    expect(fake.find(/INSERT INTO reviews/)).toHaveLength(0);
  });

  it.each(["pending", "accepted", "active", "cancelled", "rejected"])("refuses a %s booking", async (status) => {
    setup({ status });
    expect(await call(createReview, { booking_id: BOOKING_ID, rating: 5 })).toBe(400);
  });

  it("answers 404 for a malformed booking id instead of a database error", async () => {
    setup({});
    expect(await call(createReview, { booking_id: "nope", rating: 5 })).toBe(404);
  });

  it("creates the review of a completed booking", async () => {
    setup({});
    expect(await call(createReview, { booking_id: BOOKING_ID, rating: 4, comment: "Bien" })).toBe(201);
    expect(fake.find(/INSERT INTO reviews/)[0].sql).toContain("ON CONFLICT (booking_id, reviewer_id) DO NOTHING");
  });

  it("answers 409 to a second review of the same booking", async () => {
    setup({}, { inserted: false });
    expect(await call(createReview, { booking_id: BOOKING_ID, rating: 4 })).toBe(409);
  });

  it("keeps the 201 when the notification email fails", async () => {
    setup({});
    email.notifyNewReview.mockRejectedValueOnce(new Error("smtp down"));
    expect(await call(createReview, { booking_id: BOOKING_ID, rating: 5 })).toBe(201);
  });
});

describe("CreateDispute", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ status: "pending", payment_status: "unpaid" }],
    [{ status: "accepted", payment_status: "unpaid" }],
    [{ status: "cancelled", payment_status: "refunded" }],
  ])("refuses a complaint on an unpaid or closed booking %o", async (booking) => {
    setup(booking);
    expect(await call(CreateDispute, { booking_id: BOOKING_ID, description: "Problème" })).toBe(400);
    expect(fake.find(/INSERT INTO disputes/)).toHaveLength(0);
  });

  it.each([
    [{ status: "active", payment_status: "paid" }],
    [{ status: "active", payment_status: "deposit_paid" }],
    [{ status: "completed", payment_status: "paid" }],
  ])("opens a complaint on a paid booking %o", async (booking) => {
    setup(booking);
    expect(await call(CreateDispute, { booking_id: BOOKING_ID, description: "Travail non fait" })).toBe(201);
  });

  it("closes the window 3 days after completion", async () => {
    setup({ completed_at: new Date(Date.now() - 4 * 86_400_000).toISOString() });
    expect(await call(CreateDispute, { booking_id: BOOKING_ID, description: "Trop tard" })).toBe(400);
  });

  it("requires a description and a valid booking id", async () => {
    setup({});
    expect(await call(CreateDispute, { booking_id: BOOKING_ID, description: "   " })).toBe(400);
    expect(await call(CreateDispute, { booking_id: "nope", description: "x" })).toBe(404);
  });

  it("answers 409 to a second complaint on the same booking", async () => {
    setup({}, { inserted: false });
    expect(await call(CreateDispute, { booking_id: BOOKING_ID, description: "Encore" })).toBe(409);
  });

  it("keeps the 201 when the notification emails fail", async () => {
    setup({});
    email.notifyDisputeCreated.mockRejectedValue(new Error("smtp down"));
    expect(await call(CreateDispute, { booking_id: BOOKING_ID, description: "Problème" })).toBe(201);
  });
});
