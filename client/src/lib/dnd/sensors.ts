import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type KeyboardSensorOptions,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

export const DND_DRAG_HANDLE_ATTRIBUTE = "data-app-dnd-drag-handle";
export const DND_DRAG_HANDLE_SELECTOR = `[${DND_DRAG_HANDLE_ATTRIBUTE}]`;
export const DND_DRAGGABLE_ATTRIBUTE = "data-app-dnd-draggable";
export const DND_DRAGGABLE_SELECTOR = `[${DND_DRAGGABLE_ATTRIBUTE}]`;
export const DND_CONTAINER_ID_ATTRIBUTE = "data-app-dnd-container-id";
export const DND_SORTABLE_ID_ATTRIBUTE = "data-app-dnd-sortable-id";

export const DEFAULT_POINTER_ACTIVATION_DISTANCE = 8;

export type AppDndSensorOptions = {
  pointer?: PointerSensorOptions;
  keyboard?: KeyboardSensorOptions;
};

export const appDndHandleAttributes = {
  [DND_DRAG_HANDLE_ATTRIBUTE]: "",
} as const;

export const appDndDraggableAttributes = {
  [DND_DRAGGABLE_ATTRIBUTE]: "",
} as const;

export const shouldStartTimelinePan = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    [
      DND_DRAG_HANDLE_SELECTOR,
      DND_DRAGGABLE_SELECTOR,
      "button",
      "input",
      "textarea",
      "select",
      "a",
      '[role="button"]',
    ].join(", "),
  );
};

export function useAppDndSensors(options: AppDndSensorOptions = {}) {
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: DEFAULT_POINTER_ACTIVATION_DISTANCE,
    },
    ...options.pointer,
  });

  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
    ...options.keyboard,
  });

  return useSensors(pointerSensor, keyboardSensor);
}
