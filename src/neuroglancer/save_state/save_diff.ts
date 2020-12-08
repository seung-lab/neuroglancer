import {diff_match_patch} from 'diff-match-patch';
import {Trackable} from 'neuroglancer/util/trackable';

const diff = new diff_match_patch();

export class SaveDiff {
  saveRedo = false;
  applyRedo = false;
  max = 100;
  stack: string[] = [];
  reverseStack: string[] = [];

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
      if (this.reverseStack.length && !this.saveRedo && !this.applyRedo) {
        // do not clear reverse stack if applied redo or undo
        this.reverseStack = [];
      }
      if (this.saveRedo) {
        this.saveRedo = false;
        this.reverseStack.push(patch);
      } else {
        this.stack.push(patch);
      }
      if (this.applyRedo) {
        this.applyRedo = false;
      }
    }
    this.setRollStatus();
    return stateChange;
  }
  public rollback() {
    this.apply();
  }
  public rollforward() {
    this.apply(false);
  }
  private setRollStatus() {
    const undo = document.getElementById('neuroglancer-undo-button');
    const redo = document.getElementById('neuroglancer-redo-button');
    this.modifyStatus(undo, !!this.stack.length, '⬅️', '⇦');
    this.modifyStatus(redo, !!this.reverseStack.length, '➡️', '⇨');
  }
  private modifyStatus(
      element: HTMLElement|null, status: boolean, enabled: string, disabled: string) {
    if (!element) {
      return;
    }
    element.classList.toggle('disabled', status);
    element.innerText = status ? enabled : disabled;
  }
  private apply(rollback = true) {
    const target = rollback ? this.stack : this.reverseStack;
    const lastPatch = target.pop();
    if (!lastPatch) {
      // Cancel apply if no patch to apply
      return;
    }
    if (rollback) {
      // Tell save diff that next state change is a rollback/undo
      // save it in the reverse stack
      this.saveRedo = true;
    } else {
      this.applyRedo = true;
    }
    const currentState = JSON.stringify(this.root.toJSON());
    const patchfromText = diff.patch_fromText(lastPatch);
    const restoreFromPatch = diff.patch_apply(patchfromText, currentState);
    /* deactivate so that state change triggered by updating
    the state w/ a rollback doesn't affect state history*/
    this.root.restoreState(JSON.parse(restoreFromPatch[0]));
  }
}
