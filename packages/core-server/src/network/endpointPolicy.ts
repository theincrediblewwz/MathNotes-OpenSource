export type EndpointTransportKind = "tailnet" | "private_lan" | "link_local" | "unusable";

export type EndpointAddressCandidate = {
  label: string;
  address: string;
  internal: boolean;
};

export type EndpointAddressAssessment = {
  kind: EndpointTransportKind;
  score: number;
  usable: boolean;
  guidance?: string;
};

export type EndpointHostSelection = {
  host: string;
  kind: EndpointTransportKind;
  preferredHostApplied: boolean;
};

export function assessEndpointAddress(candidate: EndpointAddressCandidate): EndpointAddressAssessment {
  const octets = parseIpv4(candidate.address);
  if (!octets || candidate.internal || octets[0] === 127) {
    return unusable("仅本机可用");
  }
  if (isBenchmarkIpv4(octets)) {
    return unusable("VPN/测试网段，手机通常不可达");
  }
  if (isTailnetIpv4(candidate.address)) {
    return {
      kind: "tailnet",
      score: 1_000,
      usable: true,
      guidance: "Tailscale 远程入口；设备需加入同一 Tailnet"
    };
  }

  const normalizedLabel = candidate.label.toLowerCase();
  const virtual = /(meta|vpn|vethernet|hyper-v|wsl|virtual|vmware|vbox|docker|container|loopback)/i.test(normalizedLabel);
  const physical = /(wi-?fi|wlan|wireless|ethernet|以太网|无线|usb|rndis|mobile hotspot|本地连接)/i.test(normalizedLabel);

  if (isRfc1918Ipv4(octets)) {
    if (virtual) return unusable("虚拟网卡地址，手机通常不可达");
    const hotspot = candidate.address === "192.168.137.1";
    return {
      kind: "private_lan",
      score: 600 + (hotspot ? 100 : 0) + (physical ? 40 : 0),
      usable: true,
      guidance: hotspot ? "Windows 热点备用入口" : "热点、USB 或可信局域网备用入口"
    };
  }

  if (isLinkLocalIpv4(octets)) {
    return {
      kind: "link_local",
      score: 100,
      usable: true,
      guidance: "低置信地址；仅在设备确实可互访时使用"
    };
  }

  return unusable("非私有地址；HTTP 配对不开放到公网");
}

export function rankEndpointCandidates<T extends EndpointAddressCandidate>(candidates: readonly T[]): T[] {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: assessEndpointAddress(candidate).score }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}

export function chooseEndpointHost(
  candidates: readonly EndpointAddressCandidate[],
  preferredHost?: string
): EndpointHostSelection {
  const preferred = preferredHost
    ? candidates.find((candidate) => candidate.address === preferredHost && assessEndpointAddress(candidate).usable)
    : undefined;
  const selected = preferred ?? rankEndpointCandidates(candidates)
    .find((candidate) => assessEndpointAddress(candidate).usable);
  if (!selected) {
    return { host: "127.0.0.1", kind: "unusable", preferredHostApplied: false };
  }
  return {
    host: selected.address,
    kind: assessEndpointAddress(selected).kind,
    preferredHostApplied: selected === preferred
  };
}

export function isUsableEndpointCandidate(candidate: EndpointAddressCandidate): boolean {
  return assessEndpointAddress(candidate).usable;
}

export function isTailnetIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  return Boolean(octets && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
}

export function isSafePrivateEndpointHost(address: string): boolean {
  const octets = parseIpv4(address);
  return Boolean(
    octets &&
      octets[0] !== 127 &&
      !isBenchmarkIpv4(octets) &&
      (isTailnetIpv4(address) || isRfc1918Ipv4(octets) || isLinkLocalIpv4(octets))
  );
}

function unusable(guidance: string): EndpointAddressAssessment {
  return { kind: "unusable", score: -1_000, usable: false, guidance };
}

function isRfc1918Ipv4(octets: number[]): boolean {
  return octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

function isLinkLocalIpv4(octets: number[]): boolean {
  return octets[0] === 169 && octets[1] === 254;
}

function isBenchmarkIpv4(octets: number[]): boolean {
  return octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function parseIpv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet, index) =>
    Number.isInteger(octet) && octet >= 0 && octet <= 255 && parts[index] === String(octet)
  ) ? octets : undefined;
}
