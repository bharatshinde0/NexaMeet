import axios from "axios";

const resolveApiUrl = () => {
  const configuredUrl = import.meta.env.VITE_API_URL;
  const isLanVisit = !["localhost", "127.0.0.1"].includes(window.location.hostname);

  if (configuredUrl && !(isLanVisit && configuredUrl.includes("localhost"))) {
    return configuredUrl;
  }

  return `${window.location.protocol}//${window.location.hostname}:8001/api/v1`;
};

export const api = axios.create({
  baseURL: resolveApiUrl(),
  timeout: 20000,
});

const readStoredToken = () => {
  try {
    return JSON.parse(localStorage.getItem("newVideoCall.auth") || "{}")?.token;
  } catch {
    return null;
  }
};

api.interceptors.request.use((config) => {
  const token = readStoredToken();

  if (token && !config.headers.Authorization) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

export const setAuthToken = (token) => {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
};
