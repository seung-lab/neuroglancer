import { Network } from 'neuroglancer/network/net_widget';
import { Viewer } from 'neuroglancer/viewer';
import { NetworkOverlay } from 'neuroglancer/network/net_overlay';

export class NetworkSearch extends NetworkOverlay {
    constructor(public viewer: Viewer, public net: Network) {
      super(viewer, net);
      // let {content} = this;
    }
  }
