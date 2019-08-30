import {NetworkOverlay} from 'neuroglancer/network/net_overlay';
import {Network} from 'neuroglancer/network/net_widget';
import {Viewer} from 'neuroglancer/viewer';

export class NetworkSearch extends NetworkOverlay {
  constructor(public viewer: Viewer, public net: Network) {
    super(viewer, net);
    // let {content} = this;
  }
}
