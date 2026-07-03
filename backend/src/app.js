import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { connectDB } from "./config/db.js";
import { connectToSocketIO } from "./controllers/socketManager.js";
import { errorHandler, notFound } from "./middleware/error.middleware.js";
import userRoutes from "./routes/users.routes.js";
import meetingRoutes from "./routes/meetings.routes.js";
import messageRoutes from "./routes/messages.routes.js";
import summaryRoutes from "./routes/summaries.routes.js";
import { startMeetingScheduler } from "./services/meetingScheduler.js";

const app = express();
const server = createServer(app);

const PORT = Number(process.env.PORT) || 8000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
const allowedOrigins = CLIENT_URL.split(",").map((origin) => origin.trim());
const allowLocalDevOrigins = process.env.NODE_ENV !== "production";

const corsOptions = {
  origin(origin, callback) {
    const isAllowedLocalDevOrigin =
      allowLocalDevOrigins && /^https?:\/\/(localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3}):\d+$/.test(origin || "");

    if (!origin || allowedOrigins.includes(origin) || isAllowedLocalDevOrigin) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
};

app.set("port", PORT);
app.set("trust proxy", 1);

app.use(cors(corsOptions));
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ limit: "1mb", extended: true }));

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "NexaMeet API",
    health: "/health",
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "NexaMeet API" });
});

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/meetings", meetingRoutes);
app.use("/api/v1/messages", messageRoutes);
app.use("/api/v1/summaries", summaryRoutes);

app.use(notFound);
app.use(errorHandler);

connectToSocketIO(server, { cors: corsOptions });

const start = async () => {
  try {
    await connectDB();
    startMeetingScheduler();
    server.listen(PORT, () => {
      console.log(`API and Socket.IO listening on port ${PORT}`);
    });
  } catch (error) {
    console.error(`Server failed to start: ${error.message}`);
    process.exit(1);
  }
};

start();
