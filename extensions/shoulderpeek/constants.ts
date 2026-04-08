export const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
export const DELTA_ARGS_BASE = ["--paging=never", "--line-numbers"];

export const MIN_LEFT_WIDTH = 26;
export const MAX_LEFT_WIDTH = 48;
export const HEADER_LINES = 2;
export const FOOTER_LINES = 2;
export const PANE_HEADER_LINES = 1;
export const MIN_DIFF_WIDTH = 24;
export const PAGE_SCROLL_RATIO = 0.15;
