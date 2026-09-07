// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { reconnectingStream } from "./App";
import type { CompanionApiClient } from "./apiClient";
it("waits after clean stream EOF and cancels the wait when leaving the reader", async()=>{
  vi.useFakeTimers();
  try {
    const controller=new AbortController(),stream=vi.fn(async()=>{});
    const pending=reconnectingStream({api:{stream} as unknown as CompanionApiClient,path:"/events",token:"test",signal:controller.signal,onMessage(){},onConnection(){},onAuthorizationLost(){}});
    await vi.advanceTimersByTimeAsync(999);expect(stream).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(stream).toHaveBeenCalledTimes(2);
    controller.abort();await pending;
    await vi.advanceTimersByTimeAsync(10000);expect(stream).toHaveBeenCalledTimes(2);
  } finally {vi.useRealTimers();}
});
