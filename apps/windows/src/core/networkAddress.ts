import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import {
  assessEndpointAddress,
  chooseEndpointHost,
  isUsableEndpointCandidate,
  rankEndpointCandidates,
  type EndpointTransportKind
} from "@mathnotes/core-server";

export type NetworkAddressCandidate = {
  label: string;
  address: string;
  internal: boolean;
  usable?: boolean;
  recommended?: boolean;
  guidance?: string;
  transportKind?: EndpointTransportKind;
};

export function listIPv4AddressCandidates(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): NetworkAddressCandidate[] {
  const candidates: NetworkAddressCandidate[] = [];

  for (const [label, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4") continue;
      const assessment = assessEndpointAddress({ label, address: entry.address, internal: entry.internal });
      candidates.push({
        label,
        address: entry.address,
        internal: entry.internal,
        usable: assessment.usable,
        recommended: false,
        guidance: assessment.guidance,
        transportKind: assessment.kind
      });
    }
  }

  const ranked = rankEndpointCandidates(candidates);
  const preferred = ranked.find(isUsableIngestHost);
  if (preferred) preferred.recommended = true;
  return ranked;
}

export function choosePreferredIngestHost(
  candidates: NetworkAddressCandidate[],
  preferredHost?: string
): string {
  return chooseEndpointHost(candidates, preferredHost).host;
}

export function chooseRefreshedIngestHost(
  candidates: NetworkAddressCandidate[],
  _currentHost?: string,
  preferredHost?: string
): string {
  return chooseEndpointHost(candidates, preferredHost).host;
}

export function isUsableIngestHost(candidate: NetworkAddressCandidate): boolean {
  return isUsableEndpointCandidate(candidate);
}
