export type SessionStatus = "draft" | "reviewed" | "archived";
export type BlockType = "pdf" | "image" | "markdown";
export type BlockSource =
  | "pdf_import"
  | "android_camera"
  | "ai_transcription"
  | "ai_explanation"
  | "user"
  | "user_revision"
  | "mixed";

export type BlockStatus = "draft" | "reviewed" | "locked" | "error";

export type BlockRef = {
  id: string;
  type: BlockType;
  path: string;
  source: BlockSource;
  status: BlockStatus;
  readonly: boolean;
  editableByAi: boolean;
  fromAssets?: string[];
  sourceName?: string;
  pageCount?: number;
  sourcePageNumber?: number;
  sourcePageImagePath?: string;
  renderInNote?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LockMeta = {
  id: string;
  blockId: string;
  kind: "block" | "span";
  contentHash: string;
  createdAt: string;
  createdBy: "user";
  aiEditable: false;
};

export type SessionRecord = {
  id: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  blocks: BlockRef[];
  locks: LockMeta[];
  currentDraftPolicy: "append_only";
  exportPolicy: {
    includeMetadataComments: boolean;
    includeImageLinks: boolean;
  };
};

export type CreateSessionInput = {
  id: string;
  title: string;
  createdAt: string;
};

export type CreateBlockInput = {
  id: string;
  type: BlockType;
  path: string;
  source: BlockSource;
  createdAt: string;
  fromAssets?: string[];
  sourceName?: string;
  pageCount?: number;
  sourcePageNumber?: number;
  sourcePageImagePath?: string;
  renderInNote?: boolean;
};

export type RecognitionInput = {
  imagePaths: string[];
  mode: "faithful";
  outputFormat: "markdown";
  context?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
};

export type RecognitionResult = {
  markdown: string;
  warnings?: string[];
  rawResponse?: string;
};

export type RecognitionProviderEvent =
  | {
      type: "started";
      message: string;
    }
  | {
      type: "stdout";
      text: string;
    }
  | {
      type: "stderr";
      text: string;
    }
  | {
      type: "completed";
      message: string;
    };

export type RecognitionProvider = {
  name: string;
  transcribe(input: RecognitionInput): Promise<RecognitionResult>;
  transcribeWithEvents?(input: RecognitionInput & { onEvent: (event: RecognitionProviderEvent) => void }): Promise<RecognitionResult>;
};

export type AssistantMode = "explain" | "teach" | "summarize";

export type AssistantInput = {
  mode: AssistantMode;
  markdownContext: string;
  imagePaths: string[];
  question?: string;
  sessionId?: string;
  abortSignal?: AbortSignal;
};

export type AssistantResult = RecognitionResult;
export type AssistantProviderEvent = RecognitionProviderEvent;

export type AssistantProvider = {
  name: string;
  assist(input: AssistantInput): Promise<AssistantResult>;
  assistWithEvents?(
    input: AssistantInput & { onEvent: (event: AssistantProviderEvent) => void }
  ): Promise<AssistantResult>;
};

export function createSessionRecord(input: CreateSessionInput): SessionRecord {
  return {
    id: input.id,
    title: input.title,
    status: "draft",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    blocks: [],
    locks: [],
    currentDraftPolicy: "append_only",
    exportPolicy: {
      includeMetadataComments: true,
      includeImageLinks: true
    }
  };
}

export function createBlockRef(input: CreateBlockInput): BlockRef {
  return {
    id: input.id,
    type: input.type,
    path: input.path,
    source: input.source,
    status: "draft",
    readonly: input.type === "pdf",
    editableByAi: input.source === "ai_transcription",
    fromAssets: input.fromAssets,
    sourceName: input.sourceName,
    pageCount: input.pageCount,
    sourcePageNumber: input.sourcePageNumber,
    sourcePageImagePath: input.sourcePageImagePath,
    renderInNote: input.renderInNote,
    createdAt: input.createdAt,
    updatedAt: input.createdAt
  };
}
