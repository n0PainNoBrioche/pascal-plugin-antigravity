export interface ViewerSelectionState {
  selectedIds: string[]
  levelId: string | null
}

export interface ViewerStoreState {
  selection: ViewerSelectionState
  setSelection: (selection: { selectedIds: string[]; zoneId?: null; levelId?: string | null }) => void
}

export interface UseViewerHook {
  <T>(selector: (state: ViewerStoreState) => T): T
  getState(): ViewerStoreState
}

export const useViewer: UseViewerHook
