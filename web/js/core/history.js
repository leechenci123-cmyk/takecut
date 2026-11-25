// Undo / redo over immutable edit snapshots.

export function createHistory(limit = 300) {
  let past = [], future = [];
  return {
    /** Remember `state` (the state before a change) and clear the redo stack. */
    record(state) {
      past.push(state);
      if (past.length > limit) past.shift();
      future = [];
    },
    /** Returns the state to restore, or null. `current` becomes redoable. */
    undo(current) {
      if (!past.length) return null;
      future.push(current);
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(current);
      return future.pop();
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    clear() { past = []; future = []; },
  };
}
