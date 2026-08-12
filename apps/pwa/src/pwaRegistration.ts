import { registerSW } from "virtual:pwa-register";

export type PwaUpdateState = Readonly<{
  offlineReady: boolean;
  updateReady: boolean;
  registrationError?: string;
}>;

export function registerMathNotesPwa(onState: (state: PwaUpdateState) => void): () => Promise<void> {
  let state: PwaUpdateState = { offlineReady: false, updateReady: false };
  const update = (patch: Partial<PwaUpdateState>) => {
    state = { ...state, ...patch };
    onState(state);
  };
  const applyUpdate = registerSW({
    immediate: true,
    onOfflineReady: () => update({ offlineReady: true }),
    onNeedRefresh: () => {
      update({ updateReady: true });
      void applyUpdate(true);
    },
    onRegisterError: (error) => update({ registrationError: error instanceof Error ? error.message : String(error) })
  });
  return () => applyUpdate(true);
}
