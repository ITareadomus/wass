declare global {
  interface Window {
    openTimelineMapPanel?: () => void;
  }
}

export function registerTimelineMapPanelOpener(opener: () => void) {
  window.openTimelineMapPanel = opener;
}

export function unregisterTimelineMapPanelOpener() {
  delete window.openTimelineMapPanel;
}

export function openTimelineMapPanel() {
  window.openTimelineMapPanel?.();
}
