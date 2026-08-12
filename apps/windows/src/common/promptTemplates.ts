import { defaultFaithfulTranscriptionPromptContent } from "../core/faithfulTranscriptionPrompt";

export type PromptTemplate = {
  id: string;
  name: string;
  content: string;
  builtIn?: boolean;
  locked?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type PromptTemplateConfig = {
  activeTemplateId: string;
  templates: PromptTemplate[];
};

export const defaultMathPromptTemplate: PromptTemplate = {
  id: "math_faithful_v1",
  name: "数学忠实转写",
  content: defaultFaithfulTranscriptionPromptContent,
  builtIn: true,
  locked: true
};
