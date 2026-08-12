export type OutputGuardReason = "repeated_token" | "repeated_line" | "low_diversity";

export type OutputGuardState = "healthy" | "suspicious" | "tripped";

export type StreamingOutputGuardOptions = {
  repeatedTokenWarningCount: number;
  repeatedTokenStopCount: number;
  repeatedLineWarningCount: number;
  repeatedLineStopCount: number;
  lowDiversityWarningTokens: number;
  lowDiversityStopTokens: number;
  lowDiversityUniqueRatio: number;
  analysisWindowChars: number;
};

export type StreamingOutputObservation = {
  state: OutputGuardState;
  reason?: OutputGuardReason;
  message?: string;
  text: string;
  safeText: string;
};

type OutputAnalysis = Pick<StreamingOutputObservation, "state" | "reason" | "message"> & {
  safePrefixEnd?: number;
};

const DEFAULT_OPTIONS: StreamingOutputGuardOptions = {
  repeatedTokenWarningCount: 16,
  repeatedTokenStopCount: 32,
  repeatedLineWarningCount: 4,
  repeatedLineStopCount: 8,
  lowDiversityWarningTokens: 96,
  lowDiversityStopTokens: 160,
  lowDiversityUniqueRatio: 0.08,
  analysisWindowChars: 32_000
};

const TOKEN_PATTERN = /\\[A-Za-z]+|[^\s]+/g;

function analyzeRepeatedToken(text: string, options: StreamingOutputGuardOptions): OutputAnalysis {
  const windowStart = Math.max(0, text.length - options.analysisWindowChars);
  const windowText = text.slice(windowStart);
  const matches = [...windowText.matchAll(TOKEN_PATTERN)];
  const last = matches.at(-1);
  if (!last) {
    return { state: "healthy" };
  }

  let repeatedCount = 1;
  let firstRepeatedIndex = last.index ?? 0;
  for (let index = matches.length - 2; index >= 0; index -= 1) {
    if (matches[index][0] !== last[0]) {
      break;
    }
    repeatedCount += 1;
    firstRepeatedIndex = matches[index].index ?? firstRepeatedIndex;
  }

  if (repeatedCount >= options.repeatedTokenStopCount) {
    return {
      state: "tripped",
      reason: "repeated_token",
      message: `检测到连续 ${repeatedCount} 个重复 token。`,
      safePrefixEnd: windowStart + firstRepeatedIndex
    };
  }
  if (repeatedCount >= options.repeatedTokenWarningCount) {
    return {
      state: "suspicious",
      reason: "repeated_token",
      message: `检测到连续 ${repeatedCount} 个重复 token。`,
      safePrefixEnd: windowStart + firstRepeatedIndex
    };
  }
  return { state: "healthy" };
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function isMeaningfulRepeatedLine(line: string): boolean {
  return line.length > 0 && !/^(?:\$\$|```|~~~|---+)$/.test(line);
}

function analyzeRepeatedLine(text: string, options: StreamingOutputGuardOptions): OutputAnalysis {
  const windowStart = Math.max(0, text.length - options.analysisWindowChars);
  const windowText = text.slice(windowStart);
  const lines: Array<{ normalized: string; start: number }> = [];
  let lineStart = 0;

  while (lineStart < windowText.length) {
    const newlineIndex = windowText.indexOf("\n", lineStart);
    if (newlineIndex < 0) {
      break;
    }
    const rawLine = windowText.slice(lineStart, newlineIndex).replace(/\r$/, "");
    const normalized = normalizeLine(rawLine);
    if (isMeaningfulRepeatedLine(normalized)) {
      lines.push({ normalized, start: windowStart + lineStart });
    }
    lineStart = newlineIndex + 1;
  }

  const last = lines.at(-1);
  if (!last) {
    return { state: "healthy" };
  }

  let repeatedCount = 1;
  let firstRepeatedStart = last.start;
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (lines[index].normalized !== last.normalized) {
      break;
    }
    repeatedCount += 1;
    firstRepeatedStart = lines[index].start;
  }

  if (repeatedCount >= options.repeatedLineStopCount) {
    return {
      state: "tripped",
      reason: "repeated_line",
      message: `检测到连续 ${repeatedCount} 行重复内容。`,
      safePrefixEnd: firstRepeatedStart
    };
  }
  if (repeatedCount >= options.repeatedLineWarningCount) {
    return {
      state: "suspicious",
      reason: "repeated_line",
      message: `检测到连续 ${repeatedCount} 行重复内容。`,
      safePrefixEnd: firstRepeatedStart
    };
  }
  return { state: "healthy" };
}

function analyzeLowDiversity(text: string, options: StreamingOutputGuardOptions): OutputAnalysis {
  const windowText = text.slice(Math.max(0, text.length - options.analysisWindowChars));
  const tokens = [...windowText.matchAll(TOKEN_PATTERN)].map((match) => match[0]);
  if (tokens.length === 0) {
    return { state: "healthy" };
  }

  const uniqueRatio = new Set(tokens).size / tokens.length;
  if (uniqueRatio > options.lowDiversityUniqueRatio) {
    return { state: "healthy" };
  }
  if (tokens.length >= options.lowDiversityStopTokens) {
    return {
      state: "tripped",
      reason: "low_diversity",
      message: `检测到 ${tokens.length} 个 token 的低多样性循环。`
    };
  }
  if (tokens.length >= options.lowDiversityWarningTokens) {
    return {
      state: "suspicious",
      reason: "low_diversity",
      message: `检测到 ${tokens.length} 个 token 的低多样性循环。`
    };
  }
  return { state: "healthy" };
}

function analyzeOutput(text: string, options: StreamingOutputGuardOptions): OutputAnalysis {
  const analyses = [
    analyzeRepeatedToken(text, options),
    analyzeRepeatedLine(text, options),
    analyzeLowDiversity(text, options)
  ];
  return (
    analyses.find((analysis) => analysis.state === "tripped") ??
    analyses.find((analysis) => analysis.state === "suspicious") ??
    { state: "healthy" }
  );
}

export class StreamingOutputGuard {
  private readonly options: StreamingOutputGuardOptions;
  private text = "";
  private safeText = "";

  constructor(options: Partial<StreamingOutputGuardOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  observe(delta: string): StreamingOutputObservation {
    this.text += delta;
    const analysis = analyzeOutput(this.text, this.options);

    if (analysis.state === "healthy") {
      this.safeText = this.text;
    } else if (analysis.safePrefixEnd !== undefined) {
      const safePrefix = this.text.slice(0, analysis.safePrefixEnd).trimEnd();
      if (safePrefix.length >= this.safeText.length) {
        this.safeText = safePrefix;
      }
    }

    return {
      state: analysis.state,
      reason: analysis.reason,
      message: analysis.message,
      text: this.text,
      safeText: this.safeText
    };
  }

  currentText(): string {
    return this.text;
  }

  lastHealthyText(): string {
    return this.safeText;
  }
}
