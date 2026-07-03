import Meeting from "../models/meeting.model.js";
import Message from "../models/message.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { normalizeMeetingCode } from "../utils/normalizeMeetingCode.js";

export const listMessages = asyncHandler(async (req, res) => {
  const meetingCode = normalizeMeetingCode(req.params.code);
  const limit = Math.min(Number(req.query.limit) || 1000, 2000);
  const messages = await Message.find({ meetingCode, type: "text" }).sort({ createdAt: 1 }).limit(limit);

  res.json({ messages });
});

export const createMessage = asyncHandler(async (req, res) => {
  const meetingCode = normalizeMeetingCode(req.params.code);
  const { content } = req.body;

  if (!content || !String(content).trim()) {
    return res.status(400).json({ message: "Message content is required" });
  }

  const meeting = await Meeting.findOne({ code: meetingCode });

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found" });
  }

  const message = await Message.create({
    meeting: meeting._id,
    meetingCode,
    sender: req.user._id,
    senderName: req.user.name,
    type: "text",
    content,
  });

  res.status(201).json({ message });
});
