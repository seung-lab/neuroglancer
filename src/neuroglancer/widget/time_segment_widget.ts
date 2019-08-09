import flatpickr from 'flatpickr';
import minMaxTimePlugin from 'flatpickr/dist/plugins/minMaxTimePlugin';
import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {LockableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

require('flatpickr/dist/flatpickr.min.css');
// require('./time_segment_widget.css');

export class TimeSegmentWidget extends RefCounted {
  element = document.createElement('div');
  input = <HTMLInputElement>document.createElement('input');
  model: LockableValueInterface<string>;
  preValue: string;

  constructor(private displayState: SegmentationDisplayState) {
    super();
    this.model = displayState.timestamp;
    const {element, input, model} = this;
    const cancelButton = document.createElement('button');
    const nothingButton = document.createElement('button');
    nothingButton.textContent = '✔️';
    nothingButton.title =
        `Actually, this button doesn't do anything at all. Click anywhere to close the time select.`;
    this.preValue = '';
    element.classList.add('neuroglancer-time-widget');
    input.type = 'datetime-local';
    flatpickr(input, {
      enableTime: true,
      enableSeconds: true,
      'disable': [(date) => (date.valueOf() >= Date.now())],
      plugins: [minMaxTimePlugin({
        getTimeLimits: () => {
          const now = new Date();
          return {
            minTime: `00:00`,
            maxTime: `${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`
          };
        }
      })]
    });
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

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
