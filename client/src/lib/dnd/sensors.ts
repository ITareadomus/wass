import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type KeyboardSensorOptions,
  type PointerSensorOptions,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { FIRST_APT_TIME_SHIFT_ATTRIBUTE, isPointOnFirstAptTimeShift } from "@/lib/first-apartment-time-shift";

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

export const shouldStartTimelinePan = (
  target: EventTarget | null,
  point?: { x: number; y: number },
) => {
  if (point && isPointOnFirstAptTimeShift(point.x, point.y)) return false;
  if (!(target instanceof Element)) return false;
  return !target.closest(
    [
      DND_DRAG_HANDLE_SELECTOR,
      DND_DRAGGABLE_SELECTOR,
      `[${FIRST_APT_TIME_SHIFT_ATTRIBUTE}]`,
      "button",
      "input",
      "textarea",
      "select",
      "a",
      '[role="button"]',
      '[role="slider"]',
    ].join(", "),
  );
};

const isFirstAptTimeShiftTarget = (event: Event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(`[${FIRST_APT_TIME_SHIFT_ATTRIBUTE}]`)) {
    return true;
  }
  if (event instanceof PointerEvent) {
    return isPointOnFirstAptTimeShift(event.clientX, event.clientY);
  }
  return false;
};

class AppPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        { nativeEvent: event }: { nativeEvent: PointerEvent },
        { onActivation }: PointerSensorOptions,
      ) => {
        if (!event.isPrimary || event.button !== 0) return false;
        if (isFirstAptTimeShiftTarget(event)) return false;
        onActivation?.({ event });
        return true;
      },
    },
  ];
}

export function useAppDndSensors(options: AppDndSensorOptions = {}) {
  const pointerSensor = useSensor(AppPointerSensor, {
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
