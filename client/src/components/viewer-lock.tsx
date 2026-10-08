import { useEffect } from "react";
import { useLocation } from "wouter";
import { getStoredUserRole, isViewerRole } from "@/lib/auth-role";

const CONTROL_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "[role='button']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='slider']",
].join(", ");

function isDismissControl(control: Element): boolean {
  const label = (control.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (label === "annulla" || label === "chiudi") return true;
  const aria = (control.getAttribute("aria-label") || "").toLowerCase();
  return aria.includes("chiudi") || aria.includes("close");
}

function viewerAllowsInteraction(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target.closest("[data-viewer-allow], [data-dnd-task-card-surface='true'], .rdp")) return true;

  const control = target.closest(CONTROL_SELECTOR);
  if (!control) return true;
  if (control.closest("[data-viewer-allow]")) return true;
  if (isDismissControl(control)) return true;

  if (control instanceof HTMLInputElement) {
    if (control.readOnly) return true;
    const testId = control.getAttribute("data-testid") || "";
    if (testId.startsWith("input-search")) return true;
  }
  if (control instanceof HTMLTextAreaElement && control.readOnly) return true;

  return false;
}

function blockViewerMutation(event: Event) {
  if (document.documentElement.dataset.viewer !== "1") return;
  if (viewerAllowsInteraction(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

/** Tiene il ruolo viewer in sola lettura: i controlli di modifica non partono. */
export function ViewerLock() {
  const [location] = useLocation();
  const viewer = isViewerRole(getStoredUserRole());

  useEffect(() => {
    const root = document.documentElement;
    if (viewer) root.dataset.viewer = "1";
    else delete root.dataset.viewer;

    if (!viewer) return;

    document.addEventListener("pointerdown", blockViewerMutation, true);
    document.addEventListener("click", blockViewerMutation, true);
    document.addEventListener("keydown", blockViewerMutation, true);
    return () => {
      document.removeEventListener("pointerdown", blockViewerMutation, true);
      document.removeEventListener("click", blockViewerMutation, true);
      document.removeEventListener("keydown", blockViewerMutation, true);
    };
  }, [viewer, location]);

  return null;
}
