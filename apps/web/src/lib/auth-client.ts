"use client";

import { createAuthClient } from "better-auth/react";
import { BACKEND_URL } from "./backend";

export const authClient = createAuthClient({
  baseURL: BACKEND_URL,
});

export const { signUp, signIn, signOut, useSession } = authClient;
