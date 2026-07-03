import { Router } from "express";
import { generateSummary, listSummaries } from "../controllers/summary.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/:code", listSummaries);
router.post("/:code/generate", generateSummary);

export default router;
