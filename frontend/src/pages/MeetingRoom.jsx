import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Camera,
  CameraOff,
  Check,
  Copy,
  Hand,
  Info,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Pin,
  Radio,
  Send,
  Settings,
  Share2,
  Sparkles,
  Square,
  Subtitles,
  Users,
  Wand2,
} from "lucide-react";
import { api } from "../lib/api.js";
import { clearActiveMeeting, saveActiveMeeting, saveJoinedMeetingHistory } from "../lib/meetingSession.js";
import { createSocket } from "../lib/socket.js";
import { useAuth } from "../state/AuthContext.jsx";

const buildIceServers = () => {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }];

  if (import.meta.env.VITE_TURN_URL) {
    servers.push({
      urls: import.meta.env.VITE_TURN_URL,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    });
  }

  return servers;
};

const iceServers = buildIceServers();

const canUseMediaDevices = () => Boolean(navigator.mediaDevices?.getUserMedia);
const cameraConstraints = (facingMode = "user") => ({ facingMode: { ideal: facingMode } });

const blockedMediaNames = new Set(["NotAllowedError", "SecurityError", "PermissionDeniedError"]);
const mediaPermissionSteps = [
  "Tap the small icon beside the website URL.",
  "Tap Permissions or Site settings.",
  "Tap Camera and select Allow.",
  "Tap Microphone and select Allow.",
  "Return to the meeting and tap Mic or Camera again.",
];

const describeMediaProblem = (err, kind = "camera and microphone") => {
  const label = kind === "audio" ? "Microphone" : kind === "video" ? "Camera" : "Camera and microphone";
  const name = err?.name || "";

  if (!canUseMediaDevices()) {
    return {
      title: `${label} unavailable`,
      detail: "Use an HTTPS Render URL in Chrome, Edge, or Safari. Camera and microphone do not work from insecure browser pages.",
      steps: mediaPermissionSteps,
    };
  }

  if (blockedMediaNames.has(name)) {
    return {
      title: `${label} permission blocked`,
      detail: "Close floating bubbles/overlays, allow camera and microphone in browser site settings, then tap Try again.",
      steps: mediaPermissionSteps,
    };
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      title: `${label} not found`,
      detail: "Check that this device has a working camera/microphone and that browser site permission is allowed.",
      steps: mediaPermissionSteps,
    };
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      title: `${label} is busy`,
      detail: "Close other apps using the camera or microphone, then tap Try again.",
      steps: mediaPermissionSteps,
    };
  }

  return {
    title: `${label} could not start`,
    detail: err?.message || "Check browser permissions and try again.",
    steps: mediaPermissionSteps,
  };
};

const describeScreenShareProblem = (err) => {
  if (!window.isSecureContext) {
    return "Screen sharing requires HTTPS. Open NexaMeet with the secure https:// Render link and try again.";
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    return "Screen sharing is not supported on this browser or phone. Use desktop Chrome, Edge, or another browser that supports screen sharing.";
  }

  if (err?.name === "NotAllowedError" || err?.name === "SecurityError") {
    return "Screen sharing permission was blocked. Allow screen sharing in the browser prompt and try again.";
  }

  if (err?.name === "NotFoundError") {
    return "No screen or window was available to share on this device.";
  }

  if (err?.name === "AbortError") {
    return "Screen sharing was cancelled before it started.";
  }

  return err?.message || "Screen sharing could not start on this device.";
};

const messageKey = (message) =>
  message._id || message.clientId || `${message.senderName}-${message.createdAt}-${message.content}`;

const mergeMessages = (currentMessages, incomingMessages) => {
  const messagesByKey = new Map();

  [...currentMessages, ...incomingMessages].forEach((message) => {
    if (!message) return;

    if (message.clientId) {
      const pendingMatch = [...messagesByKey.entries()].find(([, existing]) => existing.clientId === message.clientId);

      if (pendingMatch) {
        messagesByKey.delete(pendingMatch[0]);
      }
    }

    messagesByKey.set(messageKey(message), message);
  });

  return [...messagesByKey.values()].sort(
    (first, second) => new Date(first.createdAt || 0).getTime() - new Date(second.createdAt || 0).getTime()
  );
};
const reactionChoices = ["👍", "👏", "🎉", "❤️", "😂"];

