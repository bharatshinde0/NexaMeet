import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import Meeting from "../models/meeting.model.js";
import Message from "../models/message.model.js";
import User from "../models/user.model.js";
import { normalizeMeetingCode } from "../utils/normalizeMeetingCode.js";

const rooms = new Map();
const endedMeetingAccessMs = () => Number(process.env.ENDED_MEETING_ACCESS_MS) || 12 * 60 * 60 * 1000;
const endedMeetingExpiresAt = (value = new Date()) => new Date(new Date(value).getTime() + endedMeetingAccessMs());
const isMeetingExpired = (meeting) => {
  if (!meeting) return false;
  if (meeting.expiresAt && new Date(meeting.expiresAt).getTime() <= Date.now()) return true;
  return meeting.status === "ended" && meeting.endedAt && Date.now() - new Date(meeting.endedAt).getTime() > endedMeetingAccessMs();
};

const getRoom = (meetingCode) => {
  if (!rooms.has(meetingCode)) {
    rooms.set(meetingCode, new Map());
  }

  return rooms.get(meetingCode);
};

const getSocketUser = async (socket) => {
  const token = socket.handshake.auth?.token;

  if (!token || !process.env.JWT_SECRET) {
    return null;
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return await User.findById(payload.id).select("name username avatarColor");
  } catch {
    return null;
  }
};

const parseJoinPayload = (payload, fallbackName) => {
  if (typeof payload === "string") {
    return {
      meetingCode: normalizeMeetingCode(payload),
      name: fallbackName || "Guest",
    };
  }

  return {
    meetingCode: normalizeMeetingCode(payload?.meetingCode || payload?.path || payload?.room),
    name: payload?.name || fallbackName || "Guest",
    userId: payload?.userId,
  };
};

