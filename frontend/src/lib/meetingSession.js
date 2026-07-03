const activeMeetingKey = "nexaMeet.activeMeeting";
const activeMeetingMaxAgeMs = 24 * 60 * 60 * 1000;

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