export default function MeetingRoom() {
  const { code: routeCode, inviteToken } = useParams();
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const socketRef = useRef(null);
  const peersRef = useRef(new Map());
  const offeredPeersRef = useRef(new Set());
  const pendingCandidatesRef = useRef(new Map());
  const screenStreamIdsRef = useRef(new Map());
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const messagesEndRef = useRef(null);

  const [meeting, setMeeting] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [peerStates, setPeerStates] = useState({});
  const [localStream, setLocalStream] = useState(null);
  const [localScreenStream, setLocalScreenStream] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [error, setError] = useState("");
  const [mediaIssue, setMediaIssue] = useState(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [socketStatus, setSocketStatus] = useState("connecting");
  const [activeTab, setActiveTab] = useState("chat");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [cameraFacingMode, setCameraFacingMode] = useState("user");
  const [sharingScreen, setSharingScreen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [recording, setRecording] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captions, setCaptions] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [blurEnabled, setBlurEnabled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pinnedTileId, setPinnedTileId] = useState("local");
  const [pinMode, setPinMode] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  const meetingCode = meeting?.roomCode || routeCode;
  const meetingUrl = meeting?.inviteToken
    ? `${window.location.origin}/join/${meeting.inviteToken}`
    : routeCode
      ? `${window.location.origin}/meeting/${routeCode}`
      : window.location.href;
  const participantBySocket = new Map(participants.map((participant) => [participant.socketId, participant]));
  const isOwnMessage = (message) => {
    const senderId = message.sender?._id || message.sender;

    return Boolean(
      message.isLocal ||
        message.pending ||
        (senderId && user?.id && String(senderId) === String(user.id)) ||
        (!senderId && user?.name && message.senderName === user.name)
    );
  };
  const remoteTiles = participants
    .filter((participant) => participant.socketId !== socketRef.current?.id)
    .map((participant) => ({
      id: participant.socketId,
      name: participant?.name || "Guest",
      isLocal: false,
      audioEnabled: participant?.audioEnabled,
      handRaised: participant?.handRaised,
      videoEnabled: participant?.videoEnabled,
      participant,
      stream: remoteStreams.find((item) => item.socketId === participant.socketId && item.type !== "screen")?.stream || null,
      connectionState: peerStates[participant.socketId] || "connecting",
    }));
  const screenTiles = [
    ...(localScreenStream
      ? [
          {
            id: "local-screen",
            name: `${user?.name || "You"}'s screen`,
            isLocal: true,
            isScreen: true,
            stream: localScreenStream,
            audioEnabled: false,
            videoEnabled: true,
            connectionState: "connected",
          },
        ]
      : []),
    ...remoteStreams
      .filter((item) => item.type === "screen")
      .map((item) => {
        const participant = participantBySocket.get(item.socketId);

        return {
          id: `${item.socketId}-screen`,
          name: `${participant?.name || "Guest"}'s screen`,
          isLocal: false,
          isScreen: true,
          stream: item.stream,
          audioEnabled: participant?.audioEnabled,
          videoEnabled: true,
          connectionState: peerStates[item.socketId] || "connecting",
        };
      }),
  ];
  const videoTiles = [
    {
      id: "local",
      name: user?.name || "You",
      isLocal: true,
      stream: localStream,
      audioEnabled,
      handRaised,
      videoEnabled,
      softFocus: blurEnabled,
      isMirrored: cameraFacingMode === "user",
      mediaIssue,
      mediaBusy,
    },
    ...remoteTiles,
    ...screenTiles,
  ];
  const useTwoPersonLayout = videoTiles.length <= 2 && !pinMode;
  const pinnedTile = videoTiles.find((tile) => tile.id === pinnedTileId) || videoTiles[0];
  const sideTiles = videoTiles.filter((tile) => tile.id !== pinnedTile.id);
  const hasRemoteParticipants = remoteTiles.length > 0;
  const pinTile = (tileId) => {
    setPinnedTileId(tileId);
    setPinMode(true);
  };

  const refreshMessages = useCallback(async (targetCode = meetingCode) => {
    if (!targetCode) return;

    const { data } = await api.get(`/messages/${targetCode}?limit=1000`);
    setMessages((current) => mergeMessages(current, data.messages));
  }, [meetingCode]);

  const removePeer = useCallback((socketId) => {
    const peer = peersRef.current.get(socketId);
    if (peer) {
      peer.close();
      peersRef.current.delete(socketId);
    }
    offeredPeersRef.current.delete(socketId);
    setRemoteStreams((current) => current.filter((item) => item.socketId !== socketId));
    setPeerStates((current) => {
      const nextStates = { ...current };
      delete nextStates[socketId];
      return nextStates;
    });
  }, []);

  const emitParticipantState = useCallback((nextState) => {
    socketRef.current?.emit("participant-state", nextState);
  }, []);

  const setPeerState = useCallback((socketId, state) => {
    setPeerStates((current) => ({ ...current, [socketId]: state }));
  }, []);

  const flushPendingCandidates = useCallback(async (socketId, peer) => {
    const queuedCandidates = pendingCandidatesRef.current.get(socketId) || [];
    pendingCandidatesRef.current.delete(socketId);

    for (const candidate of queuedCandidates) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (err) {
        console.warn("Could not add queued ICE candidate", err);
      }
    }
  }, []);

  const sendOffer = useCallback(async (socketId, options = {}) => {
    const peer = peersRef.current.get(socketId);
    const force = Boolean(options.force);

    if (!peer || peer.signalingState !== "stable" || (!force && offeredPeersRef.current.has(socketId))) {
      return;
    }

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    offeredPeersRef.current.add(socketId);
    socketRef.current?.emit("webrtc-offer", { to: socketId, offer });
    setPeerState(socketId, "connecting");
  }, [setPeerState]);

  const createPeer = useCallback(
    async (socketId, shouldCreateOffer) => {
      if (!socketId || socketId === socketRef.current?.id) {
        return null;
      }

      if (peersRef.current.has(socketId)) {
        const existingPeer = peersRef.current.get(socketId);
        if (shouldCreateOffer) {
          await sendOffer(socketId);
        }
        return existingPeer;
      }

      const peer = new RTCPeerConnection({ iceServers });
      peersRef.current.set(socketId, peer);
      setPeerState(socketId, "connecting");

      localStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current);
      });
      screenStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, screenStreamRef.current);
      });

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit("webrtc-ice-candidate", { to: socketId, candidate: event.candidate });
        }
      };

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        setPeerState(socketId, "connected");

        setRemoteStreams((current) => {
          const knownScreenStreamId = screenStreamIdsRef.current.get(socketId);
          const type =
            knownScreenStreamId === stream.id ||
            (!knownScreenStreamId && current.some((item) => item.socketId === socketId && item.streamId !== stream.id))
              ? "screen"
              : "camera";
          const existing = current.find((item) => item.socketId === socketId && item.streamId === stream.id);
          if (existing) {
            return current.map((item) => (item.socketId === socketId && item.streamId === stream.id ? { ...item, stream, type } : item));
          }
          return [...current, { socketId, streamId: stream.id, stream, type }];
        });
      };

      peer.onconnectionstatechange = () => {
        setPeerState(socketId, peer.connectionState);
        if (["closed", "failed", "disconnected"].includes(peer.connectionState)) {
          removePeer(socketId);
        }
      };

      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
          setPeerState(socketId, "connected");
        }

        if (peer.iceConnectionState === "failed") {
          setPeerState(socketId, "failed");
          peer.restartIce?.();
        }
      };

      if (shouldCreateOffer) {
        await sendOffer(socketId);
      }

      return peer;
    },
    [removePeer, sendOffer, setPeerState]
  );

  const startLocalMedia = async () => {
    let stream = new MediaStream();

    if (!canUseMediaDevices()) {
      setAudioEnabled(false);
      setVideoEnabled(false);
      setMediaIssue(describeMediaProblem(null));
      return stream;
    }

    setMediaBusy(true);

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints("user"), audio: true });
      setCameraFacingMode("user");
      setMediaIssue(null);
    } catch (mediaError) {
      setAudioEnabled(false);
      setVideoEnabled(false);
      setMediaIssue(describeMediaProblem(mediaError));

      if (!blockedMediaNames.has(mediaError?.name || "")) {
        for (const kind of ["audio", "video"]) {
          try {
            const partialStream = await navigator.mediaDevices.getUserMedia({
              audio: kind === "audio",
              video: kind === "video" ? cameraConstraints("user") : false,
            });
            partialStream.getTracks().forEach((track) => stream.addTrack(track));
          } catch {
            // The user can retry each missing device from the local tile.
          }
        }

        if (stream.getTracks().length > 0) {
          setMediaIssue(null);
        }
      }
    } finally {
      setMediaBusy(false);
    }

    setAudioEnabled(stream.getAudioTracks().some((track) => track.enabled));
    setVideoEnabled(stream.getVideoTracks().some((track) => track.enabled));
    return stream;
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, activeTab]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      refreshMessages().catch(() => {});
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [refreshMessages]);

  useEffect(() => {
    let active = true;
    saveActiveMeeting(inviteToken || routeCode, inviteToken ? "join" : "meeting");

    const boot = async () => {
      try {
        const { data: meetingData } = await api.get(
          inviteToken ? `/meetings/invite/${inviteToken}` : `/meetings/${routeCode}`
        );

        if (!active) return;

        const activeMeeting = meetingData.meeting;

        if (routeCode && !activeMeeting.canManage && activeMeeting.inviteToken) {
          saveActiveMeeting(activeMeeting.inviteToken, "join");
          navigate(`/join/${activeMeeting.inviteToken}`, { replace: true });
          return;
        }

        const activeMeetingCode = activeMeeting.roomCode || routeCode;
        const [{ data: messageData }, { data: summaryData }] = await Promise.all([
          api.get(`/messages/${activeMeetingCode}?limit=1000`),
          api.get(`/summaries/${activeMeetingCode}`),
        ]);

        saveActiveMeeting(
          activeMeeting.inviteToken || activeMeetingCode,
          activeMeeting.inviteToken ? "join" : "meeting",
          { title: activeMeeting.title, expiresAt: activeMeeting.expiresAt }
        );
        saveJoinedMeetingHistory({
          path: activeMeeting.inviteToken ? `/join/${activeMeeting.inviteToken}` : `/meeting/${activeMeetingCode}`,
          title: activeMeeting.title,
          expiresAt: activeMeeting.expiresAt,
        });
        setMeeting(activeMeeting);
        setMessages((current) => mergeMessages(current, messageData.messages));
        setSummaries(summaryData.summaries);
        await api.patch(`/meetings/${activeMeetingCode}/start`);

        const stream = await startLocalMedia();

        localStreamRef.current = stream;
        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        const socket = createSocket(token);
        socketRef.current = socket;

        socket.on("connect", () => {
          setSocketStatus("connected");
          socket.emit("join-call", { meetingCode: activeMeetingCode, name: user?.name, userId: user?.id });
          socket.emit("participant-state", {
            audioEnabled: stream.getAudioTracks().some((track) => track.enabled),
            videoEnabled: stream.getVideoTracks().some((track) => track.enabled),
            handRaised: false,
          });
        });

        socket.on("connect_error", (err) => {
          setSocketStatus("offline");
          setError(`Could not connect to live meeting server: ${err.message}`);
        });

        socket.on("disconnect", () => {
          setSocketStatus("offline");
        });

        socket.on("room-users", async (roomUsers) => {
          roomUsers.forEach((participant) => {
            if (participant.screenSharing && participant.screenStreamId) {
              screenStreamIdsRef.current.set(participant.socketId, participant.screenStreamId);
            } else {
              screenStreamIdsRef.current.delete(participant.socketId);
            }
          });
          setRemoteStreams((current) =>
            current.map((item) => ({
              ...item,
              type: screenStreamIdsRef.current.get(item.socketId) === item.streamId ? "screen" : item.type === "screen" ? "camera" : item.type,
            }))
          );
          setParticipants(roomUsers);
          for (const participant of roomUsers) {
            if (participant.socketId !== socket.id) {
              await createPeer(participant.socketId, socket.id > participant.socketId);
            }
          }
        });

        socket.on("participant-joined", async (participant) => {
          setParticipants((current) => [...current.filter((item) => item.socketId !== participant.socketId), participant]);
          if (participant.socketId !== socket.id) {
            await createPeer(participant.socketId, socket.id > participant.socketId);
          }
        });

        socket.on("user-joined", async (socketId) => {
          await createPeer(socketId, socket.id > socketId);
        });

        socket.on("participant-left", (participant) => {
          setParticipants((current) => current.filter((item) => item.socketId !== participant.socketId));
          screenStreamIdsRef.current.delete(participant.socketId);
          removePeer(participant.socketId);
        });

        socket.on("user-left", removePeer);

        socket.on("screen-share-state", ({ socketId, sharing, streamId }) => {
          if (!socketId || socketId === socket.id) {
            return;
          }

          if (sharing && streamId) {
            screenStreamIdsRef.current.set(socketId, streamId);
            setRemoteStreams((current) =>
              current.map((item) =>
                item.socketId === socketId && item.streamId === streamId ? { ...item, type: "screen" } : item
              )
            );
            return;
          }

          screenStreamIdsRef.current.delete(socketId);
          setRemoteStreams((current) => current.filter((item) => !(item.socketId === socketId && item.type === "screen")));
        });

        socket.on("webrtc-offer", async ({ from, offer }) => {
          const peer = await createPeer(from, false);
          await peer.setRemoteDescription(new RTCSessionDescription(offer));
          await flushPendingCandidates(from, peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("webrtc-answer", { to: from, answer });
        });

        socket.on("webrtc-answer", async ({ from, answer }) => {
          const peer = peersRef.current.get(from);
          if (peer && peer.signalingState !== "stable") {
            await peer.setRemoteDescription(new RTCSessionDescription(answer));
            await flushPendingCandidates(from, peer);
          }
        });

        socket.on("webrtc-ice-candidate", async ({ from, candidate }) => {
          const peer = peersRef.current.get(from);
          if (peer && candidate) {
            const iceCandidate = new RTCIceCandidate(candidate);

            if (peer.remoteDescription) {
              await peer.addIceCandidate(iceCandidate);
            } else {
              const queuedCandidates = pendingCandidatesRef.current.get(from) || [];
              queuedCandidates.push(iceCandidate);
              pendingCandidatesRef.current.set(from, queuedCandidates);
            }
          }
        });

        socket.on("chat-history", (history) => {
          setMessages((current) => mergeMessages(current, history));
        });
        socket.on("chat-message", (message) => {
          setMessages((current) => {
            if (message.clientId) {
              const pendingIndex = current.findIndex((item) => item.clientId === message.clientId);

              if (pendingIndex >= 0) {
                return mergeMessages(
                  current.filter((_, index) => index !== pendingIndex),
                  [message]
                );
              }
            }

            return mergeMessages(current, [message]);
          });
        });
        socket.on("reaction", (reaction) => {
          setReactions((current) => [...current, reaction]);
          window.setTimeout(() => setReactions((current) => current.filter((item) => item.id !== reaction.id)), 3500);
        });
        socket.on("live-caption", (caption) => {
          setCaptions((current) => [...current.slice(-5), caption]);
        });
        socket.on("socket-error", (payload) => setError(payload.message));
        socket.on("socket-warning", (payload) => setError(payload.message));
      } catch (err) {
        if (err.response?.status === 404 || err.response?.status === 410) {
          clearActiveMeeting();
          navigate("/", { replace: true });
          return;
        }

        setError(err.response?.data?.message || err.message || "Could not join meeting");
      }
    };

    boot();

    return () => {
      active = false;
      recognitionRef.current?.stop?.();
      mediaRecorderRef.current?.state === "recording" && mediaRecorderRef.current.stop();
      socketRef.current?.disconnect();
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      offeredPeersRef.current.clear();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      setLocalStream(null);
      setLocalScreenStream(null);
      setPeerStates({});
    };
  }, [createPeer, inviteToken, navigate, removePeer, routeCode, token, user]);

  const toggleAudio = () => {
    if (!canUseMediaDevices()) {
      setMediaIssue(describeMediaProblem(null, "audio"));
      return;
    }

    if (!localStreamRef.current?.getAudioTracks().length) {
      requestMissingMediaTrack("audio").catch((err) =>
        setMediaIssue(describeMediaProblem(err, "audio"))
      );
      return;
    }

    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setAudioEnabled(track.enabled);
      emitParticipantState({ audioEnabled: track.enabled, videoEnabled, handRaised });
    });
  };

  const switchCamera = async () => {
    if (!canUseMediaDevices()) {
      setMediaIssue(describeMediaProblem(null, "video"));
      return;
    }

    if (!localStreamRef.current?.getVideoTracks().length) {
      requestMissingMediaTrack("video", cameraFacingMode).catch((err) =>
        setMediaIssue(describeMediaProblem(err, "video"))
      );
      return;
    }

    const nextFacingMode = cameraFacingMode === "user" ? "environment" : "user";
    setMediaBusy(true);

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(nextFacingMode), audio: false });
      const [nextTrack] = nextStream.getVideoTracks();

      if (!nextTrack) {
        throw new Error("Camera did not return a media track.");
      }

      const currentStream = localStreamRef.current || new MediaStream();
      const currentVideoTrack = currentStream.getVideoTracks()[0];

      peersRef.current.forEach((peer) => {
        const sender = peer.getSenders().find((item) => item.track === currentVideoTrack);
        sender?.replaceTrack(nextTrack);
      });

      if (currentVideoTrack) {
        currentStream.removeTrack(currentVideoTrack);
        currentVideoTrack.stop();
      }

      currentStream.addTrack(nextTrack);
      localStreamRef.current = currentStream;
      setLocalStream(new MediaStream(currentStream.getTracks()));
      setCameraFacingMode(nextTrack.getSettings?.().facingMode || nextFacingMode);
      setVideoEnabled(true);
      emitParticipantState({ audioEnabled, videoEnabled: true, handRaised });
      setMediaIssue(null);
      setError("");
    } catch (err) {
      setMediaIssue({
        ...describeMediaProblem(err, "video"),
        detail:
          nextFacingMode === "environment"
            ? "Back camera is not available on this device/browser. Front camera is still active."
            : "Front camera could not start. Check camera permission and try again.",
      });
    } finally {
      setMediaBusy(false);
    }
  };

  const requestMissingMediaTrack = async (kind, facingMode = cameraFacingMode) => {
    setMediaBusy(true);
    let nextStream;

    try {
      nextStream = await navigator.mediaDevices.getUserMedia({
        audio: kind === "audio",
        video: kind === "video" ? cameraConstraints(facingMode) : false,
      });
    } catch (err) {
      setMediaIssue(describeMediaProblem(err, kind));
      throw err;
    } finally {
      setMediaBusy(false);
    }

    const [track] = kind === "audio" ? nextStream.getAudioTracks() : nextStream.getVideoTracks();

    if (!track) {
      const err = new Error(`${kind === "audio" ? "Microphone" : "Camera"} did not return a media track.`);
      setMediaIssue(describeMediaProblem(err, kind));
      throw err;
    }

    const currentStream = localStreamRef.current || new MediaStream();
    currentStream.addTrack(track);
    localStreamRef.current = currentStream;
    setLocalStream(new MediaStream(currentStream.getTracks()));

    peersRef.current.forEach((peer) => {
      peer.addTrack(track, currentStream);
    });

    if (kind === "audio") {
      setAudioEnabled(true);
      emitParticipantState({ audioEnabled: true, videoEnabled, handRaised });
    } else {
      setCameraFacingMode(track.getSettings?.().facingMode || facingMode);
      setVideoEnabled(true);
      emitParticipantState({ audioEnabled, videoEnabled: true, handRaised });
    }

    setError("");
    setMediaIssue(null);
  };

  const toggleHand = () => {
    const nextHandRaised = !handRaised;
    setHandRaised(nextHandRaised);
    emitParticipantState({ audioEnabled, videoEnabled, handRaised: nextHandRaised });
  };

  const stopScreenShare = async ({ stopTracks = true } = {}) => {
    const screenStream = screenStreamRef.current;
    const screenTracks = screenStream?.getTracks() || [];

    if (screenTracks.length === 0) {
      setSharingScreen(false);
      setLocalScreenStream(null);
      return;
    }

    peersRef.current.forEach((peer, socketId) => {
      peer
        .getSenders()
        .filter((sender) => sender.track && screenTracks.includes(sender.track))
        .forEach((sender) => peer.removeTrack(sender));
      sendOffer(socketId, { force: true }).catch(() => {});
    });

    if (stopTracks) {
      screenTracks.forEach((track) => track.stop());
    }

      socketRef.current?.emit("screen-share-state", { sharing: false, streamId: screenStream.id });
      screenStreamRef.current = null;
      setLocalScreenStream(null);
      setSharingScreen(false);
      if (pinnedTileId === "local-screen") {
        setPinnedTileId("local");
        setPinMode(false);
      }
  };

  const shareScreen = async () => {
    if (sharingScreen) {
      await stopScreenShare();
      return;
    }

    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
        setError(describeScreenShareProblem());
        return;
      }

      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const [screenTrack] = screenStream.getVideoTracks();

      if (!screenTrack) {
        throw new Error("No screen track was selected.");
      }

      screenStreamRef.current = screenStream;
      setLocalScreenStream(screenStream);
      peersRef.current.forEach((peer, socketId) => {
        screenStream.getTracks().forEach((track) => {
          peer.addTrack(track, screenStream);
        });
        sendOffer(socketId, { force: true }).catch(() => {});
      });
      socketRef.current?.emit("screen-share-state", { sharing: true, streamId: screenStream.id });
      setSharingScreen(true);
      setPinnedTileId("local-screen");
      setPinMode(true);
      setError("");

      screenTrack.onended = async () => {
        await stopScreenShare({ stopTracks: false });
      };
    } catch (err) {
      setSharingScreen(false);
      setError(describeScreenShareProblem(err));
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    const content = messageText.trim();
    if (!content || !meetingCode) return;

    const clientId = `${socketRef.current?.id || "local"}-${Date.now()}`;
    const optimisticMessage = {
      _id: clientId,
      clientId,
      meetingCode,
      senderName: user?.name || "You",
      content,
      createdAt: new Date().toISOString(),
      pending: true,
      isLocal: true,
    };

    setMessages((current) => mergeMessages(current, [optimisticMessage]));
    setMessageText("");

    try {
      const { data } = await api.post(`/messages/${meetingCode}`, { content });
      const savedMessage = { ...data.message, clientId, isLocal: true };

      setMessages((current) => mergeMessages(current.filter((message) => message.clientId !== clientId), [savedMessage]));
      if (socketRef.current?.connected) {
        socketRef.current.emit("chat-message", {
          meetingCode,
          clientId,
          content,
          senderName: user?.name,
          savedMessage,
        });
      } else {
        refreshMessages().catch(() => {});
      }
    } catch (err) {
      setMessages((current) =>
        current.map((message) =>
          message.clientId === clientId ? { ...message, pending: false, failed: true } : message
        )
      );
      setError(err.response?.data?.message || "Message could not be sent. Check backend and try again.");
    }
  };

  const generateSummary = async () => {
    if (generatingSummary || !meetingCode) return;

    try {
      setGeneratingSummary(true);
      const { data } = await api.post(`/summaries/${meetingCode}/generate`, {});

      if (!data?.summary) {
        throw new Error("Summary response was empty.");
      }

      setSummaries((current) => [data.summary, ...current.filter(Boolean)]);
    } catch (err) {
      setError(err.response?.data?.message || "Could not generate summary.");
    } finally {
      setGeneratingSummary(false);
    }
  };

  const copyInvite = async () => {
    await navigator.clipboard?.writeText(meetingUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const shareInvite = async () => {
    if (navigator.share) {
      await navigator.share({
        title: meeting?.title || "NexaMeet meeting",
        text: `Join ${meeting?.title || "NexaMeet meeting"}`,
        url: meetingUrl,
      });
      return;
    }

    await copyInvite();
  };

  const sendReaction = (emoji) => {
    socketRef.current?.emit("reaction", { emoji });
  };

  const toggleCaptions = () => {
    if (captionsEnabled) {
      recognitionRef.current?.stop?.();
      setCaptionsEnabled(false);
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Live captions are not supported in this browser. Try Chrome or Edge.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const text = result?.[0]?.transcript?.trim();
      if (!text) return;
      const caption = {
        id: `${Date.now()}`,
        name: user?.name || "You",
        text,
        createdAt: new Date().toISOString(),
      };
      setCaptions((current) => [...current.slice(-5), caption]);
      socketRef.current?.emit("live-caption", { text });
    };
    recognition.onend = () => setCaptionsEnabled(false);
    recognition.start();
    recognitionRef.current = recognition;
    setCaptionsEnabled(true);
  };

  const startRecording = () => {
    if (recording || !window.MediaRecorder) {
      if (!window.MediaRecorder) setError("Recording is not supported in this browser.");
      return;
    }

    const mixedStream = new MediaStream();
    localStreamRef.current?.getTracks().forEach((track) => mixedStream.addTrack(track));
    localScreenStream?.getTracks().forEach((track) => mixedStream.addTrack(track));
    remoteStreams.forEach((item) => item.stream.getTracks().forEach((track) => mixedStream.addTrack(track)));

    recordingChunksRef.current = [];
    const recorder = new MediaRecorder(mixedStream, { mimeType: "video/webm" });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordingChunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(recordingChunksRef.current, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${meetingCode || "nexameet"}-recording.webm`;
      link.click();
      URL.revokeObjectURL(url);
      setRecording(false);
    };
    recorder.start();
    mediaRecorderRef.current = recorder;
    setRecording(true);
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
  };

  const leaveMeeting = async () => {
    recognitionRef.current?.stop?.();
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    socketRef.current?.disconnect();
    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    offeredPeersRef.current.clear();
    pendingCandidatesRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setLocalScreenStream(null);
    setRemoteStreams([]);
    setParticipants([]);
    setPeerStates({});
    setSocketStatus("offline");
    navigate("/", { replace: true });
  };

  const toggleSidePanel = (tab) => {
    setSidePanelOpen((isOpen) => (isOpen && activeTab === tab ? false : true));
    setActiveTab(tab);
  };

  return (
    <main className="meeting-shell">
      <section className="stage">
        <header className="meeting-header">
          <div>
            <p className="eyebrow">{meeting?.canManage && meeting?.code ? `Meeting code ${meeting.code}` : "Private meeting"}</p>
            <h1>{meeting?.title || "Meeting"}</h1>
            <div className="meeting-live-meta">
              <span className={`live-dot ${socketStatus}`}></span>
              <span>{socketStatus === "connected" ? "Live room connected" : "Connecting live room"}</span>
              <span>{participants.length || 1} participant{(participants.length || 1) === 1 ? "" : "s"}</span>
            </div>
          </div>
          <div className="meeting-header-actions">
            <button className="icon-button" type="button" onClick={copyInvite} title="Copy meeting link">
              {copied ? <Check size={19} /> : <Copy size={19} />}
            </button>
            <button className="icon-button" type="button" onClick={shareInvite} title="Share meeting">
              <Share2 size={19} />
            </button>
          </div>
        </header>

        <div className="feedback-slot meeting-feedback">
          <p
            className={`error-text feedback-message ${error ? "" : "is-empty"}`}
            role={error ? "alert" : undefined}
            aria-hidden={error ? undefined : "true"}
          >
            {error || "Status"}
          </p>
        </div>

        <div className={`video-grid ${useTwoPersonLayout ? "video-grid-two-up" : "video-grid-pinned"}`}>
          {useTwoPersonLayout ? (
            <>
              {videoTiles.map((tile) => (
                <VideoTile
                  key={tile.id}
                  tile={tile}
                  isMain={videoTiles.length === 1}
                  isPinned={tile.id === pinnedTile.id}
                  onPin={pinTile}
                  onRetryAudio={() => requestMissingMediaTrack("audio").catch(() => {})}
                  onRetryVideo={() => requestMissingMediaTrack("video").catch(() => {})}
                />
              ))}
              {!hasRemoteParticipants && (
                <div className="meeting-waiting-panel">
                  <strong>Waiting for others to join</strong>
                  <p>Share this meeting link from another phone, laptop, or browser profile to start a full multi-person call.</p>
                  <div className="meeting-waiting-actions">
                    <button className="secondary-button" type="button" onClick={copyInvite}>
                      {copied ? <Check size={18} /> : <Copy size={18} />} Copy link
                    </button>
                    <button className="primary-button" type="button" onClick={shareInvite}>
                      <Share2 size={18} /> Share
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <VideoTile
                tile={pinnedTile}
                isMain
                isPinned
                onPin={pinTile}
                onRetryAudio={() => requestMissingMediaTrack("audio").catch(() => {})}
                onRetryVideo={() => requestMissingMediaTrack("video").catch(() => {})}
              />
              <aside className="video-filmstrip" aria-label="Participants">
                {sideTiles.map((tile) => (
                  <VideoTile
                    key={tile.id}
                    tile={tile}
                    isPinned={tile.id === pinnedTile.id}
                    onPin={pinTile}
                    onRetryAudio={() => requestMissingMediaTrack("audio").catch(() => {})}
                    onRetryVideo={() => requestMissingMediaTrack("video").catch(() => {})}
                  />
                ))}
              </aside>
            </>
          )}
        </div>

        {reactions.length > 0 && (
          <div className="reaction-float">
            {reactions.map((reaction) => (
              <span key={reaction.id} title={reaction.name}>
                {reaction.emoji}
              </span>
            ))}
          </div>
        )}

        {captions.length > 0 && (
          <div className="caption-overlay">
            {captions.slice(-2).map((caption) => (
              <p key={caption.id}>
                <strong>{caption.name}:</strong> {caption.text}
              </p>
            ))}
          </div>
        )}

        <div className="reaction-dock">
          {reactionChoices.map((emoji) => (
            <button key={emoji} type="button" onClick={() => sendReaction(emoji)}>
              {emoji}
            </button>
          ))}
        </div>

        <div className="call-controls">
          <button className="icon-button" onClick={toggleAudio} type="button" title={audioEnabled ? "Mute mic" : "Unmute mic"}>
            {audioEnabled ? <Mic size={21} /> : <MicOff size={21} />}
          </button>
          <button
            className="icon-button"
            onClick={switchCamera}
            type="button"
            title={videoEnabled ? `Switch to ${cameraFacingMode === "user" ? "back" : "front"} camera` : "Turn camera on"}
          >
            {videoEnabled ? <Camera size={21} /> : <CameraOff size={21} />}
          </button>
          <button className={`icon-button ${handRaised ? "active-control" : ""}`} onClick={toggleHand} type="button" title="Raise hand">
            <Hand size={21} />
          </button>
          <button className={`icon-button ${sharingScreen ? "active-control" : ""}`} onClick={shareScreen} type="button" title={sharingScreen ? "Stop sharing" : "Share screen"}>
            <MonitorUp size={21} />
          </button>
          <button className={`icon-button ${captionsEnabled ? "active-control" : ""}`} onClick={toggleCaptions} type="button" title="Live captions">
            <Subtitles size={21} />
          </button>
          <button className={`icon-button ${blurEnabled ? "active-control" : ""}`} onClick={() => setBlurEnabled((current) => !current)} type="button" title="Soft focus">
            <Wand2 size={21} />
          </button>
          <button className={`icon-button ${recording ? "recording-control" : ""}`} onClick={recording ? stopRecording : startRecording} type="button" title="Local recording">
            {recording ? <Square size={18} /> : <Radio size={21} />}
          </button>
          <button className={`icon-button ${sidePanelOpen && activeTab === "chat" ? "active-control" : ""}`} onClick={() => toggleSidePanel("chat")} type="button" title="Chat">
            <MessageSquare size={21} />
          </button>
          <button className={`icon-button ${sidePanelOpen && activeTab === "people" ? "active-control" : ""}`} onClick={() => toggleSidePanel("people")} type="button" title="People">
            <Users size={21} />
          </button>
          <button className="danger-button" onClick={leaveMeeting} type="button">
            <PhoneOff size={19} /> Leave
          </button>
        </div>
      </section>

      <aside className={`side-panel meeting-side-panel ${sidePanelOpen ? "is-open" : ""}`}>
        <nav className="meeting-tabs">
          <button className={activeTab === "chat" ? "active" : ""} onClick={() => toggleSidePanel("chat")} type="button" title="Chat">
            <MessageSquare size={18} />
          </button>
          <button className={activeTab === "people" ? "active" : ""} onClick={() => toggleSidePanel("people")} type="button" title="People">
            <Users size={18} />
          </button>
          <button className={activeTab === "details" ? "active" : ""} onClick={() => toggleSidePanel("details")} type="button" title="Details">
            <Info size={18} />
          </button>
          <button className={activeTab === "summary" ? "active" : ""} onClick={() => toggleSidePanel("summary")} type="button" title="Summary">
            <Sparkles size={18} />
          </button>
        </nav>

        {activeTab === "chat" && (
          <div className="tab-section single-tab">
            <h2>Chat</h2>
            <div className="messages">
              {messages.map((message) => {
                const ownMessage = isOwnMessage(message);

                return (
                <article key={message._id || `${message.socketId}-${message.createdAt}-${message.content}`} className={`message ${ownMessage ? "own" : "other"} ${message.pending ? "pending" : ""} ${message.failed ? "failed" : ""}`}>
                  <strong>{message.senderName}{message.pending ? " · sending" : ""}</strong>
                  <p>{message.content}</p>
                </article>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
            <form className="message-form" onSubmit={sendMessage}>
              <input value={messageText} onChange={(event) => setMessageText(event.target.value)} placeholder="Message" />
              <button className="icon-button" type="submit" title="Send message">
                <Send size={18} />
              </button>
            </form>
          </div>
        )}

        {activeTab === "people" && (
          <div className="tab-section single-tab">
            <h2>People ({participants.length || 1})</h2>
            <div className="people-list">
              <ParticipantRow name={user?.name || "You"} audioEnabled={audioEnabled} videoEnabled={videoEnabled} handRaised={handRaised} isYou />
              {participants
                .filter((participant) => participant.socketId !== socketRef.current?.id)
                .map((participant) => (
                  <ParticipantRow key={participant.socketId} {...participant} />
                ))}
            </div>
          </div>
        )}

        {activeTab === "details" && (
          <div className="tab-section single-tab details-panel">
            <h2>Meeting details</h2>
            <label>
              Meeting ID
              <input value={meeting?.canManage && meeting?.code ? meeting.code : "Hidden for invite participants"} readOnly />
            </label>
            <label>
              Invite link
              <input value={meetingUrl} readOnly />
            </label>
            <button className="secondary-button" type="button" onClick={copyInvite}>
              {copied ? <Check size={18} /> : <Copy size={18} />} Copy invite
            </button>
            <button className="primary-button" type="button" onClick={shareInvite}>
              <Share2 size={18} /> Share invite
            </button>
          </div>
        )}

        {activeTab === "summary" && (
          <div className="tab-section single-tab summaries">
            <div className="panel-heading">
              <Sparkles size={19} />
              <h2>AI Summary</h2>
            </div>
            <button className="secondary-button" onClick={generateSummary} type="button" disabled={generatingSummary}>
              {generatingSummary ? "Generating AI summary..." : "Generate AI summary"}
            </button>
            <div className="summary-list">
              {summaries.filter(Boolean).map((summary) => (
                <article key={summary._id || summary.createdAt || summary.summary} className="summary-item">
                  <strong>{summary.title || "Meeting summary"}</strong>
                  <p>{summary.summary || "No summary text was generated."}</p>
                  {summary.actionItems?.length > 0 && <small>Actions: {summary.actionItems.join("; ")}</small>}
                  <small>{summary.generatedBy === "ai" ? "AI generated" : "Local summary fallback"}</small>
                </article>
              ))}
            </div>
          </div>
        )}
      </aside>
    </main>
  );
}

function ParticipantRow({ name, audioEnabled = true, videoEnabled = true, handRaised = false, isYou = false }) {
  return (
    <article className="participant-row">
      <span>{(name || "G").slice(0, 1).toUpperCase()}</span>
      <div>
        <strong>
          {name || "Guest"} {isYou ? "(You)" : ""}
        </strong>
        <small>{handRaised ? "Hand raised" : "In meeting"}</small>
      </div>
      <div className="participant-icons">
        {audioEnabled ? <Mic size={15} /> : <MicOff size={15} />}
        {videoEnabled ? <Camera size={15} /> : <CameraOff size={15} />}
        {handRaised && <Hand size={15} />}
      </div>
    </article>
  );
}

function StreamVideo({ stream, muted = false }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream || null;
      videoRef.current.play().catch(() => {});
    }
  }, [stream]);

  return <video ref={videoRef} autoPlay muted={muted} playsInline />;
}

function VideoTile({ tile, isMain = false, isPinned = false, onPin, onRetryAudio, onRetryVideo }) {
  const label = tile.isScreen ? tile.name || "Shared screen" : `${tile.name || "Guest"}${tile.isLocal ? " (You)" : ""}`;
  const connectionLabel = {
    connected: "Connected",
    connecting: "Connecting media",
    checking: "Connecting media",
    disconnected: "Reconnecting",
    failed: "Media connection failed",
    closed: "Disconnected",
  }[tile.connectionState] || "Connecting media";

  return (
    <article
      className={`video-tile ${tile.isLocal && !tile.isScreen ? "local" : ""} ${tile.isMirrored ? "mirrored" : ""} ${tile.isScreen ? "screen-share-tile" : ""} ${tile.softFocus ? "soft-focus" : ""} ${
        isMain ? "main-video-tile" : "mini-video-tile"
      }`}
    >
      {tile.stream && tile.videoEnabled !== false ? (
        <StreamVideo stream={tile.stream} muted={tile.isLocal} />
      ) : (
        <div className="video-placeholder">
          {tile.isLocal && tile.mediaIssue ? (
            <div className="tile-recovery">
              <Settings size={22} />
              <strong>{tile.mediaIssue.title}</strong>
              <small>{tile.mediaIssue.detail}</small>
              {tile.mediaIssue.steps?.length > 0 && (
                <ol className="tile-recovery-steps">
                  {tile.mediaIssue.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              )}
              <div className="tile-recovery-actions">
                <button type="button" onClick={onRetryAudio} disabled={tile.mediaBusy}>
                  <Mic size={15} /> Mic
                </button>
                <button type="button" onClick={onRetryVideo} disabled={tile.mediaBusy}>
                  <Camera size={15} /> Camera
                </button>
              </div>
              {tile.mediaBusy && <small>Asking browser permission...</small>}
            </div>
          ) : (
            <span>{tile.videoEnabled === false ? "Camera off" : tile.isLocal ? "Starting camera..." : connectionLabel}</span>
          )}
        </div>
      )}
      {(tile.handRaised || tile.isScreen) && <b className="tile-badge">{tile.isScreen ? "Presenting" : "Hand raised"}</b>}
      {!tile.isScreen && <div className="tile-status-icons" aria-label="Participant media status">
        <span className={tile.audioEnabled === false ? "off" : ""} title={tile.audioEnabled === false ? "Mic off" : "Mic on"}>
          {tile.audioEnabled === false ? <MicOff size={15} /> : <Mic size={15} />}
        </span>
        <span className={tile.videoEnabled === false ? "off" : ""} title={tile.videoEnabled === false ? "Camera off" : "Camera on"}>
          {tile.videoEnabled === false ? <CameraOff size={15} /> : <Camera size={15} />}
        </span>
        {tile.handRaised && (
          <span className="raised" title="Hand raised">
            <Hand size={15} />
          </span>
        )}
      </div>}
      <div className="tile-footer">
        <span>{label}</span>
        <button className={`tile-pin ${isPinned ? "active" : ""}`} type="button" onClick={() => onPin(tile.id)} title="Pin video">
          <Pin size={15} />
          {isMain ? "Pinned" : "Pin"}
        </button>
      </div>
    </article>
  );
}
