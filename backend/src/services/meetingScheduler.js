import Meeting from "../models/meeting.model.js";
import Message from "../models/message.model.js";
import Summary from "../models/summary.model.js";

const meetingRetentionMs = () => Number(process.env.MEETING_RETENTION_MS) || 24 * 60 * 60 * 1000;
const meetingCleanupIntervalMs = () => Number(process.env.MEETING_CLEANUP_INTERVAL_MS) || 5 * 60 * 1000;

const activateDueMeetings = async () => {
  const now = new Date();
  const result = await Meeting.updateMany(
    {
      status: "scheduled",
      scheduledAt: { $lte: now },
    },
    {
      $set: {
        status: "active",
        startedAt: now,
      },
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`Activated ${result.modifiedCount} scheduled meeting(s)`);
  }
};

const deleteExpiredMeetings = async () => {
  const expiresBefore = new Date(Date.now() - meetingRetentionMs());
  const expiredMeetings = await Meeting.find({
    $or: [
      { scheduledAt: { $lte: expiresBefore } },
      { scheduledAt: { $exists: false }, createdAt: { $lte: expiresBefore } },
    ],
  }).select("_id code");

  if (expiredMeetings.length === 0) {
    return;
  }

  const meetingIds = expiredMeetings.map((meeting) => meeting._id);
  const meetingCodes = expiredMeetings.map((meeting) => meeting.code);

  await Promise.all([
    Message.deleteMany({ $or: [{ meeting: { $in: meetingIds } }, { meetingCode: { $in: meetingCodes } }] }),
    Summary.deleteMany({ $or: [{ meeting: { $in: meetingIds } }, { meetingCode: { $in: meetingCodes } }] }),
    Meeting.deleteMany({ _id: { $in: meetingIds } }),
  ]);

  console.log(`Deleted ${expiredMeetings.length} expired meeting(s) older than ${Math.round(meetingRetentionMs() / 3600000)} hour(s)`);
};

export const startMeetingScheduler = () => {
  activateDueMeetings().catch((error) => {
    console.error(`Meeting scheduler failed: ${error.message}`);
  });
  deleteExpiredMeetings().catch((error) => {
    console.error(`Meeting cleanup failed: ${error.message}`);
  });

  const activationInterval = setInterval(() => {
    activateDueMeetings().catch((error) => {
      console.error(`Meeting scheduler failed: ${error.message}`);
    });
  }, Number(process.env.MEETING_SCHEDULER_INTERVAL_MS) || 30000);

  const cleanupInterval = setInterval(() => {
    deleteExpiredMeetings().catch((error) => {
      console.error(`Meeting cleanup failed: ${error.message}`);
    });
  }, meetingCleanupIntervalMs());

  return { activationInterval, cleanupInterval };
};
