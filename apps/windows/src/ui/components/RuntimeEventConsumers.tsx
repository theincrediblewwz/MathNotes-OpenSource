import { type ComponentProps, useMemo } from "react";
import { useRecognitionRuntimeEvents } from "../runtimeEventStore";
import { DetachedAssistantWorkspace } from "./AssistantWorkspace";
import { TaskPopover } from "./Popovers";

type TaskPopoverWithEventsProps = Omit<ComponentProps<typeof TaskPopover>, "events">;

export function TaskPopoverWithEvents(props: TaskPopoverWithEventsProps) {
  const events = useRecognitionRuntimeEvents(props.openLayer === "task");
  return <TaskPopover {...props} events={events} />;
}

type AssistantWorkspaceWithRuntimeProps = Omit<ComponentProps<typeof DetachedAssistantWorkspace>, "liveText"> & {
  runtimeTaskId: string | null;
};

export function AssistantWorkspaceWithRuntime({ runtimeTaskId, ...props }: AssistantWorkspaceWithRuntimeProps) {
  const events = useRecognitionRuntimeEvents(Boolean(runtimeTaskId));
  const liveText = useMemo(() => {
    if (!runtimeTaskId) return "";
    const taskEvents = events
      .filter((event) => event.recognitionJobId === runtimeTaskId)
      .reverse();
    const streamed = taskEvents.filter((event) => event.level === "stdout").map((event) => event.message).join("");
    return streamed || taskEvents.at(-1)?.message || "";
  }, [events, runtimeTaskId]);

  return <DetachedAssistantWorkspace {...props} liveText={liveText} />;
}
