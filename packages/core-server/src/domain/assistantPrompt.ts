import type { AssistantInput } from "@mathnotes/shared";

const modeInstructions: Record<AssistantInput["mode"], string> = {
  explain: "解释所选内容的含义、推导关系和关键记号，帮助读者看懂原笔记。",
  teach: "以教学方式分层讲解所选内容，指出前置概念、关键步骤和容易混淆之处。",
  summarize: "提炼所选内容的结构、主要结论和待确认事项，不补造原文没有的结论。"
};

export function buildAssistantPrompt(input: Pick<AssistantInput, "intent" | "mode" | "markdownContext" | "question">): string {
  const question = input.question?.trim();
  if (input.intent === "selection_edit") {
    return [
      "你是 MathNotes 的选区修改助手。用户将明确审阅差异后才可能应用你的候选。",
      "请根据用户指令，只改写标记的精确选区；利用整块上下文保持术语、数学记号和语气一致。",
      "",
      "规则：",
      "1. 只输出用于替换选区的 Markdown 正文，不输出解释、前后缀、代码围栏或差异标记。",
      "2. 不要复述未选中的上下文，也不要声称已经修改原笔记。",
      "3. 不确定内容继续保留 [看不清] 或 [不确定：...]，不得猜造公式或符号。",
      "4. 数学公式使用 $...$ 与 $$...$$；不要生成完整 LaTeX 文档。",
      question ? `5. 用户修改指令：${question}` : "5. 在不改变含义的前提下，提高选区的准确性与可读性。",
      "",
      "--- 块与选区上下文开始 ---",
      input.markdownContext,
      "--- 块与选区上下文结束 ---"
    ].join("\n");
  }
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
