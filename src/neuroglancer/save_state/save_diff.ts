import {diff_match_patch} from 'diff-match-patch';
import {Trackable} from 'neuroglancer/util/trackable';

const diff = new diff_match_patch();

export class SaveDiff {
  diffsInstances = 0;
  cursor = 0;
  max = 100;
  stack: string[] = [];

  constructor(public root: Trackable) {}
  public record(oldState: any, newState: any) {
    if (newState === undefined) {
      return true;
    }
    const oldSerial = JSON.stringify(oldState);
    const newSerial = JSON.stringify(newState);
    const stateChange = oldSerial !== newSerial;

    if (stateChange) {
      const patch = diff.patch_toText(diff.patch_make(oldSerial, newSerial));
      if (this.cursor < this.stack.length - 1) {
        this.stack[this.cursor] = patch;
      } else {
        this.cursor = this.stack.push(patch);
      }
      // this.cursor++;
    }
    return stateChange;
  }
  public rollback() {
    this.apply();
  }
  public rollforward() {
    this.apply(false);
  }
  private apply(rollback = true) {
    if (this.cursor + (rollback ? -1 : 1) >= this.stack.length) {
      // at most recent state
      return;
    }
    this.cursor += rollback ? -1 : 1;
    const lastPatch = this.stack[this.cursor];
    const currentState = JSON.stringify(this.root.toJSON());
    const patchfromText = diff.patch_fromText(lastPatch);
    const restoreFromPatch = diff.patch_apply(patchfromText, currentState);
    /* deactivate so that state change triggered by updating
    the state w/ a rollback doesn't affect state history*/
    this.root.restoreState(JSON.parse(restoreFromPatch[0]));
  }
}
