import {
  exportSessionMarkdown as exportCoreSessionMarkdown,
  type ExportSessionMarkdownArgs,
  type ExportSessionMarkdownResult
} from "@mathnotes/core-server";
import { BlockStore } from "./blockStore";
export type { ExportSessionMarkdownArgs, ExportSessionMarkdownResult };
export function exportSessionMarkdown(args: ExportSessionMarkdownArgs): Promise<ExportSessionMarkdownResult> {
  return new BlockStore(args.rootDir).getWriteCoordinator().run(args.notebookId, args.sessionId,
    () => exportCoreSessionMarkdown(args));
}
export { normalizeMathForPortableMarkdown } from "../common/markdownMath";
