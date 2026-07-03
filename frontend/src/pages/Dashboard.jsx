import React, { useEffect, useState } from "react";
import {
  Calendar,
  Check,
  Clock,
  Copy,
  Edit3,
  Link,
  LogOut,
  Plus,
  Save,
  Share2,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api.js";
import { clearActiveMeeting, readActiveMeeting, readJoinedMeetingHistory } from "../lib/meetingSession.js";
import { useAuth } from "../state/AuthContext.jsx";

const formatDateTime = (value) => {
  if (!value) return "Start any time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
};

const toDatetimeInputValue = (value) => {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [meetings, setMeetings] = useState([]);
  const [title, setTitle] = useState("Instant meeting");
  const [scheduledAt, setScheduledAt] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [createdMeeting, setCreatedMeeting] = useState(null);
  const [copiedCode, setCopiedCode] = useState("");
  const [editingCode, setEditingCode] = useState("");
  const [editForm, setEditForm] = useState({ title: "", scheduledAt: "" });
  const [activeMeeting, setActiveMeeting] = useState(() => readActiveMeeting());
  const [joinedHistory] = useState(() => readJoinedMeetingHistory());

  const loadMeetings = async () => {
    const { data } = await api.get("/meetings");
    setMeetings(data.meetings);
  };

  useEffect(() => {
    loadMeetings()
      .catch((err) => setError(err.response?.data?.message || "Could not load meetings"))
      .finally(() => setLoading(false));

    const refreshTimer = window.setInterval(() => {
      loadMeetings().catch(() => {});
    }, 30000);

    return () => window.clearInterval(refreshTimer);
  }, []);

  const createMeeting = async (event) => {
    event.preventDefault();
    setError("");
    const { data } = await api.post("/meetings", {
      title,
      scheduledAt: scheduledAt || undefined,
    });
    setCreatedMeeting(data.meeting);
    setMeetings((current) => [data.meeting, ...current.filter((meeting) => meeting._id !== data.meeting._id)]);

    if (!scheduledAt) {
      navigate(`/meeting/${data.meeting.code}`);
    }
  };

  const joinMeeting = (event) => {
    event.preventDefault();
    const cleanCode = joinCode.trim().replace(/[^a-zA-Z0-9-_]/g, "").toUpperCase();
    if (cleanCode) {
      navigate(`/meeting/${cleanCode}`);
    }
  };

  const meetingUrl = (meeting) =>
    meeting.inviteToken ? `${window.location.origin}/join/${meeting.inviteToken}` : `${window.location.origin}/meeting/${meeting.code}`;

  const copyMeeting = async (meeting) => {
    await navigator.clipboard?.writeText(meetingUrl(meeting));
    setCopiedCode(meeting.code);
    window.setTimeout(() => setCopiedCode(""), 1800);
  };

  const shareMeeting = async (meeting) => {
    const shareData = {
      title: meeting.title,
      text: `Join my NexaMeet meeting: ${meeting.title}`,
      url: meetingUrl(meeting),
    };

    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }

    await copyMeeting(meeting);
  };

  const beginEdit = (meeting) => {
    setEditingCode(meeting.code);
    setEditForm({
      title: meeting.title,
      scheduledAt: toDatetimeInputValue(meeting.scheduledAt),
    });
  };

  const saveMeeting = async (meeting) => {
    setError("");
    const { data } = await api.patch(`/meetings/${meeting.code}`, {
      title: editForm.title,
      scheduledAt: editForm.scheduledAt || undefined,
    });
    setMeetings((current) => current.map((item) => (item.code === meeting.code ? data.meeting : item)));
    if (createdMeeting?.code === meeting.code) {
      setCreatedMeeting(data.meeting);
    }
    setEditingCode("");
  };

  const deleteMeeting = async (meeting) => {
    const confirmed = window.confirm(`Delete meeting "${meeting.title}"?`);
    if (!confirmed) return;

    setError("");
    await api.delete(`/meetings/${meeting.code}`);
    setMeetings((current) => current.filter((item) => item.code !== meeting.code));
    if (createdMeeting?.code === meeting.code) {
      setCreatedMeeting(null);
    }
  };

  const dismissActiveMeeting = () => {
    clearActiveMeeting();
    setActiveMeeting(null);
  };

  return (
    <main className="app-shell dashboard-page">
      <header className="topbar dashboard-hero">
        <div>
          <p className="eyebrow">Signed in as {user?.username}</p>
          <h1>Welcome back, {user?.name?.split(" ")[0] || "there"}</h1>
          <p className="hero-copy">Create secure NexaMeet rooms, schedule calls, and share meeting links in seconds.</p>
        </div>
        <div className="hero-actions">
          <button className="secondary-button" onClick={() => navigate(`/meeting/${joinCode.trim().toUpperCase()}`)} disabled={!joinCode.trim()} type="button">
            <Video size={18} /> Quick join
          </button>
          <button className="icon-button light" onClick={logout} title="Logout" type="button">
            <LogOut size={20} />
          </button>
        </div>
      </header>

      {activeMeeting?.path && (
        <section className="rejoin-banner">
          <div>
            <p className="eyebrow">Recent meeting</p>
            <h2>{activeMeeting.title || "Meeting in progress"}</h2>
            <p>You can rejoin with your saved browser permissions.</p>
          </div>
          <div className="share-actions">
            <button className="primary-button" type="button" onClick={() => navigate(activeMeeting.path)}>
              <Video size={18} /> Rejoin
            </button>
            <button className="icon-button" type="button" onClick={dismissActiveMeeting} title="Dismiss rejoin option">
              <X size={18} />
            </button>
          </div>
        </section>
      )}

      {joinedHistory.length > 0 && (
        <section className="joined-history">
          <div className="panel-heading">
            <Clock size={20} />
            <h2>Joined recently</h2>
          </div>
          <div className="joined-history-list">
            {joinedHistory.map((meeting) => (
              <button key={meeting.path} className="joined-history-item" type="button" onClick={() => navigate(meeting.path)}>
                <span>
                  <strong>{meeting.title}</strong>
                  <small>{formatDateTime(meeting.savedAt)}</small>
                </span>
                <Video size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="dashboard-grid">
        <form className="workspace-panel" onSubmit={createMeeting}>
          <div className="panel-heading">
            <Video size={22} />
            <h2>Create meeting</h2>
          </div>
          <label>
            Meeting title
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            Start time
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </label>
          <button className="primary-button" type="submit">
            <Plus size={18} /> {scheduledAt ? "Schedule meeting" : "Create and join"}
          </button>
        </form>

        <form className="workspace-panel" onSubmit={joinMeeting}>
          <div className="panel-heading">
            <Calendar size={22} />
            <h2>Join by code</h2>
          </div>
          <label>
            Meeting code
            <input value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="AB12CD34" required />
          </label>
          <button className={`secondary-button join-code-button ${joinCode.trim() ? "is-ready" : ""}`} type="submit">
            Join meeting
          </button>
        </form>
      </section>

      {createdMeeting && (
        <section className="share-banner">
          <div>
            <p className="eyebrow">Meeting ready</p>
            <h2>{createdMeeting.title}</h2>
            <p>{formatDateTime(createdMeeting.scheduledAt)}</p>
          </div>
          <code>{createdMeeting.code}</code>
          <div className="share-actions">
            <button className="secondary-button" type="button" onClick={() => copyMeeting(createdMeeting)}>
              {copiedCode === createdMeeting.code ? <Check size={18} /> : <Copy size={18} />} Copy link
            </button>
            <button className="primary-button" type="button" onClick={() => shareMeeting(createdMeeting)}>
              <Share2 size={18} /> Share
            </button>
            <button className="secondary-button" type="button" onClick={() => navigate(`/meeting/${createdMeeting.code}`)}>
              Start now
            </button>
          </div>
        </section>
      )}

      <div className="feedback-slot page-feedback">
        <p
          className={`error-text feedback-message ${error ? "" : "is-empty"}`}
          role={error ? "alert" : undefined}
          aria-hidden={error ? undefined : "true"}
        >
          {error || "Status"}
        </p>
      </div>

      <section className="meeting-list">
        <h2>Recent meetings</h2>
        {loading ? (
          <p className="muted">Loading meetings...</p>
        ) : meetings.length === 0 ? (
          <p className="muted">No meetings yet.</p>
        ) : (
          <div className="meeting-rows">
            {meetings.map((meeting) => (
              <article key={meeting._id} className="meeting-row">
                {editingCode === meeting.code ? (
                  <div className="meeting-edit">
                    <label>
                      Title
                      <input value={editForm.title} onChange={(event) => setEditForm((current) => ({ ...current, title: event.target.value }))} />
                    </label>
                    <label>
                      Time
                      <input
                        type="datetime-local"
                        value={editForm.scheduledAt}
                        onChange={(event) => setEditForm((current) => ({ ...current, scheduledAt: event.target.value }))}
                      />
                    </label>
                  </div>
                ) : (
                  <button className="meeting-main" onClick={() => navigate(`/meeting/${meeting.code}`)} type="button">
                    <span className="meeting-icon">
                      <Video size={20} />
                    </span>
                    <span>
                      <strong>{meeting.title}</strong>
                      <small>
                        <Clock size={14} /> {formatDateTime(meeting.scheduledAt)}
                      </small>
                      <small>
                        <Link size={14} /> {meeting.code || "Private invite link"}
                      </small>
                    </span>
                  </button>
                )}
                <div className="meeting-actions">
                  <span className={`status-pill ${meeting.status}`}>{meeting.status}</span>
                  <button className="icon-button" onClick={() => navigate(`/meeting/${meeting.code}`)} title="Start or join meeting" type="button">
                    <Video size={18} />
                  </button>
                  <button className="icon-button" onClick={() => copyMeeting(meeting)} title="Copy meeting link" type="button">
                    {copiedCode === meeting.code ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                  <button className="icon-button" onClick={() => shareMeeting(meeting)} title="Share meeting" type="button">
                    <Share2 size={18} />
                  </button>
                  {editingCode === meeting.code ? (
                    <button className="icon-button" onClick={() => saveMeeting(meeting)} title="Save meeting" type="button">
                      <Save size={18} />
                    </button>
                  ) : (
                    <button className="icon-button" onClick={() => beginEdit(meeting)} title="Edit meeting" type="button">
                      <Edit3 size={18} />
                    </button>
                  )}
                  <button className="icon-button danger-icon" onClick={() => deleteMeeting(meeting)} title="Delete meeting" type="button">
                    <Trash2 size={18} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
