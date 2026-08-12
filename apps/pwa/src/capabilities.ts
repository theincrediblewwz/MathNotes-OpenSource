export type CapabilityStatus = "available" | "unavailable" | "requires-permission";

export type PwaCapabilityReport = Readonly<{
  schemaVersion: 1;
  capturedAt: string;
  standalone: boolean;
  online: boolean;
  serviceWorker: CapabilityStatus;
  indexedDb: CapabilityStatus;
  persistentStorage: CapabilityStatus;
  camera: CapabilityStatus;
  cameraZoom: CapabilityStatus;
  share: CapabilityStatus;
  push: CapabilityStatus;
  badge: CapabilityStatus;
}>;

export type CapabilitySource = Readonly<{
  now(): Date;
  online: boolean;
  standalone: boolean;
  serviceWorker: boolean;
  indexedDb: boolean;
  storagePersist: boolean;
  camera: boolean;
  cameraZoomConstraint: boolean;
  share: boolean;
  push: boolean;
  badge: boolean;
}>;

export function readPwaCapabilities(source: CapabilitySource = browserCapabilitySource()): PwaCapabilityReport {
  return {
    schemaVersion: 1,
    capturedAt: source.now().toISOString(),
    standalone: source.standalone,
    online: source.online,
    serviceWorker: status(source.serviceWorker),
    indexedDb: status(source.indexedDb),
    persistentStorage: status(source.storagePersist),
    camera: source.camera ? "requires-permission" : "unavailable",
    cameraZoom: source.cameraZoomConstraint ? "requires-permission" : "unavailable",
    share: status(source.share),
    push: source.push ? "requires-permission" : "unavailable",
    badge: status(source.badge)
  };
}

export function browserCapabilitySource(): CapabilitySource {
  const supportedConstraints = navigator.mediaDevices?.getSupportedConstraints?.() as MediaTrackSupportedConstraints & { zoom?: boolean } | undefined;
  return {
    now: () => new Date(),
    online: navigator.onLine,
    standalone: window.matchMedia("(display-mode: standalone)").matches
      || ("standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true),
    serviceWorker: "serviceWorker" in navigator,
    indexedDb: "indexedDB" in window,
    storagePersist: typeof navigator.storage?.persist === "function",
    camera: typeof navigator.mediaDevices?.getUserMedia === "function",
    cameraZoomConstraint: supportedConstraints?.zoom === true,
    share: typeof navigator.share === "function",
    push: "PushManager" in window && "Notification" in window,
    badge: typeof (navigator as Navigator & { setAppBadge?: (contents?: number) => Promise<void> }).setAppBadge === "function"
  };
}

function status(available: boolean): CapabilityStatus {
  return available ? "available" : "unavailable";
}
