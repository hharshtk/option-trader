import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Single-user auth: credentials come from USER_NAME / USER_PASSWORD in .env.local.
// The session cookie is "<expiresAtMs>.<hmac>", signed with a key derived from those
// credentials, so changing USER_PASSWORD signs out every existing session.

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // seconds

interface UserCredentials {
  username: string;
  password: string;
}

function getUserCredentials(): UserCredentials | null {
  const username = process.env.USER_NAME;
  const password = process.env.USER_PASSWORD;
  return username && password ? { username, password } : null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest();
}

// Hashing first gives equal-length buffers, which timingSafeEqual requires.
function safeEqual(a: string, b: string) {
  return timingSafeEqual(sha256(a), sha256(b));
}

function sign(payload: string, user: UserCredentials) {
  const key = sha256(`session\0${user.username}\0${user.password}`);
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function credentialsConfigured() {
  return getUserCredentials() !== null;
}

export function checkCredentials(username: string, password: string) {
  const user = getUserCredentials();
  if (!user) return false;
  // Compare both so a wrong username takes as long as a wrong password.
  const usernameOk = safeEqual(username, user.username);
  const passwordOk = safeEqual(password, user.password);
  return usernameOk && passwordOk;
}

export function createSessionToken() {
  const user = getUserCredentials();
  if (!user) throw new Error("USER_NAME and USER_PASSWORD must be set in .env.local");
  const expiresAt = String(Date.now() + SESSION_MAX_AGE * 1000);
  return `${expiresAt}.${sign(expiresAt, user)}`;
}

export function isValidSessionToken(token: string | undefined) {
  const user = getUserCredentials();
  if (!user || !token) return false;
  const [expiresAt, signature] = token.split(".");
  if (!signature || !(Number(expiresAt) > Date.now())) return false;
  return safeEqual(signature, sign(expiresAt, user));
}

export async function isSignedIn() {
  return isValidSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}
