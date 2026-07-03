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
  Share2,
  Sparkles,
  Square,
  Subtitles,
  Users,
  Wand2,
} from "lucide-react";
import { api } from "../lib/api.js";
import { createSocket } from "../lib/socket.js";
import { useAuth } from "../state/AuthContext.jsx";

const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:global.stun.twilio.com:3478" }];
const insecureLanMediaMessage =
  "Camera and microphone need HTTPS when opening NexaMeet from another device. You can still join chat/details, but video needs HTTPS or localhost.";

const canUseMediaDevices = () => Boolean(navigator.mediaDevices?.getUserMedia);

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
  const { code } = useParams();
  const navigate = useNavigate();
  const { token, user } = useAuth();
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const socketRef = useRef(null);
  const peersRef = useRef(new Map());
  const pendingCandidatesRef = useRef(new Map());
  const mediaRecorderRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recognitionRef = useRef(null);
  const messagesEndRef = useRef(null);

  const [meeting, setMeeting] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState([]);
  const [localStream, setLocalStream] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [messageText, setMessageText] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState("chat");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [handRaised, setHandRaised] = useState(false);
  const [recording, setRecording] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captions, setCaptions] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [blurEnabled, setBlurEnabled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pinnedTileId, setPinnedTileId] = useState("local");
  const [sidePanelOpen, setSidePanelOpen] = useState(false);

  const meetingUrl = `${window.location.origin}/meeting/${code}`;
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
      stream: remoteStreams.find((item) => item.socketId === participant.socketId)?.stream || null,
    }));
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
    },
    ...remoteTiles,
  ];
  const useTwoPersonLayout = videoTiles.length <= 2;
  const pinnedTile = videoTiles.find((tile) => tile.id === pinnedTileId) || videoTiles[0];
  const sideTiles = videoTiles.filter((tile) => tile.id !== pinnedTile.id);

  const refreshMessages = useCallback(async () => {
    const { data } = await api.get(`/messages/${code}?limit=1000`);
    setMessages((current) => mergeMessages(current, data.messages));
  }, [code]);

  const removePeer = useCallback((socketId) => {
    const peer = peersRef.current.get(socketId);
    if (peer) {
      peer.close();
      peersRef.current.delete(socketId);
    }
    setRemoteStreams((current) => current.filter((item) => item.socketId !== socketId));
  }, []);

  const emitParticipantState = useCallback((nextState) => {
    socketRef.current?.emit("participant-state", nextState);
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

  const createPeer = useCallback(
    async (socketId, shouldCreateOffer) => {
      if (!socketId || socketId === socketRef.current?.id) {
        return null;
      }

      if (peersRef.current.has(socketId)) {
        return peersRef.current.get(socketId);
      }

      const peer = new RTCPeerConnection({ iceServers });
      peersRef.current.set(socketId, peer);

      localStreamRef.current?.getTracks().forEach((track) => {
        peer.addTrack(track, localStreamRef.current);
      });

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit("webrtc-ice-candidate", { to: socketId, candidate: event.candidate });
        }
      };

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;

        setRemoteStreams((current) => {
          const existing = current.find((item) => item.socketId === socketId);
          if (existing) {
            return current.map((item) => (item.socketId === socketId ? { ...item, stream } : item));
          }
          return [...current, { socketId, stream }];
        });
      };

      peer.onconnectionstatechange = () => {
        if (["closed", "failed", "disconnected"].includes(peer.connectionState)) {
          removePeer(socketId);
        }
      };

      if (shouldCreateOffer) {
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        socketRef.current?.emit("webrtc-offer", { to: socketId, offer });
      }

      return peer;
    },
    [removePeer]
  );

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

    const boot = async () => {
      try {
        const [{ data: meetingData }, { data: messageData }, { data: summaryData }] = await Promise.all([
          api.get(`/meetings/${code}`),
          api.get(`/messages/${code}?limit=1000`),
          api.get(`/summaries/${code}`),
        ]);

        if (!active) return;

        setMeeting(meetingData.meeting);
        setMessages((current) => mergeMessages(current, messageData.messages));
        setSummaries(summaryData.summaries);
        await api.patch(`/meetings/${code}/start`);

        let stream = new MediaStream();

        if (canUseMediaDevices()) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } else {
          setAudioEnabled(false);
          setVideoEnabled(false);
          setError(insecureLanMediaMessage);
        }

        localStreamRef.current = stream;
        setLocalStream(stream);

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        const socket = createSocket(token);
        socketRef.current = socket;

        socket.on("connect", () => {
          socket.emit("join-call", { meetingCode: code, name: user?.name, userId: user?.id });
          socket.emit("participant-state", {
            audioEnabled: stream.getAudioTracks().some((track) => track.enabled),
            videoEnabled: stream.getVideoTracks().some((track) => track.enabled),
            handRaised: false,
          });
        });

        socket.on("room-users", async (roomUsers) => {
          setParticipants(roomUsers);
          for (const participant of roomUsers) {
            if (participant.socketId !== socket.id) {
              await createPeer(participant.socketId, false);
            }
          }
        });

        socket.on("participant-joined", (participant) => {
          setParticipants((current) => [...current.filter((item) => item.socketId !== participant.socketId), participant]);
        });

        socket.on("user-joined", async (socketId) => {
          await createPeer(socketId, true);
        });

        socket.on("participant-left", (participant) => {
          setParticipants((current) => current.filter((item) => item.socketId !== participant.socketId));
          removePeer(participant.socketId);
        });

        socket.on("user-left", removePeer);

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
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    };
  }, [code, createPeer, removePeer, token, user]);

  const toggleAudio = () => {
    if (!canUseMediaDevices() || !localStreamRef.current?.getAudioTracks().length) {
      setError(insecureLanMediaMessage);
      return;
    }

    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setAudioEnabled(track.enabled);
      emitParticipantState({ audioEnabled: track.enabled, videoEnabled, handRaised });
    });
  };

  const toggleVideo = () => {
    if (!canUseMediaDevices() || !localStreamRef.current?.getVideoTracks().length) {
      setError(insecureLanMediaMessage);
      return;
    }

    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !track.enabled;
      setVideoEnabled(track.enabled);
      emitParticipantState({ audioEnabled, videoEnabled: track.enabled, handRaised });
    });
  };

  const toggleHand = () => {
    const nextHandRaised = !handRaised;
    setHandRaised(nextHandRaised);
    emitParticipantState({ audioEnabled, videoEnabled, handRaised: nextHandRaised });
  };

  const replaceVideoTrack = async (nextTrack) => {
    peersRef.current.forEach((peer) => {
      const sender = peer.getSenders().find((item) => item.track?.kind === "video");
      sender?.replaceTrack(nextTrack);
    });

    const currentVideoTrack = localStreamRef.current?.getVideoTracks()[0];
    if (currentVideoTrack) {
      localStreamRef.current.removeTrack(currentVideoTrack);
      currentVideoTrack.stop();
    }

    localStreamRef.current?.addTrack(nextTrack);
    setLocalStream(new MediaStream(localStreamRef.current?.getTracks() || []));
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  };

  const shareScreen = async () => {
    if (sharingScreen) return;

    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        setError("Screen sharing needs HTTPS when opening NexaMeet from another device.");
        return;
      }

      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const [screenTrack] = screenStream.getVideoTracks();
      await replaceVideoTrack(screenTrack);
      setSharingScreen(true);

      screenTrack.onended = async () => {
        if (!canUseMediaDevices()) {
          setSharingScreen(false);
          return;
        }

        const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        await replaceVideoTrack(cameraStream.getVideoTracks()[0]);
        setSharingScreen(false);
      };
    } catch (err) {
      setError(err.message || "Screen sharing failed");
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    const content = messageText.trim();
    if (!content) return;

    const clientId = `${socketRef.current?.id || "local"}-${Date.now()}`;
    const optimisticMessage = {
      _id: clientId,
      clientId,
      meetingCode: code,
      senderName: user?.name || "You",
      content,
      createdAt: new Date().toISOString(),
      pending: true,
      isLocal: true,
    };

    setMessages((current) => mergeMessages(current, [optimisticMessage]));
    setMessageText("");

    try {
      const { data } = await api.post(`/messages/${code}`, { content });
      const savedMessage = { ...data.message, clientId, isLocal: true };

      setMessages((current) => mergeMessages(current.filter((message) => message.clientId !== clientId), [savedMessage]));
      if (socketRef.current?.connected) {
        socketRef.current.emit("chat-message", {
          meetingCode: code,
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
    if (generatingSummary) return;

    try {
      setGeneratingSummary(true);
      const { data } = await api.post(`/summaries/${code}/generate`, {});

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
        text: `Join meeting ${code}`,
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
      link.download = `${code}-recording.webm`;
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
    navigate("/");
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
            <p className="eyebrow">Meeting code {code}</p>
            <h1>{meeting?.title || "Meeting"}</h1>
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
            videoTiles.map((tile) => (
              <VideoTile key={tile.id} tile={tile} isMain={videoTiles.length === 1} onPin={setPinnedTileId} />
            ))
          ) : (
            <>
              <VideoTile tile={pinnedTile} isMain isPinned onPin={setPinnedTileId} />
              <aside className="video-filmstrip" aria-label="Participants">
                {sideTiles.map((tile) => (
                  <VideoTile
                    key={tile.id}
                    tile={tile}
                    isPinned={tile.id === pinnedTile.id}
                    onPin={setPinnedTileId}
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
          <button className="icon-button" onClick={toggleVideo} type="button" title={videoEnabled ? "Turn camera off" : "Turn camera on"}>
            {videoEnabled ? <Camera size={21} /> : <CameraOff size={21} />}
          </button>
          <button className={`icon-button ${handRaised ? "active-control" : ""}`} onClick={toggleHand} type="button" title="Raise hand">
            <Hand size={21} />
          </button>
          <button className="icon-button" onClick={shareScreen} type="button" title="Share screen">
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
              <input value={code} readOnly />
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

function VideoTile({ tile, isMain = false, isPinned = false, onPin }) {
  const label = `${tile.name || "Guest"}${tile.isLocal ? " (You)" : ""}`;

  return (
    <article
      className={`video-tile ${tile.isLocal ? "local" : ""} ${tile.softFocus ? "soft-focus" : ""} ${
        isMain ? "main-video-tile" : "mini-video-tile"
      }`}
    >
      {tile.stream && tile.videoEnabled !== false ? (
        <StreamVideo stream={tile.stream} muted={tile.isLocal} />
      ) : (
        <div className="video-placeholder">{tile.videoEnabled === false ? "Camera off" : "Connecting..."}</div>
      )}
      {tile.handRaised && <b className="tile-badge">Hand raised</b>}
      <div className="tile-status-icons" aria-label="Participant media status">
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
      </div>
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
