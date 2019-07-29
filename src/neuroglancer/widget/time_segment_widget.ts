import {TrackableValueInterface} from '../trackable_value';
import {RefCounted} from '../util/disposable';
import {removeFromParent} from '../util/dom';

// require('./time_segment_widget.css');

export class TimeSegmentWidget extends RefCounted {
  element = <HTMLInputElement>document.createElement('input');

  constructor(public model: TrackableValueInterface<string>) {
    super();
    const {element} = this;
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
    this.element.value = this.dateFormat(this.model.value);
  }
  private updateModel() {
    this.model.restoreState(this.element.value);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
