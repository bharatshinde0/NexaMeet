import { Router } from "express";
import { createMessage, listMessages } from "../controllers/message.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/:code", listMessages);
router.post("/:code", createMessage);

export default router;
