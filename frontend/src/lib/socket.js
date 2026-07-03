import { io } from "socket.io-client";

const resolveSocketUrl = () => {
  const configuredUrl = import.meta.env.VITE_SOCKET_URL;
  const isLanVisit = !["localhost", "127.0.0.1"].includes(window.location.hostname);

  if (configuredUrl && !(isLanVisit && configuredUrl.includes("localhost"))) {
    return configuredUrl;
  }

  return `${window.location.protocol}//${window.location.hostname}:8001`;
};

export const createSocket = (token) =>
  io(resolveSocketUrl(), {
    auth: { token },
    transports: ["websocket", "polling"],
  });
