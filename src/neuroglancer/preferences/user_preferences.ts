import {Overlay} from 'neuroglancer/overlay';
import {Viewer} from 'neuroglancer/viewer';
import {TrackableBoolean, TrackableBooleanCheckbox} from 'neuroglancer/trackable_boolean';
import {TrackableValue} from 'neuroglancer/trackable_value';
import {NumberInputWidget} from 'neuroglancer/widget/number_input_widget';

require('./user_preferences.css');

export class UserPreferencesDialog extends Overlay {
  constructor(public viewer: Viewer) {
    super();

    let {content} = this;
    content.classList.add('user-preferences');

    let scroll = document.createElement('div');
    scroll.classList.add('user-preferences-container');

    content.appendChild(scroll);

    let header = document.createElement('h2');
    header.textContent = 'Preferences';
    scroll.appendChild(header);

    const addLimitWidget = (label: string, limit: TrackableValue<number>) => {
      const widget = this.registerDisposer(new NumberInputWidget(limit, {label}));
      widget.element.classList.add('user-preferences-limit-widget');
      scroll.appendChild(widget.element);
      scroll.appendChild(document.createElement('br'));
    };
    addLimitWidget('GPU memory limit', viewer.chunkQueueManager.capacities.gpuMemory.sizeLimit);
    addLimitWidget('System memory limit', viewer.chunkQueueManager.capacities.systemMemory.sizeLimit);
    addLimitWidget(
        'Concurrent chunk requests', viewer.chunkQueueManager.capacities.download.itemLimit);

    const addCheckbox = (label: string, value: TrackableBoolean) => {
      const labelElement = document.createElement('label');
      labelElement.textContent = label;
      const checkbox = this.registerDisposer(new TrackableBooleanCheckbox(value));
      labelElement.appendChild(checkbox.element);
      scroll.appendChild(labelElement);
    };

    addCheckbox('Test checkbox', viewer.showAxisLines);
  }
}

