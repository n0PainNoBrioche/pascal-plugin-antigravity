export interface ViewerSelectionState {
  selectedIds: string[]
  levelId: string | null
}

export interface ViewerStoreState {
  selection: ViewerSelectionState
}

export interface UseViewerHook {
  <T>(selector: (state: ViewerStoreState) => T): T
  getState(): ViewerStoreState
}

export const useViewer: UseViewerHook
