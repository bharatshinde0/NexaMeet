import crypto from "node:crypto";
import Meeting from "../models/meeting.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { normalizeMeetingCode } from "../utils/normalizeMeetingCode.js";

const createMeetingCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();
const createInviteToken = () => crypto.randomBytes(12).toString("base64url");
const meetingRetentionMs = () => Number(process.env.MEETING_RETENTION_MS) || 24 * 60 * 60 * 1000;
const meetingExpiresAt = (value = new Date()) => new Date(new Date(value).getTime() + meetingRetentionMs());

const createUniqueInviteToken = async () => {
  let inviteToken = createInviteToken();

  while (await Meeting.exists({ inviteToken })) {
    inviteToken = createInviteToken();
  }

  return inviteToken;
};

const ensureMeetingInviteToken = async (meeting) => {
  if (meeting.inviteToken) {
    return meeting;
  }

  meeting.inviteToken = await createUniqueInviteToken();
  await meeting.save();
  return meeting;
};

const serializeMeeting = (meeting, userId) => {
  const data = meeting.toObject ? meeting.toObject() : meeting;
  const hostId = data.host?._id || data.host;
  const canManage = hostId && String(hostId) === String(userId);

  return {
    ...data,
    code: canManage ? data.code : undefined,
    roomCode: data.code,
    canManage: Boolean(canManage),
  };
};

export const createMeeting = asyncHandler(async (req, res) => {
  const { title = "Instant meeting", scheduledAt } = req.body;
  let code = createMeetingCode();
  const meetingDate = scheduledAt ? new Date(scheduledAt) : new Date();

  while (await Meeting.exists({ code })) {
    code = createMeetingCode();
  }

  const meeting = await Meeting.create({
    host: req.user._id,
    code,
    inviteToken: await createUniqueInviteToken(),
    title,
    scheduledAt: meetingDate,
    expiresAt: meetingExpiresAt(meetingDate),
    status: "scheduled",
  });

  res.status(201).json({ meeting: serializeMeeting(meeting, req.user._id) });
});

export const listMeetings = asyncHandler(async (req, res) => {
  const meetings = await Meeting.find({
    host: req.user._id,
  })
    .sort({ scheduledAt: -1, updatedAt: -1 })
    .limit(50)
    .populate("host", "name username avatarColor");

  const meetingsWithInvites = await Promise.all(meetings.map(ensureMeetingInviteToken));

  res.json({ meetings: meetingsWithInvites.map((meeting) => serializeMeeting(meeting, req.user._id)) });
});

export const getMeeting = asyncHandler(async (req, res) => {
  const code = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOne({ code }).populate("host", "name username avatarColor");

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found" });
  }

  await ensureMeetingInviteToken(meeting);

  res.json({ meeting: serializeMeeting(meeting, req.user._id) });
});

export const getMeetingByInvite = asyncHandler(async (req, res) => {
  const inviteToken = String(req.params.inviteToken || "").trim();
  const meeting = await Meeting.findOne({ inviteToken }).populate("host", "name username avatarColor");

  if (!meeting) {
    return res.status(404).json({ message: "Invite link is invalid or expired" });
  }

  res.json({ meeting: serializeMeeting(meeting, req.user._id) });
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
    meeting.expiresAt = meetingExpiresAt(meeting.scheduledAt);
  }

  if (typeof req.body.allowChat === "boolean") {
    meeting.settings.allowChat = req.body.allowChat;
  }

  if (typeof req.body.allowScreenShare === "boolean") {
    meeting.settings.allowScreenShare = req.body.allowScreenShare;
  }

  await meeting.save();
  res.json({ meeting: serializeMeeting(meeting, req.user._id) });
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
  meeting.expiresAt = meeting.expiresAt || meetingExpiresAt(meeting.scheduledAt || meeting.startedAt);
  await meeting.save();

  res.json({ meeting: serializeMeeting(meeting, req.user._id) });
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

  res.json({ meeting: serializeMeeting(meeting, req.user._id) });
});
