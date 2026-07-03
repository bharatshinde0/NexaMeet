import bcrypt from "bcrypt";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const publicUser = (user) => ({
  id: user._id,
  name: user.name,
  username: user.username,
  email: user.email,
  avatarColor: user.avatarColor,
});

const signToken = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is missing. Add it to backend/.env");
  }

  return jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

const verifyGoogleCredential = async (credential) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    const error = new Error("Google login is not configured. Add GOOGLE_CLIENT_ID to backend/.env");
    error.statusCode = 501;
    throw error;
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);

  if (!response.ok) {
    const error = new Error("Invalid Google credential");
    error.statusCode = 401;
    throw error;
  }

  const profile = await response.json();

  if (profile.aud !== process.env.GOOGLE_CLIENT_ID) {
    const error = new Error("Google credential was issued for another client");
    error.statusCode = 401;
    throw error;
  }

  if (profile.email_verified !== "true" && profile.email_verified !== true) {
    const error = new Error("Google email is not verified");
    error.statusCode = 401;
    throw error;
  }

  return profile;
};

export const register = asyncHandler(async (req, res) => {
  const { name, username, email, password } = req.body;

  if (!name || !username || !password) {
    return res.status(400).json({ message: "Name, username, and password are required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  const normalizedUsername = String(username).toLowerCase().trim();
  const existingUser = await User.findOne({
    $or: [{ username: normalizedUsername }, ...(email ? [{ email: String(email).toLowerCase().trim() }] : [])],
  });

  if (existingUser) {
    return res.status(409).json({ message: "Username or email already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const user = await User.create({
    name,
    username: normalizedUsername,
    email,
    password: hashedPassword,
    avatarColor: `#${crypto.randomBytes(3).toString("hex")}`,
  });

  const token = signToken(user);
  user.token = token;
  await user.save();

  res.status(201).json({
    message: "User registered successfully",
    token,
    user: publicUser(user),
  });
});

export const login = asyncHandler(async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "Username and password are required" });
  }

  const user = await User.findOne({ username: String(username).toLowerCase().trim() }).select("+password");

  if (!user) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  const passwordMatches = await user.comparePassword(password);

  if (!passwordMatches) {
    return res.status(401).json({ message: "Invalid username or password" });
  }

  const token = signToken(user);
  user.token = token;
  user.lastLoginAt = new Date();
  await user.save();

  res.json({
    message: "User logged in successfully",
    token,
    user: publicUser(user),
  });
});

export const me = asyncHandler(async (req, res) => {
  res.json({ user: publicUser(req.user) });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { identifier } = req.body;

  if (!identifier) {
    return res.status(400).json({ message: "Username or email is required" });
  }

  const normalizedIdentifier = String(identifier).toLowerCase().trim();
  const user = await User.findOne({
    $or: [{ username: normalizedIdentifier }, { email: normalizedIdentifier }],
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) {
    return res.json({ message: "If the account exists, a reset token has been created." });
  }

  const resetToken = crypto.randomBytes(24).toString("hex");
  user.passwordResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  user.passwordResetExpires = new Date(Date.now() + 15 * 60 * 1000);
  await user.save();

  res.json({
    message: "Password reset token created.",
    resetToken,
    resetUrl: `${process.env.CLIENT_URL?.split(",")[0] || "http://localhost:5173"}/auth?resetToken=${resetToken}`,
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { resetToken, password } = req.body;

  if (!resetToken || !password) {
    return res.status(400).json({ message: "Reset token and new password are required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetToken +passwordResetExpires");

  if (!user) {
    return res.status(400).json({ message: "Reset token is invalid or expired" });
  }

  user.password = await bcrypt.hash(password, 12);
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();

  res.json({ message: "Password updated successfully" });
});

export const googleLogin = asyncHandler(async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({ message: "Google credential is required" });
  }

  const profile = await verifyGoogleCredential(credential);
  const email = String(profile.email).toLowerCase();
  const fallbackUsername = email.split("@")[0].replace(/[^a-z0-9_.-]/g, "").slice(0, 30);

  let user = await User.findOne({ $or: [{ googleId: profile.sub }, { email }] });

  if (!user) {
    let username = fallbackUsername || `google-${crypto.randomBytes(4).toString("hex")}`;
    while (await User.exists({ username })) {
      username = `${fallbackUsername}-${crypto.randomBytes(2).toString("hex")}`;
    }

    user = await User.create({
      name: profile.name || email,
      username,
      email,
      password: await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 12),
      avatarColor: `#${crypto.randomBytes(3).toString("hex")}`,
      authProvider: "google",
      googleId: profile.sub,
    });
  } else if (!user.googleId) {
    user.googleId = profile.sub;
    user.authProvider = "google";
    await user.save();
  }

  const token = signToken(user);
  user.token = token;
  user.lastLoginAt = new Date();
  await user.save();

  res.json({
    message: "Google login successful",
    token,
    user: publicUser(user),
  });
});
