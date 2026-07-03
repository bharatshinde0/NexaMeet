import { Router } from "express";
import {
  createMeeting,
  deleteMeeting,
  endMeeting,
  getMeeting,
  listMeetings,
  startMeeting,
  updateMeeting,
} from "../controllers/meeting.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/", listMeetings);
router.post("/", createMeeting);
router.get("/:code", getMeeting);
router.patch("/:code", updateMeeting);
router.patch("/:code/start", startMeeting);
router.patch("/:code/end", endMeeting);
router.delete("/:code", deleteMeeting);

export default router;
