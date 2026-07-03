import crypto from "node:crypto";
import Meeting from "../models/meeting.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { normalizeMeetingCode } from "../utils/normalizeMeetingCode.js";

const createMeetingCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();

export const createMeeting = asyncHandler(async (req, res) => {
  const { title = "Instant meeting", scheduledAt } = req.body;
  let code = createMeetingCode();

  while (await Meeting.exists({ code })) {
    code = createMeetingCode();
  }

  const meeting = await Meeting.create({
    host: req.user._id,
    code,
    title,
    scheduledAt: scheduledAt ? new Date(scheduledAt) : new Date(),
    status: "scheduled",
  });

  res.status(201).json({ meeting });
});

export const listMeetings = asyncHandler(async (req, res) => {
  const meetings = await Meeting.find({
    $or: [{ host: req.user._id }, { "participants.user": req.user._id }],
  })
    .sort({ scheduledAt: -1, updatedAt: -1 })
    .limit(50)
    .populate("host", "name username avatarColor");

  res.json({ meetings });
});

export const getMeeting = asyncHandler(async (req, res) => {
  const code = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOne({ code }).populate("host", "name username avatarColor");

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found" });
  }

  res.json({ meeting });
});

export const updateMeeting = asyncHandler(async (req, res) => {
  const code = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOne({ code, host: req.user._id });

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found or you are not the host" });
  }

  if (req.body.title) {
    meeting.title = req.body.title;
  }

  if (req.body.scheduledAt) {
    meeting.scheduledAt = new Date(req.body.scheduledAt);
  }

  if (typeof req.body.allowChat === "boolean") {
    meeting.settings.allowChat = req.body.allowChat;
  }

  if (typeof req.body.allowScreenShare === "boolean") {
    meeting.settings.allowScreenShare = req.body.allowScreenShare;
  }

  await meeting.save();
  res.json({ meeting });
});

export const deleteMeeting = asyncHandler(async (req, res) => {
  const code = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOneAndDelete({ code, host: req.user._id });

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found or you are not the host" });
  }

  res.json({ message: "Meeting deleted successfully", code });
});

export const startMeeting = asyncHandler(async (req, res) => {
  const code = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOne({ code });

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found" });
  }

  meeting.status = "active";
  meeting.startedAt = meeting.startedAt || new Date();
  await meeting.save();

  res.json({ meeting });
});

export const endMeeting = asyncHandler(async (req, res) => {
  const code = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOne({ code });

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found" });
  }

  meeting.status = "ended";
  meeting.endedAt = new Date();
  await meeting.save();

  res.json({ meeting });
});
