export function reviewShortcut(event) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || event.isComposing || event.defaultPrevented) return null;
  if (event.target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]')) return null;
  return {ArrowLeft:'previous',ArrowRight:'next',v:'toggle',V:'toggle'}[event.key] || null;
}
