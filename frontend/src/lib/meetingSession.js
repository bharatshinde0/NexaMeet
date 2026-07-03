const activeMeetingKey = "nexaMeet.activeMeeting";
const joinedMeetingHistoryKey = "nexaMeet.joinedMeetingHistory";
const activeMeetingMaxAgeMs = 24 * 60 * 60 * 1000;
const joinedMeetingHistoryLimit = 2;

export const saveActiveMeeting = (value, type = "meeting", details = {}) => {
  if (!value) return;

  localStorage.setItem(
    activeMeetingKey,
    JSON.stringify({
      code: type === "meeting" ? value : undefined,
      path: type === "join" ? `/join/${value}` : `/meeting/${value}`,
      title: details.title,
      savedAt: Date.now(),
    })
  );
};

export const clearActiveMeeting = (code) => {
  const activeMeeting = readActiveMeeting();

  if (!code || activeMeeting?.code === code) {
    localStorage.removeItem(activeMeetingKey);
  }
};

export const readActiveMeeting = () => {
  try {
    const activeMeeting = JSON.parse(localStorage.getItem(activeMeetingKey) || "null");

    if ((!activeMeeting?.code && !activeMeeting?.path) || Date.now() - Number(activeMeeting.savedAt || 0) > activeMeetingMaxAgeMs) {
      localStorage.removeItem(activeMeetingKey);
      return null;
    }

    return activeMeeting;
  } catch {
    localStorage.removeItem(activeMeetingKey);
    return null;
  }
};

export const saveJoinedMeetingHistory = (meeting) => {
  if (!meeting?.path) return;

  const nextMeeting = {
    path: meeting.path,
    title: meeting.title || "Meeting",
    savedAt: Date.now(),
  };
  const history = readJoinedMeetingHistory().filter((item) => item.path !== nextMeeting.path);
  localStorage.setItem(joinedMeetingHistoryKey, JSON.stringify([nextMeeting, ...history].slice(0, joinedMeetingHistoryLimit)));
};

export const readJoinedMeetingHistory = () => {
  try {
    const history = JSON.parse(localStorage.getItem(joinedMeetingHistoryKey) || "[]");

    if (!Array.isArray(history)) {
      localStorage.removeItem(joinedMeetingHistoryKey);
      return [];
    }

    return history
      .filter((item) => item?.path)
      .sort((first, second) => Number(second.savedAt || 0) - Number(first.savedAt || 0))
      .slice(0, joinedMeetingHistoryLimit);
  } catch {
    localStorage.removeItem(joinedMeetingHistoryKey);
    return [];
  }
};
