import {SegmentationDisplayState} from '../segmentation_display_state/frontend';
import {RefCounted} from '../util/disposable';

require('./timestampRetrieval.css');

export class OmniSegmentWidget extends RefCounted {
  element = document.createElement('div');

  constructor(
      private displayState: SegmentationDisplayState, private segmentMetadata: SegmentMetadata) {
    super();
    this.element.className = 'timestamp-retrival-widget';
    this.makeSegmentTable();
    this.makeCategoryTable();
    this.makeSegmentEquivalenceTable();
  }

  private makeSegmentTable() {
    const {element} = this;

    const active '🕘';<input type="datetime-local"> 
  }
}
