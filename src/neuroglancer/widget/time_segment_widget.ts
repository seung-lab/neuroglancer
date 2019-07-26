import {TrackableValueInterface} from '../trackable_value';
import {RefCounted} from '../util/disposable';
import { removeFromParent } from '../util/dom';

// require('./time_segment_widget.css');

export class TimeSegmentWidget extends RefCounted {
  element = document.createElement('input');

  constructor(public model: TrackableValueInterface<string>) {
    super();
    const {element} = this;
    element.classList.add('neuroglancer-time-widget');
    element.type = 'datetime-local';
    element.addEventListener('change', () => this.updateModel());
    this.registerDisposer(model.changed.add(() => this.updateView()));
    this.updateView();
  }
  private updateView() {
    this.element.value = this.model.toString();
  }
  private updateModel() {
    this.model.restoreState(this.element.value);
  }

  disposed() {
    removeFromParent(this.element);
    super.disposed();
  }
}
}
