import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

export function fakeChildProcess(result: {
  stdout: string;
  stderr: string;
  code: number;
  close?: boolean;
  onKill?: () => void;
  onStdinWrite?: (text: string) => void;
}): ChildProcessWithoutNullStreams {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  process.stdout = new EventEmitter() as ChildProcessWithoutNullStreams["stdout"];
  process.stderr = new EventEmitter() as ChildProcessWithoutNullStreams["stderr"];
  process.stdin = {
    write: (chunk: string | Buffer) => {
      result.onStdinWrite?.(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      return true;
    },
    end: () => undefined
  } as unknown as ChildProcessWithoutNullStreams["stdin"];
  process.kill = (() => {
    result.onKill?.();
    process.emit("close", 1);
    return true;
  }) as ChildProcessWithoutNullStreams["kill"];

  queueMicrotask(() => {
    process.stdout.emit("data", Buffer.from(result.stdout, "utf8"));
    process.stderr.emit("data", Buffer.from(result.stderr, "utf8"));
    if (result.close ?? true) {
      process.emit("close", result.code);
    }
  });

  return process;
}
