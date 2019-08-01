import {SegmentationDisplayState} from 'neuroglancer/segmentation_display_state/frontend';
import {StatusMessage} from 'neuroglancer/status';
import {LockableValueInterface} from 'neuroglancer/trackable_value';
import {RefCounted} from 'neuroglancer/util/disposable';
import {removeFromParent} from 'neuroglancer/util/dom';

// require('./time_segment_widget.css');

export class TimeSegmentWidget extends RefCounted {
  element = <HTMLInputElement>document.createElement('input');
  model: LockableValueInterface<string>;
  preValue: string;

  constructor(private displayState: SegmentationDisplayState) {
    super();
    this.model = displayState.timestamp;
    const {element, model} = this;
    this.preValue = '';
    element.classList.add('neuroglancer-time-widget');
    element.type = 'datetime-local';
    element.addEventListener('change', () => this.updateModel());
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
    this.element.value = this.dateFormat(this.model.value);
    if (this.element.value !== '' || this.preValue !== '') {
      this.displayState.rootSegments.clear();
      this.displayState.hiddenRootSegments!.clear();
    }
    this.preValue = this.element.value;
  }
  private updateModel() {
    this.model.restoreState(this.element.value);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