export const connectToSocketIO = (server, options = {}) => {
  const io = new Server(server, options);

  io.on("connection", async (socket) => {
    const authenticatedUser = await getSocketUser(socket);
    let currentMeetingCode = null;

    socket.on("join-call", async (payload, legacyName) => {
      const joinData = parseJoinPayload(payload, authenticatedUser?.name || legacyName);

      if (!joinData.meetingCode) {
        socket.emit("socket-error", { message: "Meeting code is required" });
        return;
      }

      currentMeetingCode = joinData.meetingCode;
      socket.join(currentMeetingCode);

      const participant = {
        socketId: socket.id,
        userId: authenticatedUser?._id?.toString() || joinData.userId || null,
        name: authenticatedUser?.name || joinData.name,
        audioEnabled: true,
        videoEnabled: true,
        screenSharing: false,
        screenStreamId: null,
        handRaised: false,
        joinedAt: new Date().toISOString(),
      };

      const room = getRoom(currentMeetingCode);
      room.set(socket.id, participant);

      const existingMeeting = await Meeting.findOne({ code: currentMeetingCode });

      if (isMeetingExpired(existingMeeting)) {
        socket.emit("socket-error", { message: "Meeting access has expired" });
        room.delete(socket.id);
        socket.leave(currentMeetingCode);
        if (room.size === 0) {
          rooms.delete(currentMeetingCode);
        }
        currentMeetingCode = null;
        return;
      }

      const meeting = await Meeting.findOneAndUpdate(
        { code: currentMeetingCode },
        {
          $set: { status: "active", startedAt: existingMeeting?.startedAt || new Date() },
          $push: {
            participants: {
              user: authenticatedUser?._id,
              name: participant.name,
              socketId: socket.id,
              joinedAt: new Date(),
            },
          },
        },
        { new: true }
      );

      const participantList = [...room.values()];
      io.to(currentMeetingCode).emit("room-users", participantList);
      socket.to(currentMeetingCode).emit("user-joined", socket.id, participantList);
      socket.to(currentMeetingCode).emit("participant-joined", participant);

      const previousMessages = await Message.find({ meetingCode: currentMeetingCode, type: "text" }).sort({ createdAt: 1 }).limit(1000);
      socket.emit("chat-history", previousMessages);

      if (!meeting) {
        socket.emit("socket-warning", { message: "Meeting is not saved yet. Create it from the dashboard to persist details." });
      }
    });

    socket.on("signal", (targetSocketId, message) => {
      io.to(targetSocketId).emit("signal", socket.id, message);
    });

    socket.on("webrtc-offer", ({ to, offer }) => {
      io.to(to).emit("webrtc-offer", { from: socket.id, offer });
    });

    socket.on("webrtc-answer", ({ to, answer }) => {
      io.to(to).emit("webrtc-answer", { from: socket.id, answer });
    });

    socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
      io.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate });
    });

    socket.on("chat-message", async (data, legacySender) => {
      const meetingCode = normalizeMeetingCode(data?.meetingCode || currentMeetingCode);
      const content = typeof data === "string" ? data : data?.content;
      const senderName = data?.senderName || authenticatedUser?.name || legacySender || "Guest";

      if (!meetingCode || !content || !String(content).trim()) {
        return;
      }

      if (data?.savedMessage?._id && /^[a-f\d]{24}$/i.test(String(data.savedMessage._id))) {
        const existingMessage = await Message.findOne({ _id: data.savedMessage._id, meetingCode });

        if (existingMessage) {
          const messagePayload = existingMessage.toObject();

          if (data?.clientId) {
            messagePayload.clientId = data.clientId;
          }

          io.to(meetingCode).emit("chat-message", messagePayload);
          return;
        }
      }

      const meeting = await Meeting.findOne({ code: meetingCode });
      const message = await Message.create({
        meeting: meeting?._id,
        meetingCode,
        sender: authenticatedUser?._id,
        senderName,
        socketId: socket.id,
        type: "text",
        content: String(content).trim(),
      });

      const messagePayload = message.toObject();

      if (data?.clientId) {
        messagePayload.clientId = data.clientId;
      }

      io.to(meetingCode).emit("chat-message", messagePayload);
    });

    socket.on("participant-state", (state = {}) => {
      if (!currentMeetingCode || !rooms.has(currentMeetingCode)) {
        return;
      }

      const room = rooms.get(currentMeetingCode);
      const participant = room.get(socket.id);

      if (!participant) {
        return;
      }

      const nextParticipant = {
        ...participant,
        ...(typeof state.audioEnabled === "boolean" ? { audioEnabled: state.audioEnabled } : {}),
        ...(typeof state.videoEnabled === "boolean" ? { videoEnabled: state.videoEnabled } : {}),
        ...(typeof state.handRaised === "boolean" ? { handRaised: state.handRaised } : {}),
        ...(typeof state.screenSharing === "boolean" ? { screenSharing: state.screenSharing } : {}),
        ...(typeof state.screenStreamId === "string" || state.screenStreamId === null ? { screenStreamId: state.screenStreamId } : {}),
      };

      room.set(socket.id, nextParticipant);
      io.to(currentMeetingCode).emit("room-users", [...room.values()]);
    });

    socket.on("screen-share-state", (state = {}) => {
      if (!currentMeetingCode || !rooms.has(currentMeetingCode)) {
        return;
      }

      const room = rooms.get(currentMeetingCode);
      const participant = room.get(socket.id);

      if (!participant) {
        return;
      }

      const nextParticipant = {
        ...participant,
        screenSharing: Boolean(state.sharing),
        screenStreamId: state.sharing ? String(state.streamId || "") : null,
      };

      room.set(socket.id, nextParticipant);
      io.to(currentMeetingCode).emit("screen-share-state", {
        socketId: socket.id,
        name: participant.name,
        sharing: nextParticipant.screenSharing,
        streamId: nextParticipant.screenStreamId,
      });
      io.to(currentMeetingCode).emit("room-users", [...room.values()]);
    });

    socket.on("reaction", (reaction) => {
      if (!currentMeetingCode || !reaction?.emoji) {
        return;
      }

      io.to(currentMeetingCode).emit("reaction", {
        id: `${socket.id}-${Date.now()}`,
        socketId: socket.id,
        name: authenticatedUser?.name || "Guest",
        emoji: reaction.emoji,
        createdAt: new Date().toISOString(),
      });
    });

    socket.on("live-caption", async (caption) => {
      if (!currentMeetingCode || !caption?.text) {
        return;
      }

      const text = String(caption.text).trim().slice(0, 1000);

      if (!text) {
        return;
      }

      const meeting = await Meeting.findOne({ code: currentMeetingCode }).select("_id");

      await Message.create({
        meeting: meeting?._id,
        meetingCode: currentMeetingCode,
        sender: authenticatedUser?._id,
        senderName: authenticatedUser?.name || "Guest",
        socketId: socket.id,
        type: "transcript",
        content: text,
      });

      socket.to(currentMeetingCode).emit("live-caption", {
        id: `${socket.id}-${Date.now()}`,
        socketId: socket.id,
        name: authenticatedUser?.name || "Guest",
        text: text.slice(0, 240),
        createdAt: new Date().toISOString(),
      });
    });

    socket.on("disconnect", async () => {
      if (!currentMeetingCode || !rooms.has(currentMeetingCode)) {
        return;
      }

      const room = rooms.get(currentMeetingCode);
      const participant = room.get(socket.id);
      room.delete(socket.id);

      await Meeting.updateOne(
        { code: currentMeetingCode, "participants.socketId": socket.id },
        { $set: { "participants.$.leftAt": new Date() } }
      );

      socket.to(currentMeetingCode).emit("user-left", socket.id);
      socket.to(currentMeetingCode).emit("participant-left", {
        socketId: socket.id,
        name: participant?.name || "Guest",
      });
      socket.to(currentMeetingCode).emit("room-users", [...room.values()]);

      if (room.size === 0) {
        const endedAt = new Date();
        await Meeting.updateOne(
          { code: currentMeetingCode },
          {
            $set: {
              status: "ended",
              endedAt,
              expiresAt: endedMeetingExpiresAt(endedAt),
            },
          }
        );
        rooms.delete(currentMeetingCode);
      }
    });
  });

  return io;
};
