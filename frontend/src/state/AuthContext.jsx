import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, setAuthToken } from "../lib/api.js";

const AuthContext = createContext(null);
const storageKey = "newVideoCall.auth";

export const AuthProvider = ({ children }) => {
  const [auth, setAuth] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    const initialAuth = saved ? JSON.parse(saved) : { token: null, user: null };
    setAuthToken(initialAuth.token);
    return initialAuth;
  });

  useEffect(() => {
    setAuthToken(auth.token);
    localStorage.setItem(storageKey, JSON.stringify(auth));
  }, [auth]);

  const value = useMemo(
    () => ({
      token: auth.token,
      user: auth.user,
      login: async (payload) => {
        const { data } = await api.post("/users/login", payload);
        setAuth({ token: data.token, user: data.user });
        return data;
      },
      register: async (payload) => {
        const { data } = await api.post("/users/register", payload);
        setAuth({ token: data.token, user: data.user });
        return data;
      },
      googleLogin: async (credential) => {
        const { data } = await api.post("/users/google", { credential });
        setAuth({ token: data.token, user: data.user });
        return data;
      },
      logout: () => setAuth({ token: null, user: null }),
    }),
    [auth]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
