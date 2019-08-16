import flatpickr from 'flatpickr';
import minMaxTimePlugin from 'flatpickr/dist/plugins/minMaxTimePlugin';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {LockableValueInterface, TrackableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';
import {SegmentationUserLayerWithGraph} from '../segmentation_user_layer_with_graph';

require('flatpickr/dist/flatpickr.min.css');
// require('./time_segment_widget.css');

export class TimeSegmentWidget extends RefCounted {
  element = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  limit: TrackableValueInterface<string>;
  model: LockableValueInterface<string>;
  preValue: string;

  constructor(
      // timestamp: LockableValue<string>, tsLimit: TrackableValue<string>,
      s: SegmentationUserLayerWithGraph, private displayState: SegmentationDisplayState) {
    super();
    this.model = s.timestamp;
    this.limit = s.timestampLimit;
    const {element, input, model} = this;
    const cancelButton = document.createElement('button');
    const nothingButton = document.createElement('button');
    nothingButton.textContent = '✔️';
    nothingButton.title =
        `Actually, this button doesn't do anything at all. Click anywhere to close the time select.`;
    this.preValue = '';
    element.classList.add('neuroglancer-time-widget');
    input.type = 'datetime-local';
    this.buildFlatpickr(input);
    this.limit.changed.add(() => this.buildFlatpickr(input));
    input.addEventListener('change', () => this.updateModel());
    cancelButton.textContent = '❌';
    cancelButton.title = 'Reset Time';
    cancelButton.addEventListener('click', () => {
      this.model.value = '';
    });
    element.appendChild(input);
    element.appendChild(nothingButton);
    element.appendChild(cancelButton);
    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.updateView();
  }
  private dateFormat(value: string) {
    if (value === '') {
      return '';
    }
    return ((new Date(parseInt(value, 10) * 1000)).toISOString()).slice(0, -1);
  }
  private updateView() {
    if (this.model.lock && this.model.value !== '') {
      this.model.value = '';
      StatusMessage.showTemporaryMessage(
          'Cannot view an older segmentation while Merge/Split mode is active.');
    }
    this.input.value = this.dateFormat(this.model.value);
    if (this.input.value !== '' || this.preValue !== '') {
      this.displayState.rootSegments.clear();
      this.displayState.hiddenRootSegments!.clear();
    }
    this.preValue = this.input.value;
  }
  private updateModel() {
    this.model.restoreState(this.input.value);
  }
  private buildFlatpickr(ele: HTMLInputElement) {
    return flatpickr(ele, {
      enableTime: true,
      enableSeconds: true,
      'disable': [(date) => {
        const target = date.valueOf();
        const future = Date.now();
        // note: this is fine b/c we are dealing with epoch time (date sheNaNigans are irrelevant
        // here)
        const past = parseInt(this.limit.value || '0', 10) - (24 * 60 * 60 * 1000);

        if (past) {
          return past > target || target >= future;
        } else {
          return target >= future;
        }
      }],
      plugins: [minMaxTimePlugin({
        getTimeLimits: (date) => {
          const now = new Date();
          const past = new Date(parseInt(this.limit.value || '0', 10));
          let minmax = {minTime: `00:00:00`, maxTime: `23:59:59`};

          if (date.toDateString() === now.toDateString()) {
            minmax.maxTime = `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`;
          } else if (date.toDateString() === past.toDateString()) {
            // Flatpickr does not support millisecond res, must round up to nearest second
            // TODO: Seconds fixed has been merged in, remove + 1 to minutes when flatpickr is
            // updated
            minmax.minTime = `${past.getHours()}:${(past.getMinutes() + 1) % 60}:${
                (past.getSeconds() + 1) % 60}`;
          }
          return minmax;
        }
      })]
    });
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
