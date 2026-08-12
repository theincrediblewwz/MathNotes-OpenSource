import type { AssistantInput } from "@mathnotes/shared";

const modeInstructions: Record<AssistantInput["mode"], string> = {
  explain: "解释所选内容的含义、推导关系和关键记号，帮助读者看懂原笔记。",
  teach: "以教学方式分层讲解所选内容，指出前置概念、关键步骤和容易混淆之处。",
  summarize: "提炼所选内容的结构、主要结论和待确认事项，不补造原文没有的结论。"
};

export function buildAssistantPrompt(input: Pick<AssistantInput, "mode" | "markdownContext" | "question">): string {
  const question = input.question?.trim();
  return [
    "你是 MathNotes 的独立学习助手。下面内容来自用户已经保存的数学笔记快照。",
    modeInstructions[input.mode],
    "",
    "规则：",
    "1. 原笔记是只读证据；不要声称修改、纠正或覆盖原笔记。",
    "2. 明确区分原笔记中已有内容与根据上下文作出的解释；信息不足时写明无法确定。",
    "3. 遇到 [看不清]、[不确定：...] 或 [图片：...] 时保留不确定性；如附有原图，可据图解释，但不要伪造看不清的符号。",
    "4. 数学公式使用 Markdown 常见的 $...$ 与 $$...$$，不要生成完整 LaTeX 文档。",
    "5. 只输出独立学习旁注的 Markdown 正文，不输出系统说明或代码围栏；除非用户之后明确转为笔记块，否则它不会进入原笔记。",
    question ? `6. 用户问题：${question}` : "",
    "",
    "--- 笔记快照开始 ---",
    input.markdownContext.trim(),
    "--- 笔记快照结束 ---"
  ]
    .filter(Boolean)
    .join("\n");
}
