// One engine at a time: a second one would open more Dhan sockets (5 per account, shared with
// everything using it) and double the REST rate.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export class EngineLockedError extends Error {
  name = "EngineLockedError";
}

/** Takes the lock file, replacing it if the process that held it is gone. Returns a release function. */
export function acquireLock(file: string, pid = process.pid): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, `${pid}\n`, { flag: "wx" });
      return () => {
        // Only remove our own lock.
        if (readPid(file) === pid) rmSync(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readPid(file);
      if (holder !== null && holder !== pid && isAlive(holder)) {
        throw new EngineLockedError(`The engine is already running (pid ${holder}). Lock file: ${file}`);
      }
      rmSync(file, { force: true });
    }
  }
  throw new EngineLockedError(`Could not take the lock file ${file}`);
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
