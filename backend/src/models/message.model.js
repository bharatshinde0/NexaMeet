import mongoose, { Schema } from "mongoose";

const messageSchema = new Schema(
  {
    meeting: {
      type: Schema.Types.ObjectId,
      ref: "Meeting",
      index: true,
    },
    meetingCode: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    senderName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    socketId: {
      type: String,
    },
    type: {
      type: String,
      enum: ["text", "system", "summary", "transcript"],
      default: "text",
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
  },
  { timestamps: true }
);

const Message = mongoose.model("Message", messageSchema);

export default Message;
