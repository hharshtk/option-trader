// Writes every log line to data/engine/logs/<IST date>.jsonl, so nothing depends on a browser
// being open. Starts a new file when the IST date changes.

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { LogEntry } from "../../lib/engine/protocol.ts";
import type { LogSink } from "./logger.ts";

export interface LogFile {
  sink: LogSink;
  close(): Promise<void>;
}

export function createLogFile(directory: string, istDate: (time: number) => string): LogFile {
  mkdirSync(directory, { recursive: true });
  let date = "";
  let stream: WriteStream | undefined;

  function streamFor(entry: LogEntry) {
    const today = istDate(entry.at);
    if (today !== date || !stream) {
      stream?.end();
      date = today;
      stream = createWriteStream(path.join(directory, `${today}.jsonl`), { flags: "a" });
    }
    return stream;
  }

  return {
    sink(entry) {
      streamFor(entry).write(`${JSON.stringify(entry)}\n`);
    },
    close() {
      return new Promise((resolve) => {
        if (!stream) return resolve();
        stream.end(() => resolve());
      });
    },
  };
}
