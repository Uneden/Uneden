import express from "express";
import { protect, adminOnly } from "../middleware/authMiddleware.js";
import {
  createConnectAccount,
  createAccountSession,
  getConnectConfig,
  getConnectStatus,
  syncConnectProfile,
  refundPayment,
  getPaymentStatus,
  verifyPayment,
} from "../controllers/paymentController.js";
import {
  createPaymentIntent,
  confirmPaymentIntent,
  getPaymentMethods,
  createSetupIntent,
  deletePaymentMethod,
  getStripePublishableKey,
} from "../controllers/clientPaymentController.js";

const router = express.Router();

router.get("/config", getStripePublishableKey);
router.post("/connect/create", protect, createConnectAccount);
router.post("/connect/session", protect, createAccountSession);
router.get("/connect/config", getConnectConfig);
router.get("/connect/status", protect, getConnectStatus);
router.post("/connect/sync-profile", protect, syncConnectProfile);
router.post("/intent", protect, createPaymentIntent);
router.post("/intent/confirm", protect, confirmPaymentIntent);
router.get("/payment-methods", protect, getPaymentMethods);
router.post("/setup-intent", protect, createSetupIntent);
router.delete("/payment-methods/:id", protect, deletePaymentMethod);
router.post("/verify", protect, verifyPayment);
router.post("/refund", protect, adminOnly, refundPayment);
router.get("/status/:bookingId", protect, getPaymentStatus);

export default router;
