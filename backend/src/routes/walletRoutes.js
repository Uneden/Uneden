import express from "express";
import { getWallet, getTransactions, exportTransactions, triggerPayout, runScheduledPayout, getPlatformEarnings, getPayoutDetails, getPendingDisputeDetails, getApprovedPayoutDetails, getEarnedDetails, getSpentDetails } from "../controllers/walletController.js";
import { getLedgerReconciliationReport } from "../controllers/ledgerController.js";
import { protect, adminOnly } from "../middleware/authMiddleware.js";

const router = express.Router();

router.get("/", protect, getWallet);
router.get("/pending-details", protect, getPendingDisputeDetails);
router.get("/approved-details", protect, getApprovedPayoutDetails);
router.get("/earned-details", protect, getEarnedDetails);
router.get("/spent-details", protect, getSpentDetails);
router.get("/transactions", protect, getTransactions);
router.get("/payout-details", protect, getPayoutDetails);
router.get("/export", protect, adminOnly, exportTransactions);
router.post("/payout/trigger", protect, adminOnly, triggerPayout);
// Scheduled run (GitHub Actions, CRON_SECRET): no user session.
router.post("/payout/scheduled", runScheduledPayout);
router.get("/platform-earnings", protect, adminOnly, getPlatformEarnings);
router.get("/ledger/reconciliation", protect, adminOnly, getLedgerReconciliationReport);

export default router;
