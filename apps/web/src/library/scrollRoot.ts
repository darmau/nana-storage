import { createContext, useContext } from "react";

/** 列表放在一个可滚动的面板里时，用它告诉网格该监听哪个元素的滚动；默认是整个窗口。 */
export const ScrollRootContext = createContext<HTMLElement | null>(null);
export const useScrollRoot = () => useContext(ScrollRootContext);
