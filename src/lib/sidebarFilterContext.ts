import { createContext, useContext } from "react";
import { inactiveSidebarFilter, type SidebarFilter } from "./sidebarFilter.ts";

export interface SidebarFilterView {
  filter: SidebarFilter;
  /** the roster of a PC (components/Sidebar.tsx) tells the filter the branch each of its rows says, so a query can find it */
  reportBranches(machineId: string, branches: ReadonlyMap<string, string>): void;
}

const SidebarFilterContext = createContext<SidebarFilterView>({ filter: inactiveSidebarFilter(), reportBranches: () => {} });
export const SidebarFilterProvider = SidebarFilterContext.Provider;
export const useSidebarFilter = (): SidebarFilterView => useContext(SidebarFilterContext);
