import Meeting from "../models/meeting.model.js";
import Message from "../models/message.model.js";
import Summary from "../models/summary.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { normalizeMeetingCode } from "../utils/normalizeMeetingCode.js";

const looksActionable = (content) => /\b(todo|action|follow up|assign|need to|will|should|fix|send|create|update)\b/i.test(content);
const looksLikeDecision = (content) => /\b(decided|decision|agreed|approved|final|we will|confirmed)\b/i.test(content);
const aiSummaryEndpoint = process.env.AI_SUMMARY_ENDPOINT || "https://api.openai.com/v1/chat/completions";
const aiSummaryModel = process.env.AI_SUMMARY_MODEL || "gpt-4o-mini";

const extractJson = (content) => {
  const cleaned = String(content || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return JSON.parse(cleaned);
};

const normalizeList = (items) => {
  if (!Array.isArray(items)) return [];
  return items.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10);
};

const isSummarySource = (message) => ["text", "transcript"].includes(message.type);

const buildLocalSummary = (messages) => {
  const sourceMessages = messages.filter(isSummarySource);
  const transcriptMessages = sourceMessages.filter((message) => message.type === "transcript");
  const chatMessages = sourceMessages.filter((message) => message.type === "text");
  const participants = [...new Set(sourceMessages.map((message) => message.senderName))];
  const actionItems = sourceMessages
    .map((message) => message.content)
    .filter(looksActionable)
    .slice(-8);
  const decisions = sourceMessages
    .map((message) => message.content)
    .filter(looksLikeDecision)
    .slice(-8);
  const recentPoints = sourceMessages
    .slice(-8)
    .map((message) => `${message.type === "transcript" ? "Speech" : "Chat"} - ${message.senderName}: ${message.content}`);

  return {
    summary:
      sourceMessages.length === 0
        ? "No meeting transcript or chat messages were available yet."
        : [
            `This meeting included ${participants.length || 1} participant(s): ${participants.join(", ") || "Unknown"}.`,
            `The summary used ${transcriptMessages.length} caption transcript line(s) and ${chatMessages.length} chat message(s).`,
            recentPoints.length ? `Key recent points: ${recentPoints.join(" | ")}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
    actionItems,
    decisions,
  };
};

const buildTranscript = (messages) =>
  messages
    .filter((message) => isSummarySource(message) && message.content)
    .slice(-160)
    .map((message) => `[${message.type === "transcript" ? "speech transcript" : "chat"}] ${message.senderName}: ${message.content}`)
    .join("\n");

const buildAiSummary = async (meeting, messages) => {
  const apiKey = process.env.AI_SUMMARY_API_KEY || process.env.OPENAI_API_KEY;
  const transcript = buildTranscript(messages);

  if (!apiKey || !transcript) {
    return null;
  }

  const response = await fetch(aiSummaryEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: aiSummaryModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You create concise AI meeting summaries from speech transcripts and chat. Prioritize the speech transcript, then chat for context. Return only JSON with keys: summary, actionItems, decisions. summary must be 3-6 useful sentences. actionItems and decisions must be arrays of short strings.",
        },
        {
          role: "user",
          content: `Meeting title: ${meeting.title || "Meeting"}\nMeeting code: ${meeting.code}\n\nSpeech transcript and chat:\n${transcript}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`AI summary failed with status ${response.status}`);
  }

  const data = await response.json();
  const parsed = extractJson(data.choices?.[0]?.message?.content);

  return {
    summary: String(parsed.summary || "").trim(),
    actionItems: normalizeList(parsed.actionItems),
    decisions: normalizeList(parsed.decisions),
  };
};

export const listSummaries = asyncHandler(async (req, res) => {
  const meetingCode = normalizeMeetingCode(req.params.code);
  const summaries = await Summary.find({ meetingCode }).sort({ createdAt: -1 });

  res.json({ summaries });
});

export const generateSummary = asyncHandler(async (req, res) => {
  const meetingCode = normalizeMeetingCode(req.params.code);
  const meeting = await Meeting.findOne({ code: meetingCode });

  if (!meeting) {
    return res.status(404).json({ message: "Meeting not found" });
  }

  const messages = await Message.find({ meetingCode, type: { $in: ["text", "transcript"] } }).sort({ createdAt: 1 }).limit(500);
  let generatedBy = "local";
  let generated = buildLocalSummary(messages);

  try {
    const aiGenerated = await buildAiSummary(meeting, messages);

    if (aiGenerated?.summary) {
      generated = aiGenerated;
      generatedBy = "ai";
    }
  } catch (error) {
    console.warn(`AI summary unavailable, using local summary: ${error.message}`);
  }

  const summary = await Summary.create({
    meeting: meeting._id,
    meetingCode,
    createdBy: req.user._id,
    title: req.body?.title || `${meeting.title || "Meeting"} summary`,
    summary: generated.summary,
    actionItems: generated.actionItems,
    decisions: generated.decisions,
    sourceMessageCount: messages.length,
    generatedBy,
  });

  res.status(201).json({ summary });
});
