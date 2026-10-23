/** Whether the screen's main pointer is a finger (a coarse pointer): a phone or a tablet, with no mouse or trackpad. */
export const isTouchScreen = (): boolean => window.matchMedia("(pointer: coarse)").matches;
