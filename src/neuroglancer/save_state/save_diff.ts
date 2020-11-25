import {diff_match_patch} from 'diff-match-patch';
import {Trackable} from 'neuroglancer/util/trackable';

const diff = new diff_match_patch();

export class SaveDiff {
  active = true;
  diffsInstances = 0;
  cursor = 0;
  max = 100;
  stack: string[] = [];
  stackDiff: string[] = [];

  constructor(public root: Trackable) {}
  public record(oldState: any, newState: any) {
    if (newState === undefined) {
      return false;
    }
    const oldSerial = JSON.stringify(oldState);
    const newSerial = JSON.stringify(newState);
    const stateChange = oldSerial !== newSerial;
    if (!this.active) {
      this.active = true;
      return stateChange;
    }
    if (stateChange) {
      if (this.cursor < this.stack.length) {
        this.stack.splice(this.cursor);
      }
      const patch = diff.patch_toText(diff.patch_make(oldSerial, newSerial));
      const diffs = diff.diff_main(oldSerial, newSerial);
      diff.diff_cleanupEfficiency(diffs);

      this.stack.push(patch);
      this.stackDiff.push(JSON.stringify(diffs));
      this.cursor = this.stack.length;
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
    if (this.cursor >= this.stack.length) {
      // at most recent state
      return;
    }
    this.cursor += rollback ? -1 : 1;
    const lastPatch = this.stack[this.cursor];
    const lastDiff = this.stackDiff[this.cursor];
    const currentState = this.root.toJSON();
    const restoreFromPatch = diff.patch_apply(diff.patch_fromText(lastPatch), currentState);
    const restoreFromDiff = diff.patch_apply(diff.patch_make(lastDiff, currentState), currentState);
    assert(
        restoreFromPatch[0] === restoreFromDiff[0],
        `restoreFromPatch does not equal restoreFromDiff`);
    /* deactivate so that state change triggered by updating
    the state w/ a rollback doesn't affect state history*/
    this.active = false;
    this.root.restoreState(JSON.parse(restoreFromPatch[0]));
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    alert(message);
    throw message;
  }
}
