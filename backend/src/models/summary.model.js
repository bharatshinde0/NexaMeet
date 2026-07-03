import mongoose, { Schema } from "mongoose";

const summarySchema = new Schema(
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
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    title: {
      type: String,
      default: "Meeting summary",
      trim: true,
    },
    summary: {
      type: String,
      required: true,
    },
    actionItems: [
      {
        type: String,
        trim: true,
      },
    ],
    decisions: [
      {
        type: String,
        trim: true,
      },
    ],
    sourceMessageCount: {
      type: Number,
      default: 0,
    },
    generatedBy: {
      type: String,
      enum: ["local", "ai"],
      default: "local",
    },
  },
  { timestamps: true }
);

const Summary = mongoose.model("Summary", summarySchema);

export default Summary;
